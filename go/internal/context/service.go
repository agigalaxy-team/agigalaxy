// Package contextdata owns the existing selected-material Context grants.
// Acceptance never grants execution, room membership, or source republication.
package contextdata

import (
	"context"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, bool, func() error, func() (Object, error)) (Object, error)
type Service struct {
	Pool          *pgxpool.Pool
	Endpoint      string
	Devices       *deviceauth.Service
	Now           func() time.Time
	ResourceWrite ResourceWrite
	// LegacyLoad returns {row,paused} from the owning Assistance load, including
	// its current Case owner-source and every original event grant check.
	LegacyLoad    func(context.Context, pgx.Tx, string) (Object, error)
	Participation func(context.Context, pgx.Tx, deviceauth.Actor, string, string) (Object, error)
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) at() time.Time { return time.Unix(s.now(), 0).UTC() }
func encode(v any) []byte {
	raw, e := protocol.EncodeJS(v)
	if e != nil {
		panic(e)
	}
	return raw
}
func withheld(e error) bool {
	var f *fault.Error
	return errors.As(e, &f) && (f.Status == 403 || f.Status == 404)
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
func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	rows, e := query(ctx, tx, sql, args...)
	if e != nil || len(rows) == 0 {
		return nil, e
	}
	return rows[0], nil
}
func (s *Service) run(ctx context.Context, a deviceauth.Actor, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if s.Pool == nil || s.Devices == nil {
		return nil, fault.New("context_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func() error { var e error; auth, e = s.Devices.CurrentControlWithin(ctx, tx, a, "context"); return e }
		operation := func() (Object, error) { return fn(tx, auth) }
		if write && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, a, control, authorize, operation)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return operation()
	})
}
func (s *Service) consent(ctx context.Context, tx pgx.Tx, subject, consentID, objectID, payload string) (deviceauth.ConsentIntent, error) {
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fault.New("context_unavailable", 503)
	}
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: consentID, SubjectID: subject, Action: "context.grant", ObjectID: objectID, Recipient: s.Endpoint, PayloadJSON: payload})
}
func privateRecipient(g deviceauth.ConsentIntent, recipient string) error {
	if g.Visibility != "Private" || len(g.Viewers) != 1 || g.Viewers[0] != recipient {
		return fault.New("context_scope_mismatch", 403)
	}
	return nil
}
func includes(a []string, key string) bool {
	for _, v := range a {
		if v == key {
			return true
		}
	}
	return false
}
func (s *Service) auditRead(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, auth deviceauth.ControlAuthorization, id, action, consentID, requestID string) error {
	if !includes(auth.CredentialScopes, "context") {
		return fault.New("context_read_audit_unavailable", 503)
	}
	var consent, rid any
	if consentID != "" {
		consent = consentID
	}
	if requestID != "" {
		rid = requestID
	}
	eventID := uuid.NewString()
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
 SELECT $1,$2,$3::text,$4::text,'accepted',1,ch.payload->>'installationId',b.audience,'context',$5::uuid,b.id,$6::uuid,$4::text,b.scopes,$7::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE b.id=$8::uuid AND b.subject_id=$1 AND b.scopes ? 'context'`, a.SubjectID, action, id, eventID, consent, rid, string(encode(auth.CredentialScopes)), a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fault.New("context_read_audit_unavailable", 503)
	}
	return nil
}
func (s *Service) auditWrite(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, auth deviceauth.ControlAuthorization, id, action, requestID string, v2 bool) error {
	if v2 && !includes(auth.CredentialScopes, "context") {
		return fmt.Errorf("context audit authorization unavailable")
	}
	table, column := "context_grants", "id"
	if v2 {
		table = "context_grants_v2"
		if action != "context.create" {
			table = "context_events_v2"
		}
	} else if action == "context.accept" {
		table = "context_acceptances"
	}
	var rid any
	if requestID != "" {
		rid = requestID
	}
	sql := `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
 SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'context',c.id,b.id,$4,$2::text,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM ` + table + ` e JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE e.` + column + `=$2::text::uuid AND e.subject_id=$1 AND c.subject_id=$1 AND b.subject_id=$1`
	if !v2 {
		sql += ` AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action=$3 AND object_id=$2::text)`
	}
	tag, e := tx.Exec(ctx, sql, a.SubjectID, id, action, rid, string(encode(auth.CredentialScopes)), a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	if !v2 {
		var n int64
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE actor=$1 AND action=$2 AND object_id=$3`, a.SubjectID, action, id).Scan(&n); e != nil {
			return e
		}
		if n == 1 {
			return nil
		}
	}
	return fmt.Errorf("context audit unavailable")
}
