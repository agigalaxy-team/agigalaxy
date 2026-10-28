package messaging

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"regexp"
	"strings"
	"time"
)

var smtpFields = []string{"enabled", "host", "port", "tls", "credentialRef", "connectionTimeoutMs", "greetingTimeoutMs", "socketTimeoutMs", "maxConnections", "rateLimit", "rateWindowSeconds", "dkimSelector"}

func normalizeSMTP(input any) (Object, error) {
	x := obj(clone(input))
	if x == nil || !keys(x, smtpFields...) || !required(x, smtpFields...) {
		return nil, failure("invalid_smtp_request", 400)
	}
	enabled, ok := x["enabled"].(bool)
	if !ok {
		return nil, failure("invalid_smtp_request", 400)
	}
	if x["host"] != nil {
		host, ok := x["host"].(string)
		host = cases.Lower(language.Und).String(strings.TrimFunc(host, func(r rune) bool {
			return r >= 9 && r <= 13 || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
		}))
		if !ok || len(host) > 253 || !smtpHost.MatchString(host) || strings.Contains(host, "..") {
			return nil, failure("invalid_smtp_request", 400)
		}
		x["host"] = host
	}
	for key, bounds := range map[string][2]int64{"port": {1, 65535}, "connectionTimeoutMs": {100, 120000}, "greetingTimeoutMs": {100, 120000}, "socketTimeoutMs": {100, 300000}, "maxConnections": {1, 32}, "rateLimit": {1, 100000}, "rateWindowSeconds": {1, 86400}} {
		if x[key] != nil && !intOK(x[key], bounds[0], bounds[1]) {
			return nil, failure("invalid_smtp_request", 400)
		}
	}
	if x["tls"] != nil && !oneTLS(str(x["tls"])) {
		return nil, failure("invalid_smtp_request", 400)
	}
	if x["credentialRef"] != nil && !smtpRef.MatchString(str(x["credentialRef"])) {
		return nil, failure("invalid_smtp_request", 400)
	}
	if x["dkimSelector"] != nil && !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`).MatchString(str(x["dkimSelector"])) {
		return nil, failure("invalid_smtp_request", 400)
	}
	if enabled && !completeSMTP(x) {
		return nil, failure("invalid_smtp_request", 400)
	}
	return x, nil
}
func (s *SMTPService) helper() *Service {
	return &Service{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Now: s.Now}
}
func (s *SMTPService) require(ctx context.Context, tx pgx.Tx, a Actor, permission string) (Actor, error) {
	return s.helper().require(ctx, tx, a, permission)
}
func (s *SMTPService) Get(ctx context.Context, a Actor) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.require(ctx, tx, a, "smtp.read")
		if e != nil {
			return nil, e
		}
		current, e := s.current(ctx, tx)
		if e != nil {
			return nil, e
		}
		credentials := []CredentialView{}
		if s.Credentials != nil {
			credentials, e = s.Credentials.List()
			if e != nil {
				return nil, e
			}
		}
		identities := []any{}
		for _, key := range []string{"account", "notice", "community", "updates", "team"} {
			identity := OfficialMailIdentities[key]
			receiving := "send-only"
			if key == "team" {
				receiving = "team-only"
			}
			identities = append(identities, Object{"key": key, "name": identity.Name, "address": identity.Address, "replyTo": identity.ReplyTo, "automated": identity.Automated, "receiving": receiving})
		}
		current["status"] = s.status(current)
		current["credentials"] = credentials
		current["identities"] = identities
		current["capabilities"] = Object{"configure": has(actor, "smtp.configure"), "test.connection": has(actor, "smtp.test.connection"), "test.delivery": has(actor, "smtp.test.delivery"), "canChooseRecipient": has(actor, "accounts.read")}
		current["limitsScope"] = "per-worker-process"
		current["checkedAt"] = s.now().Unix()
		return current, nil
	})
}
func (s *SMTPService) Save(ctx context.Context, a Actor, input Object) (Object, error) {
	if !keys(input, "operationId", "expectedVersion", "configuration") || !uuidOK(input["operationId"]) || !intOK(input["expectedVersion"], 0, 2147483646) {
		return nil, failure("invalid_smtp_request", 400)
	}
	config, e := normalizeSMTP(input["configuration"])
	if e != nil {
		return nil, e
	}
	clean := Object{"operationId": input["operationId"], "expectedVersion": input["expectedVersion"], "configuration": config}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.require(ctx, tx, a, "smtp.configure")
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912422))", s.Endpoint); e != nil {
			return nil, e
		}
		prior, e := one(ctx, tx, "SELECT to_jsonb(c) FROM operations_smtp_commands_v1 c WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, input["operationId"])
		if e == nil {
			if str(prior["operator_id"]) != actor.ID || !same(prior["input"], clean) {
				return nil, failure("operations_command_changed")
			}
			result := obj(clone(prior["result"]))
			result["replayed"] = true
			return result, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		old, e := s.current(ctx, tx)
		if e != nil {
			return nil, e
		}
		if num(old["version"]) != num(input["expectedVersion"]) {
			return nil, failure("smtp_configuration_changed")
		}
		if config["credentialRef"] != nil {
			if s.Credentials == nil {
				return nil, failure("smtp_credential_unavailable")
			}
			credential, e := s.Credentials.Resolve(CredentialSelection{Ref: str(config["credentialRef"]), Host: str(config["host"]), Port: int(num(config["port"])), TLS: str(config["tls"])})
			if e != nil {
				return nil, e
			}
			if credential == nil {
				return nil, failure("smtp_credential_unavailable")
			}
		}
		if boolValue(config["enabled"]) && !completeSMTP(config) {
			return nil, failure("smtp_configuration_incomplete")
		}
		changed := []any{}
		for _, key := range smtpFields {
			if !same(obj(old["configuration"])[key], config[key]) {
				changed = append(changed, key)
			}
		}
		version := num(old["version"]) + 1
		_, e = tx.Exec(ctx, `INSERT INTO operations_smtp_settings_v1(endpoint,version,configuration,updated_by,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(endpoint) DO UPDATE SET version=EXCLUDED.version,configuration=EXCLUDED.configuration,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`, s.Endpoint, version, encode(config), actor.ID, s.now())
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO operations_smtp_events_v1(id,endpoint,operator_id,version,changed_fields,created_at) VALUES($1,$2,$3,$4,$5,$6)", uuid.NewString(), s.Endpoint, actor.ID, version, encode(changed), s.now()); e != nil {
			return nil, e
		}
		if e = s.helper().audit(ctx, tx, actor, "smtp-config-save", input["operationId"], nil, Object{"expectedVersion": input["expectedVersion"], "changedFields": changed}, Object{"version": version, "enabled": config["enabled"]}); e != nil {
			return nil, e
		}
		result := Object{"version": version, "configuration": config, "updatedAt": iso(s.now()), "updatedBy": actor.ID}
		if _, e = tx.Exec(ctx, "INSERT INTO operations_smtp_commands_v1(endpoint,operation_id,operator_id,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6)", s.Endpoint, input["operationId"], actor.ID, encode(clean), encode(result), s.now()); e != nil {
			return nil, e
		}
		result["replayed"] = false
		return result, nil
	})
}
func smtpPage(input Object) (page, error) {
	x := obj(clone(input))
	if x == nil {
		x = Object{}
	}
	if _, exists := x["limit"]; !exists {
		x["limit"] = 25
	}
	q, e := parsePage(x)
	if e != nil {
		return q, failure("invalid_smtp_request", 400)
	}
	return q, nil
}
func (s *SMTPService) testView(row Object) Object {
	started, e := date(row["started_at"])
	stale := str(row["state"]) == "testing" && e == nil && s.now().Sub(started) > 15*time.Minute
	state, code := row["state"], row["code"]
	if stale {
		state = "unknown"
		code = "smtp_submission_unknown"
	}
	return Object{"id": row["id"], "sequence": str(row["sequence"]), "kind": row["kind"], "configurationVersion": row["configuration_version"], "accountId": row["account_id"], "senderKey": row["sender_key"], "state": state, "code": code, "startedAt": stamp(row["started_at"]), "finishedAt": stamp(row["finished_at"]), "delivery": "unknown", "receiptSource": "not-connected"}
}
