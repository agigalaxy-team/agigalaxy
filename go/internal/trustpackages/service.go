package trustpackages

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Actor struct {
	deviceauth.Actor
	HTTPRequestID *string
}
type SourceRead func(context.Context, pgx.Tx, *deviceauth.Actor, Object) (Object, error)
type AuthorSourceRead func(context.Context, pgx.Tx, string, Object) (Object, error)
type Service struct {
	Pool             *pgxpool.Pool
	Endpoint         string
	Devices          *deviceauth.Service
	Resources        *resourcebudget.Service
	ReadSource       SourceRead
	ReadAuthorSource AuthorSourceRead
	VerifyPermission func(string, string) (string, error)
	Now              func() time.Time
}

func New(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, now func() time.Time) *Service {
	return &Service{Pool: pool, Endpoint: endpoint, Devices: devices, VerifyPermission: deviceauth.VerifyTrustPermissionResponse, Now: now}
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func iso(n int64) string { return time.Unix(n, 0).UTC().Format("2006-01-02T15:04:05.000Z") }
func expires(v any, now int64) bool {
	s, _ := v.(string)
	t, e := time.Parse(time.RFC3339Nano, s)
	return e == nil && t.After(time.Unix(now, 0))
}
func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var v Object
	e := tx.QueryRow(ctx, sql, args...).Scan(&v)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	return v, e
}
func rows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	r, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	out := []Object{}
	for r.Next() {
		var v Object
		if e = r.Scan(&v); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, r.Err()
}
func (s *Service) run(ctx context.Context, a Actor, write bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if write {
		if e := deviceauth.CheckInformationWatchWrite(a.Actor, "consent"); e != nil {
			return nil, e
		}
	}
	if s == nil || s.Pool == nil || s.Devices == nil || s.Endpoint != s.Devices.Endpoint {
		return nil, fail("trust_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var control deviceauth.ControlAuthorization
		authorize := func(ctx context.Context, tx pgx.Tx) error {
			var e error
			control, e = s.Devices.CurrentControlWithin(ctx, tx, a.Actor, "consent")
			return e
		}
		if write {
			budget := s.Resources
			if budget == nil {
				budget, _ = resourcebudget.New(nil, s.Now)
			}
			v, e := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.SubjectID}, authorize, func(context.Context, pgx.Tx) (any, error) { return fn(tx, control) }, resourcebudget.Options{})
			return object(v), e
		}
		if e := authorize(ctx, tx); e != nil {
			return nil, e
		}
		return fn(tx, control)
	})
}
func (s *Service) localSource(ref Object) error {
	if ref["endpoint"] != s.Endpoint {
		return fail("trust_source_endpoint_mismatch", 422)
	}
	return nil
}
func sourceScope(a deviceauth.ControlAuthorization, ref Object) error {
	scope := "proof"
	switch ref["kind"] {
	case "case-event":
		scope = "case-teaser"
	case "evidence", "verification":
		scope = "evidence"
	}
	for _, v := range a.CredentialScopes {
		if v == scope {
			return nil
		}
	}
	return fail("trust_source_scope_required", 403)
}
func (s *Service) ownSourceWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, ref Object) (Object, error) {
	if e := s.localSource(ref); e != nil {
		return nil, e
	}
	if s.ReadSource == nil {
		return nil, fail("trust_source_adapter_unavailable", 503)
	}
	source, e := s.ReadSource(ctx, tx, &a, ref)
	if e != nil {
		return nil, e
	}
	if source["authorId"] != a.SubjectID {
		return nil, fail("trust_original_author_required", 403)
	}
	return source, nil
}
func (s *Service) receiptRow(r Object) Object {
	status := "recorded-needs-current-source-check"
	if r["revoked_at"] != nil {
		status = "revoked"
	} else if !expires(r["expires_at"], s.now()) {
		status = "expired"
	}
	return Object{"id": r["id"], "state": "recorded", "operationId": r["operation_id"], "signatureHash": r["signature_hash"], "revokeOperationId": r["revoke_operation_id"], "revokeSignatureHash": r["revoke_signature_hash"], "status": status, "externalCopiesDeleted": false}
}
func (s *Service) visibleRowWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
	r, e := row(ctx, tx, "SELECT to_jsonb(p) FROM trust_package_permissions p WHERE id=$1", id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("trust_permission_unavailable", 404)
	}
	p, e := payload(r)
	if e != nil {
		return nil, e
	}
	audience := object(p["audience"])
	allowed := r["subject_id"] == a.SubjectID || r["grantee_id"] == a.SubjectID || audience["kind"] == "public"
	for _, v := range array(audience["subjectIds"]) {
		if v == a.SubjectID {
			allowed = true
		}
	}
	if !allowed {
		return nil, fail("trust_permission_unavailable", 404)
	}
	return r, nil
}
func (s *Service) usableWithin(ctx context.Context, tx pgx.Tx, r Object) (Object, error) {
	if r["revoked_at"] != nil {
		return Object{"status": "revoked"}, nil
	}
	if !expires(r["expires_at"], s.now()) {
		return Object{"status": "expired"}, nil
	}
	p, e := payload(r)
	if e != nil {
		return nil, e
	}
	if s.ReadAuthorSource == nil {
		return nil, fail("trust_author_source_adapter_unavailable", 503)
	}
	source, e := func() (Object, error) {
		b, e := row(ctx, tx, "SELECT jsonb_build_object('subject_id',subject_id,'revoked_at',revoked_at,'expires_at',expires_at) FROM bindings WHERE id=$1", p["bindingId"])
		if e != nil {
			return nil, e
		}
		if b == nil || b["subject_id"] != r["subject_id"] || b["revoked_at"] != nil || !expires(b["expires_at"], s.now()) {
			return nil, fail("trust_binding_unavailable")
		}
		if e = s.Devices.RequireTrustControlWithin(ctx, tx, str(r, "subject_id"), str(p, "keyId"), number(p["epoch"])); e != nil {
			return nil, e
		}
		ref := object(p["source"])
		if e = s.localSource(ref); e != nil {
			return nil, e
		}
		source, e := s.ReadAuthorSource(ctx, tx, str(r, "subject_id"), ref)
		if e != nil {
			return nil, e
		}
		if source["authorId"] != r["subject_id"] {
			return nil, fail("trust_original_author_required", 403)
		}
		if source["copyEligible"] != true || source["sourceHash"] != p["sourceHash"] {
			return nil, fail("trust_source_changed")
		}
		return source, nil
	}()
	if e != nil {
		var f *fault.Error
		if !errors.As(e, &f) {
			return nil, e
		}
		return Object{"status": "source-or-control-unavailable", "reason": f.Code}, nil
	}
	return Object{"status": "active", "source": source}, nil
}
