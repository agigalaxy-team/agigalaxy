// Package personalaudit owns the original subject audit scope and independently
// signed temporary reader grants. It is separate from operations audit.
package personalaudit

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Actor struct {
	Device        deviceauth.Actor
	HTTPRequestID *string
}
type Service struct {
	Pool                   *pgxpool.Pool
	Endpoint               string
	Devices                *deviceauth.Service
	ReaderIDs, ReviewerIDs []string
	Now                    func() time.Time
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) run(ctx context.Context, a Actor, scope string, fn func(pgx.Tx, deviceauth.ControlAuthorization) (any, error)) (any, error) {
	if s == nil || s.Devices == nil || s.Pool == nil {
		return nil, fail("audit_unavailable", 503)
	}
	if !roles(s.ReaderIDs) || !roles(s.ReviewerIDs) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (any, error) {
		auth, e := s.Devices.CurrentControlWithin(ctx, tx, a.Device, scope)
		if e != nil {
			return nil, e
		}
		return fn(tx, auth)
	})
}
func one(ctx context.Context, tx pgx.Tx, q string, args ...any) (Object, error) {
	var b []byte
	e := tx.QueryRow(ctx, q, args...).Scan(&b)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var o Object
	e = protocol.Decode(b, &o)
	return o, e
}
func encode(v any) []byte { b, _ := protocol.Encode(v); return b }
func epoch(v any) int64 {
	if t, ok := v.(time.Time); ok {
		return t.Unix()
	}
	s, _ := v.(string)
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t.Unix()
}
func (s *Service) record(ctx context.Context, tx pgx.Tx, a Actor, auth deviceauth.ControlAuthorization, action, id, scope string) error {
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,$2,$3::text,$3::text,'accepted',1,ch.payload->>'installationId',b.audience,$4,b.id,$5::uuid,$3::text,b.scopes,$6::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE b.id=$7::uuid AND b.subject_id=$1 AND b.scopes ? $4`, a.Device.SubjectID, action, id, scope, a.HTTPRequestID, encode(auth.CredentialScopes), a.Device.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail("audit_context_unavailable", 503)
	}
	return nil
}
func (s *Service) Config(ctx context.Context, a Actor) (any, error) {
	return s.run(ctx, a, "audit", func(pgx.Tx, deviceauth.ControlAuthorization) (any, error) {
		return Object{"subjectId": a.Device.SubjectID, "canReadOthers": has(s.ReaderIDs, a.Device.SubjectID), "canReview": has(s.ReviewerIDs, a.Device.SubjectID), "maxGrantSeconds": 3600, "maxPageSize": 100, "requiresIndependentApproval": true}, nil
	})
}
func (s *Service) ListGrants(ctx context.Context, a Actor) (any, error) {
	return s.run(ctx, a, "audit", func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		rr, e := tx.Query(ctx, "SELECT payload_text,revoked_at IS NOT NULL FROM audit_access_grants WHERE reader_id=$1 OR reviewer_id=$1 ORDER BY created_at DESC,id LIMIT 100", a.Device.SubjectID)
		if e != nil {
			return nil, e
		}
		defer rr.Close()
		items := []any{}
		for rr.Next() {
			var payload string
			var revoked bool
			if e = rr.Scan(&payload, &revoked); e != nil {
				return nil, e
			}
			var value Object
			if e = json.Unmarshal([]byte(payload), &value); e != nil {
				return nil, e
			}
			value["revoked"] = revoked
			items = append(items, value)
		}
		return Object{"items": items}, rr.Err()
	})
}
func (s *Service) requireGrant(ctx context.Context, tx pgx.Tx, a Actor, id, subjectID, action string) (Object, error) {
	if id == "" || !has(s.ReaderIDs, a.Device.SubjectID) {
		return nil, fail("audit_approval_required", 403)
	}
	r, e := one(ctx, tx, `SELECT to_jsonb(q) FROM(SELECT g.*,b.revoked_at AS binding_revoked,b.expires_at AS binding_expires,b.scopes,b.subject_id,b.audience FROM audit_access_grants g JOIN bindings b ON b.id=g.reviewer_binding_id WHERE g.id=$1 FOR SHARE OF g,b)q`, id)
	if e != nil {
		return nil, e
	}
	if r == nil || str(r, "reader_id") != a.Device.SubjectID || r["revoked_at"] != nil || r["binding_revoked"] != nil || r["subject_id"] != r["reviewer_id"] || !has(s.ReviewerIDs, str(r, "reviewer_id")) || str(r, "audience") != s.Endpoint || !has(stringsOf(r["scopes"]), "audit-review") || epoch(r["expires_at"]) <= s.now() || epoch(r["binding_expires"]) <= s.now() {
		return nil, fail("audit_approval_required", 403)
	}
	var g Object
	if protocol.Decode([]byte(str(r, "payload_text")), &g) != nil {
		return nil, invalid()
	}
	if _, e = parseGrant(g); e != nil {
		return nil, e
	}
	if !has(stringsOf(g["subjectIds"]), subjectID) || !has(stringsOf(g["actions"]), action) {
		return nil, fail("audit_scope_denied", 403)
	}
	return g, nil
}
