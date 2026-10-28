package systemsettings

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"net/http"
)

func OperationsSMTPCredentialAlias(ref string) (string, error) {
	if !keyRefPattern.MatchString(ref) {
		return "", fail("system_settings_credential_unavailable", 409)
	}
	return "system-key-" + ref[len("system-key:"):], nil
}
func OperationsMailConfiguration(connection Object) (Object, error) {
	parsed, e := parseMailConnection(connection)
	if e != nil {
		return nil, e
	}
	alias, e := OperationsSMTPCredentialAlias(str(parsed["credentialRef"]))
	if e != nil {
		return nil, e
	}
	out := Object{"enabled": true, "credentialRef": alias}
	for _, k := range transportFields {
		out[k] = parsed[k]
	}
	return out, nil
}
func smtpChildID(id string) string {
	h := []byte(identity.Digest([]byte("system-settings-operations-smtp\x00" + id))[:32])
	h[12], h[16] = '5', 'a'
	value := string(h)
	return value[:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:]
}
func (b *MailBridge) Overview(ctx context.Context) (Object, error) {
	if b.SMTP == nil {
		return Object{"state": "not-configured", "version": 0, "configuration": nil}, nil
	}
	current, e := b.SMTP.CurrentWithin(ctx, b.Settings.Pool)
	if e != nil {
		return nil, e
	}
	out := clone(current)
	out["state"] = b.SMTP.StatusOf(current)["state"]
	return out, nil
}

type bridgeClaim struct {
	row, command Object
	actor        Actor
}

func (b *MailBridge) claim(ctx context.Context, intent Object) (bridgeClaim, error) {
	if _, e := b.Settings.AuthorizeNative(ctx, intent); e != nil {
		return bridgeClaim{}, e
	}
	return postgres.InTx(ctx, b.Settings.Pool, func(tx pgx.Tx) (bridgeClaim, error) {
		if e := b.Settings.operationLock(ctx, tx, str(intent["operationId"])); e != nil {
			return bridgeClaim{}, e
		}
		row, e := b.Settings.row(ctx, tx, str(intent["operationId"]))
		if e != nil {
			return bridgeClaim{}, e
		}
		if row == nil || row["operator_id"] != intent["operatorId"] || row["section"] != "mail" || row["kind"] != "apply" {
			return bridgeClaim{}, fail("system_settings_permission_denied", 403)
		}
		version, e := b.Settings.version(ctx, tx, row["version_id"], "mail")
		if e != nil {
			return bridgeClaim{}, e
		}
		configuration := obj(version["configuration"])
		id := obj(configuration["bindings"])["operations"]
		var connection Object
		for _, v := range list(configuration["connections"]) {
			r := obj(v)
			if r["id"] == id {
				connection = r
				break
			}
		}
		if connection == nil || connection["credentialRef"] == nil {
			return bridgeClaim{}, fail("system_settings_configuration_incomplete", 409)
		}
		if prior := obj(obj(row["result"])["operationsSmtp"]); prior != nil {
			return bridgeClaim{row: row, command: prior}, nil
		}
		current, e := b.SMTP.CurrentWithin(ctx, tx)
		if e != nil {
			return bridgeClaim{}, e
		}
		transport, e := OperationsMailConfiguration(connection)
		if e != nil {
			return bridgeClaim{}, e
		}
		command := Object{"operationId": smtpChildID(str(row["operation_id"])), "expectedVersion": current["version"], "configuration": transport}
		result := clone(obj(row["result"]))
		result["operationsSmtp"] = command
		if _, e = tx.Exec(ctx, `UPDATE operations_system_settings_commands_v1 SET result=$3 WHERE endpoint=$1 AND operation_id=$2`, b.Settings.Endpoint, row["operation_id"], result); e != nil {
			return bridgeClaim{}, e
		}
		return bridgeClaim{row: row, command: command}, nil
	})
}

// This authority exists only inside one fixed, persisted mail-apply bridge. It
// cannot authenticate HTTP or map any SMTP test/delivery permission.
type mailApplyAuthority struct {
	settings *Service
	intent   Object
}

func (a *mailApplyAuthority) RequireWithin(ctx context.Context, tx pgx.Tx, actor Actor, permission string) (Actor, error) {
	if permission != "smtp.configure" || actor.ID != a.intent["operatorId"] || actor.Endpoint != a.settings.Endpoint {
		return Actor{}, fail("system_settings_permission_denied", 403)
	}
	fresh, _, e := a.settings.authorizeNativeWithin(ctx, tx, a.intent)
	return fresh, e
}
func (a *mailApplyAuthority) EffectiveWithin(ctx context.Context, tx pgx.Tx, actor Actor) (Actor, error) {
	return a.RequireWithin(ctx, tx, actor, "smtp.configure")
}
func (a *mailApplyAuthority) PersonWithin(context.Context, pgx.Tx, string, bool) (Actor, error) {
	return Actor{}, fail("system_settings_permission_denied", 403)
}
func (a *mailApplyAuthority) AuthorizeOperations(*http.Request, bool, string) (Actor, error) {
	return Actor{}, fail("system_settings_permission_denied", 403)
}

var _ p.Authority = (*mailApplyAuthority)(nil)

func (b *MailBridge) Apply(ctx context.Context, intent Object) (Object, error) {
	if b.SMTP == nil {
		return nil, fail("system_settings_consumer_not_configured", 503)
	}
	if intent["kind"] != "settings-apply" || intent["section"] != "mail" {
		return nil, fail("system_settings_permission_denied", 403)
	}
	value, e := ParseNativeCommand(intent, true)
	if e != nil {
		return nil, e
	}
	claim, e := b.claim(ctx, value)
	if e != nil {
		return nil, e
	}
	actor := Actor{ID: str(claim.row["operator_id"]), Endpoint: b.Settings.Endpoint}
	result, e := b.SMTP.SaveWithAuthority(ctx, actor, claim.command, &mailApplyAuthority{settings: b.Settings, intent: value})
	if e != nil {
		if errorCode(e) == "smtp_configuration_changed" {
			return nil, fail("system_settings_source_changed", 409)
		}
		return nil, e
	}
	if _, e = b.Settings.AuthorizeNative(ctx, value); e != nil {
		return nil, e
	}
	return Object{"state": "completed", "configurationVersion": result["version"], "configuration": result["configuration"]}, nil
}
func (b *MailBridge) Readback(ctx context.Context, input Object) (Object, error) {
	row, e := b.Settings.row(ctx, b.Settings.Pool, str(input["operationId"]))
	if e != nil {
		return nil, e
	}
	if row == nil || row["operator_id"] != input["operatorId"] || row["section"] != "mail" || row["kind"] != "apply" {
		return nil, fail("system_settings_permission_denied", 403)
	}
	command := obj(obj(row["result"])["operationsSmtp"])
	if command == nil || b.SMTP == nil {
		return Object{"state": "unknown", "configurationVersion": nil}, nil
	}
	current, e := b.SMTP.CurrentWithin(ctx, b.Settings.Pool)
	if e != nil {
		return nil, e
	}
	status := b.SMTP.StatusOf(current)
	state := "unknown"
	if num(current["version"]) == num(command["expectedVersion"])+1 && same(current["configuration"], command["configuration"]) && status["credentialAvailable"] == true {
		state = "completed"
	}
	return Object{"state": state, "configurationVersion": current["version"], "configuration": current["configuration"]}, nil
}
func (b *MailBridge) Call(ctx context.Context, input Object) (Object, error) {
	switch input["kind"] {
	case "operations-overview":
		if !closed(input, []string{"kind"}, nil) {
			return nil, invalid()
		}
		return b.Overview(ctx)
	case "operations-apply":
		if !closed(input, []string{"kind", "intent"}, nil) {
			return nil, invalid()
		}
		return b.Apply(ctx, obj(input["intent"]))
	case "operations-readback":
		if !closed(input, []string{"kind", "operationId", "operatorId"}, nil) || !uuidPattern.MatchString(str(input["operationId"])) || !operatorPattern.MatchString(str(input["operatorId"])) {
			return nil, invalid()
		}
		return b.Readback(ctx, input)
	}
	return nil, invalid()
}
