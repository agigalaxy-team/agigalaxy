// Package configurations owns selected, author-reported configuration records.
// A record never establishes an actual installation or republishes source rights.
package configurations

import (
	"context"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, bool, func() error, func() (Object, error)) (Object, error)
type Service struct {
	grantAuthor   string
	Pool          *pgxpool.Pool
	Endpoint      string
	Devices       *deviceauth.Service
	Now           func() time.Time
	ResourceWrite ResourceWrite
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func encode(v any) []byte {
	raw, e := protocol.EncodeJS(v)
	if e != nil {
		panic(e)
	}
	return raw
}
func missing(e error) bool {
	var f *fault.Error
	return errors.As(e, &f) && (f.Status == 403 || f.Status == 404 || f.Status == 409 || f.Status == 422 || f.Status == 503)
}
func query(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	rows, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		values, e := rows.Values()
		if e != nil {
			return nil, e
		}
		o := Object{}
		for i, f := range rows.FieldDescriptions() {
			o[f.Name] = values[i]
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
func one(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	rows, e := query(ctx, tx, sql, args...)
	if e != nil || len(rows) == 0 {
		return nil, e
	}
	return rows[0], nil
}
func (s *Service) run(ctx context.Context, a *deviceauth.Actor, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("configuration_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func() error {
			if a == nil {
				return nil
			}
			if s.Devices == nil {
				return fault.New("configuration_unavailable", 503)
			}
			var e error
			auth, e = s.Devices.CurrentControlWithin(ctx, tx, *a, "history")
			return e
		}
		operation := func() (Object, error) { return fn(tx, auth) }
		if write && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, *a, control, authorize, operation)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return operation()
	})
}
func (s *Service) visible(g deviceauth.ConsentIntent, a *deviceauth.Actor) bool {
	viewer := ""
	if s.grantAuthor != "" {
		viewer = s.grantAuthor
	} else if a != nil {
		viewer = a.SubjectID
	}
	if g.IssuedAt > s.now() || g.ExpiresAt <= s.now() {
		return false
	}
	if viewer != "" && viewer == g.SubjectID {
		return true
	}
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
		return false
	}
	if g.Visibility == "Public" {
		return g.Purpose == "public-profile"
	}
	if viewer != "" && (g.Visibility == "Private" || g.Visibility == "Hub-scoped" && g.Recipient == s.Endpoint) {
		for _, v := range g.Viewers {
			if v == viewer {
				return true
			}
		}
	}
	return false
}
func (s *Service) Submit(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	var input Object
	if protocol.Decode(raw, &input) != nil {
		return nil, fault.New("invalid_configuration_request", 400)
	}
	payload, ok := input["payloadJson"].(string)
	if !ok {
		return nil, fault.New("invalid_configuration_request", 400)
	}
	parsed, e := parseEvent(payload)
	if e != nil {
		return nil, e
	}
	x := parsed.Values()
	if x["actorId"] != a.SubjectID {
		return nil, fault.New("configuration_author_required", 403)
	}
	if x["kind"] == "record" {
		at, _ := time.Parse(time.RFC3339Nano, text(x, "observedAt"))
		if at.UnixMilli() > s.now()*1000 {
			return nil, fault.New("configuration_future_observation", 422)
		}
	}
	return s.run(ctx, &a, true, x["kind"] == "revoke", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: text(input, "consentId"), SubjectID: a.SubjectID, Action: "configuration.publish", ObjectID: text(x, "operationId"), Recipient: s.Endpoint, PayloadJSON: payload})
		if e != nil {
			return nil, e
		}
		if grant.Visibility != "Private" && grant.Visibility != "Public" {
			return nil, fault.New("configuration_visibility_required", 403)
		}
		if x["kind"] == "record" && number(x, "expectedVersion") == 0 {
			if _, e = tx.Exec(ctx, `INSERT INTO configuration_objects(id,subject_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, x["id"], a.SubjectID); e != nil {
				return nil, e
			}
		}
		parent, e := one(ctx, tx, `SELECT id::text,subject_id,version,state FROM configuration_objects WHERE id=$1 AND subject_id=$2 FOR UPDATE`, x["id"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		if parent == nil {
			return nil, fault.New("configuration_unavailable", 404)
		}
		prior, e := one(ctx, tx, `SELECT configuration_id::text,subject_id,version,payload_hash,consent_id::text FROM configuration_events WHERE operation_id=$1`, x["operationId"])
		if e != nil {
			return nil, e
		}
		hash := identity.Digest([]byte(payload))
		if prior != nil {
			if prior["configuration_id"] != x["id"] || prior["subject_id"] != a.SubjectID || prior["payload_hash"] != hash || prior["consent_id"] != input["consentId"] {
				return nil, fault.New("configuration_operation_conflict", 409)
			}
			return Object{"id": x["id"], "version": prior["version"], "operationId": x["operationId"], "acknowledged": true}, nil
		}
		if parent["state"] != "active" {
			return nil, fault.New("configuration_revoked", 409)
		}
		version := number(parent, "version")
		if version != number(x, "expectedVersion") {
			return nil, fault.New("configuration_version_conflict", 409)
		}
		if x["kind"] == "revoke" && version <= 0 || x["kind"] != "revoke" && version >= 1000 {
			return nil, fault.New("configuration_version_limit", 413)
		}
		if _, e = tx.Exec(ctx, `INSERT INTO configuration_events(operation_id,configuration_id,subject_id,version,kind,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, x["operationId"], x["id"], a.SubjectID, version+1, x["kind"], input["consentId"], payload, hash); e != nil {
			return nil, e
		}
		state := "active"
		if x["kind"] == "revoke" {
			state = "revoked"
		}
		if _, e = tx.Exec(ctx, `UPDATE configuration_objects SET version=$2,state=$3 WHERE id=$1`, x["id"], version+1, state); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, auth, text(x, "operationId"), requestID); e != nil {
			return nil, e
		}
		return Object{"id": x["id"], "version": version + 1, "operationId": x["operationId"], "acknowledged": true, "actualInstallationVerified": false, "sourceAuthority": "subject-reported-selected-conditions"}, nil
	})
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, auth deviceauth.ControlAuthorization, id, requestID string) error {
	var rid any
	if requestID != "" {
		rid = requestID
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
 SELECT $1,'configuration.event',$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'history',c.id,b.id,$3,$2::text,b.scopes,$4::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$5::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=(SELECT consent_id FROM configuration_events WHERE operation_id=$2::text::uuid AND subject_id=$1) AND c.subject_id=$1`, a.SubjectID, id, rid, string(encode(auth.CredentialScopes)), a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("configuration audit authorization unavailable")
	}
	return nil
}
