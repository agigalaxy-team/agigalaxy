// Package operationsaccounts owns the original business-account governance
// surface. Registered login-directory records are not account governance.
package operationsaccounts

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"math"
	"slices"
	"strings"
	"time"
	"unicode"
)

type Object = map[string]any
type Actor = operationspermissions.Actor
type Service struct {
	Domain            *businessadmin.Domain
	Accounts          *accounts.Service
	LookupIdentity    func(context.Context, string, string) (Object, error)
	FindByEmail       func(context.Context, string) ([]Object, error)
	DirectorySummary  func(context.Context, Actor, Object) (Object, error)
	AccountSummary    func(context.Context, Actor, string, Object) (Object, error)
	AnalysisQueryRead func(context.Context, Actor, operationspermissions.Authority, string, string, Object) (Object, error)
}

func fail(c string, s int) error { return fault.New(c, s) }
func invalid() error             { return fail("invalid_business_admin_request", 400) }
func str(v any) string           { x, _ := v.(string); return x }
func obj(v any) Object           { x, _ := v.(map[string]any); return x }
func number(v any) (int64, bool) {
	var f float64
	switch n := v.(type) {
	case int:
		return int64(n), n >= 0
	case int64:
		return n, n >= 0 && n <= 9007199254740991
	case float64:
		f = n
	case json.Number:
		var e error
		f, e = n.Float64()
		if e != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	return int64(f), !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0 && f <= 9007199254740991 && math.Trunc(f) == f
}
func num(v any) int64 { n, _ := number(v); return n }
func trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return r == 0xfeff || unicode.IsSpace(r) && r != 0x85 })
}
func validID(v string) bool {
	id, e := uuid.Parse(v)
	return e == nil && len(v) == 36 && (id == uuid.Nil || id == uuid.Max || id.Variant() == uuid.RFC4122 && id.Version() >= 1 && id.Version() <= 8)
}
func strict(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	for k := range o {
		if !slices.Contains(required, k) && !slices.Contains(optional, k) {
			return false
		}
	}
	return true
}
func equal(a, b any) bool {
	x, e := identity.Canonical(a)
	y, f := identity.Canonical(b)
	return e == nil && f == nil && string(x) == string(y)
}
func (s *Service) now() time.Time {
	if s.Domain.Now != nil {
		return s.Domain.Now()
	}
	return time.Now()
}
func stamp(v any) any {
	switch t := v.(type) {
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	case string:
		if t != "" {
			if p, e := time.Parse(time.RFC3339Nano, t); e == nil {
				return p.UTC().Format("2006-01-02T15:04:05.000Z")
			}
		}
	}
	return nil
}
func coalesce(v, f any) any {
	if v == nil {
		return f
	}
	return v
}
func rows(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]Object, error) {
	rs, e := tx.Query(ctx, query, args...)
	if e != nil {
		return nil, e
	}
	defer rs.Close()
	out := []Object{}
	for rs.Next() {
		var raw []byte
		if e = rs.Scan(&raw); e != nil {
			return nil, e
		}
		var o Object
		if e = protocol.Decode(raw, &o); e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, rs.Err()
}
func one(ctx context.Context, tx pgx.Tx, query string, args ...any) (Object, error) {
	r, e := rows(ctx, tx, query, args...)
	if e != nil || len(r) == 0 {
		return nil, e
	}
	return r[0], nil
}
func (s *Service) domain() *businessadmin.Domain {
	if s.Domain == nil {
		return nil
	}
	d := *s.Domain
	d.Permissions = func(action string, _ Object) []string {
		switch action {
		case "user-read", "users-query":
			return []string{"accounts.read"}
		case "restriction-set":
			return []string{"accounts.restriction.apply"}
		case "restriction-release":
			return []string{"accounts.restriction.release"}
		case "type-change":
			return []string{"accounts.type.change"}
		}
		return nil
	}
	return &d
}
func (s *Service) fresh(ctx context.Context, a Actor, permission string) (Actor, error) {
	d := s.domain()
	if d == nil || d.Pool == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (Actor, error) { return d.Fresh(ctx, tx, a, permission) })
}

const accountColumns = `a.id,a.uid,a.endpoint,a.issuer,a.external_subject,a.verification_method,a.verified_at,a.created_at,a.restricted_until,a.restriction_reason,a.restriction_revision,p.display_name,p.avatar_key,p.bio,p.subject_type,p.revision,p.query_enabled,p.query_scope,p.query_linked_ids,p.query_external_credentials`

func (s *Service) AccountWithin(ctx context.Context, tx pgx.Tx, id string, lock bool) (Object, error) {
	if !validID(id) {
		return nil, invalid()
	}
	suffix := ""
	if lock {
		suffix = " FOR UPDATE OF a"
	}
	r, e := one(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT `+accountColumns+` FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2`+suffix+`)r`, id, s.Domain.Endpoint)
	if e == nil && r == nil {
		e = fail("not_found", 404)
	}
	return r, e
}
func (s *Service) restriction(r Object) Object {
	until := stamp(r["restricted_until"])
	active := false
	if t, e := time.Parse(time.RFC3339Nano, str(until)); e == nil {
		active = t.After(s.now())
	}
	return Object{"scope": "community-participation", "active": active, "until": until, "reason": r["restriction_reason"], "revision": coalesce(r["restriction_revision"], 0)}
}
func capabilities(a Actor) Object {
	has := func(p string) bool { return slices.Contains(a.Permissions, p) }
	return Object{"canManage": has("accounts.type.change") || has("accounts.restriction.apply") || has("accounts.restriction.release"), "canChangeType": has("accounts.type.change"), "canRestrict": has("accounts.restriction.apply"), "canRelease": has("accounts.restriction.release"), "canReadIdentity": has("accounts.identity.read")}
}
