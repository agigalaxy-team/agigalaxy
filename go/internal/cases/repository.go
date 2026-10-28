// Package cases owns the existing append-only Case event ledger. Case facts
// remain reports by their original authors, with current consent checked by
// each authorized consumer rather than inferred from container ownership.
package cases

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Object = map[string]any
type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, bool, func() error, func() (Object, error)) (Object, error)
type Service struct {
	grantAuthor                       string
	GrantAuthorTaskRead               func(context.Context, pgx.Tx, string, string) (Object, error)
	GrantAuthorSources                func(context.Context, pgx.Tx, string, Object, Object) (Object, error)
	GrantAuthorVerificationReference  func(context.Context, pgx.Tx, string, Object, string, int64) (Object, error)
	GrantAuthorConfigurationCondition func(context.Context, pgx.Tx, string, any) (Object, error)
	Pool                              *pgxpool.Pool
	Endpoint                          string
	Devices                           *deviceauth.Service
	Now                               func() time.Time
	ResourceWrite                     ResourceWrite
	CapsuleUses                       func(context.Context, pgx.Tx, deviceauth.Actor, string) (Object, error)
	Sources                           func(context.Context, pgx.Tx, *deviceauth.Actor, Object, Object) (Object, error)
	VerificationReference             func(context.Context, pgx.Tx, *deviceauth.Actor, Object, string, int64) (Object, error)
	ConfigurationCondition            func(context.Context, pgx.Tx, *deviceauth.Actor, any) (Object, error)
	TaskRead                          func(context.Context, pgx.Tx, deviceauth.Actor, string) (Object, error)
	TaskWrite                         func(context.Context, pgx.Tx, deviceauth.Actor, string) (Object, error)
	Participation                     func(context.Context, pgx.Tx, deviceauth.Actor, string, string) (Object, error)
	AttachCase                        func(context.Context, pgx.Tx, string, string, string) (Object, error)
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func object(v any) Object {
	switch v := v.(type) {
	case Object:
		return v
	case *protocol.OrderedObject:
		return v.Values()
	}
	return nil
}
func text(o Object, k string) string { v, _ := o[k].(string); return v }
func number(o Object, k string) int64 {
	switch v := o[k].(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case int32:
		return int64(v)
	case int16:
		return int64(v)
	case float64:
		return int64(v)
	case json.Number:
		n, e := v.Int64()
		if e == nil {
			return n
		}
		f, _ := v.Float64()
		return int64(f)
	}
	return 0
}
func list(v any) []any { a, _ := v.([]any); return a }
func fallback(v, other any) any {
	if v == nil {
		return other
	}
	return v
}
func copyObject(o Object) Object {
	v := Object{}
	for k, x := range o {
		v[k] = x
	}
	return v
}
func encode(v any) []byte { b, _ := protocol.EncodeJS(v); return b }
func queryOne(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	rows, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	values, e := rows.Values()
	if e != nil {
		return nil, e
	}
	out := Object{}
	for i, f := range rows.FieldDescriptions() {
		v := values[i]
		switch x := v.(type) {
		case [16]byte:
			v = uuidString(x)
		case time.Time:
			v = x.UTC().Format("2006-01-02T15:04:05.000Z")
		}
		out[f.Name] = v
	}
	return out, nil
}
func uuidString(v [16]byte) string { return uuid.UUID(v).String() }
func events(ctx context.Context, tx pgx.Tx, id string) ([]Object, error) {
	rows, e := tx.Query(ctx, `SELECT id::text,case_id::text,subject_id,kind,version,consent_id::text,payload,payload_text,payload_hash,created_at FROM case_events WHERE case_id=$1 ORDER BY version LIMIT 1001`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var id, cid, subject, kind, consent string
		var version int64
		var raw []byte
		var payload, hash *string
		var created time.Time
		if e = rows.Scan(&id, &cid, &subject, &kind, &version, &consent, &raw, &payload, &hash, &created); e != nil {
			return nil, e
		}
		p, e := protocol.DecodeOrdered(raw)
		if e != nil {
			return nil, e
		}
		var exact, digest any
		if payload != nil {
			exact = *payload
		}
		if hash != nil {
			digest = *hash
		}
		out = append(out, Object{"id": id, "case_id": cid, "subject_id": subject, "kind": kind, "version": version, "consent_id": consent, "payload": p, "payload_text": exact, "payload_hash": digest, "created_at": created.UTC().Format("2006-01-02T15:04:05.000Z")})
	}
	return out, rows.Err()
}
func (s *Service) grant(ctx context.Context, tx pgx.Tx, row Object) (deviceauth.ConsentIntent, error) {
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fault.New("case_service_unavailable", 503)
	}
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: text(row, "consent_id"), SubjectID: text(row, "subject_id"), Action: "case.teaser.publish", ObjectID: text(row, "id"), Recipient: s.Endpoint, PayloadJSON: text(row, "payload_text")})
}

// RequireOwnedCaseLiveWithin is the exact Assistance/Task source liveness
// check. The caller authorizes its own operation in this transaction; ownership
// never substitutes for the authors of the individual Case facts.
func (s *Service) RequireOwnedCaseLiveWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) error {
	return s.requireOwnerSource(ctx, tx, id, a.SubjectID)
}
func (s *Service) requireOwnerSource(ctx context.Context, tx pgx.Tx, id, owner string) error {
	parent, e := queryOne(ctx, tx, `SELECT id::text,subject_id,state,version FROM cases WHERE id=$1 AND subject_id=$2 FOR SHARE`, id, owner)
	if e != nil {
		return e
	}
	if parent == nil || parent["state"] == "withdrawn" {
		return fault.New("assistance_case_unavailable", 403)
	}
	rows, e := events(ctx, tx, id)
	if e != nil {
		return e
	}
	if len(rows) > 1000 {
		return fault.New("case_event_limit", 413)
	}
	for _, r := range rows {
		if _, e = s.grant(ctx, tx, r); e != nil {
			return e
		}
	}
	return nil
}

// CaseWithin returns the original container and deterministic facts for the
// Verification/Outcome owner's transaction. It grants no Case content access;
// that owner must apply its original per-source and per-record authority.
func (s *Service) CaseWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	parent, e := queryOne(ctx, tx, `SELECT id::text,subject_id,local_ref,source_ref,version,state,created_at FROM cases WHERE id=$1 FOR SHARE`, id)
	if e != nil {
		return nil, e
	}
	if parent == nil {
		return nil, fault.New("case_unavailable", 404)
	}
	rows, e := events(ctx, tx, id)
	if e != nil {
		return nil, e
	}
	return Object{"parent": parent, "rows": rows, "facts": ProjectFacts(rows, parent)}, nil
}
func (s *Service) run(ctx context.Context, a deviceauth.Actor, write, control bool, operation func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if s.Pool == nil || s.Devices == nil {
		return nil, fault.New("case_service_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func() error {
			var e error
			auth, e = s.Devices.CurrentControlWithin(ctx, tx, a, "case-teaser")
			return e
		}
		op := func() (Object, error) { return operation(tx, auth) }
		if write && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, a, control, authorize, op)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return op()
	})
}
