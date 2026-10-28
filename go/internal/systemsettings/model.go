// Package systemsettings owns the existing durable settings intents and host
// readback. Saved drafts and acknowledged consumer adoption remain distinct.
package systemsettings

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
	"sync"
	"time"
)

type Object = map[string]any
type Actor = p.Actor
type Native interface {
	Call(context.Context, Object) (Object, error)
}
type StoredAuthority interface {
	p.StoredPersonAuthority
	Revalidate(context.Context, pgx.Tx, string, string) error
}
type Service struct {
	Pool            *pgxpool.Pool
	Endpoint        string
	Authority       p.Authority
	StoredAuthority StoredAuthority
	Native          Native
	Now             func() time.Time
	reconcileMu     sync.Mutex
	reconciling     map[string]*reconciliation
}
type MailBridge struct {
	Settings *Service
	SMTP     *messaging.SMTPService
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
func (s *Service) stamp(o Object) Object {
	o["checkedAt"] = s.now().Unix()
	o["readExpiresAt"] = s.now().Unix() + 30
	o["metadataOnly"] = true
	return o
}
func fail(code string, status int) error { return fault.New(code, status) }
func invalid() error                     { return fail("invalid_system_settings_request", 400) }
func str(v any) string                   { s, _ := v.(string); return s }
func obj(v any) Object                   { o, _ := v.(map[string]any); return o }
func list(v any) []any                   { a, _ := v.([]any); return a }
func num(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	}
	return 0
}
func clone(o Object) Object {
	out := Object{}
	for k, v := range o {
		out[k] = v
	}
	return out
}
func same(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func iso(v any) any {
	if v == nil {
		return nil
	}
	if t, ok := v.(time.Time); ok {
		return stamp(t)
	}
	if t, e := time.Parse(time.RFC3339Nano, str(v)); e == nil {
		return stamp(t)
	}
	return nil
}
func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}

type Reader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func one(ctx context.Context, q Reader, sql string, args ...any) (Object, error) {
	var b []byte
	if e := q.QueryRow(ctx, sql, args...).Scan(&b); e != nil {
		return nil, e
	}
	var o Object
	e := json.Unmarshal(b, &o)
	return o, e
}
func optional(ctx context.Context, q Reader, sql string, args ...any) (Object, error) {
	o, e := one(ctx, q, sql, args...)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return o, e
}
func within(ctx context.Context, pool *pgxpool.Pool, f func(pgx.Tx) error) error {
	_, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) { return true, f(tx) })
	return e
}
func (s *Service) lock(ctx context.Context, tx pgx.Tx, section string) error {
	_, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912461))", s.Endpoint+":"+section)
	return e
}
func (s *Service) operationLock(ctx context.Context, tx pgx.Tx, id string) error {
	_, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912462))", s.Endpoint+":"+id)
	return e
}
func (s *Service) head(ctx context.Context, q Reader, section string) (Object, error) {
	r, e := optional(ctx, q, "SELECT to_jsonb(h) FROM operations_system_settings_heads_v1 h WHERE endpoint=$1 AND section=$2", s.Endpoint, section)
	if e == nil && r == nil {
		r = Object{"revision": 0, "version_id": nil, "pending_operation": nil}
	}
	return r, e
}
func (s *Service) version(ctx context.Context, q Reader, id any, section string) (Object, error) {
	if id == nil {
		return nil, nil
	}
	return optional(ctx, q, "SELECT to_jsonb(v) FROM operations_system_settings_versions_v1 v WHERE endpoint=$1 AND id=$2 AND section=$3", s.Endpoint, id, section)
}
func (s *Service) row(ctx context.Context, q Reader, id string) (Object, error) {
	return optional(ctx, q, "SELECT to_jsonb(c) FROM operations_system_settings_commands_v1 c WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, id)
}
func (s *Service) require(ctx context.Context, tx pgx.Tx, a Actor, action string) (Actor, error) {
	queryAllowed := false
	if q, ok := s.Authority.(interface{ AcceptsQuery(Actor) bool }); ok {
		queryAllowed = q.AcceptsQuery(a)
	}
	if s.Authority == nil || a.AIProof != nil && !queryAllowed {
		return Actor{}, fail("system_settings_permission_denied", 403)
	}
	return s.Authority.RequireWithin(ctx, tx, a, action)
}
func (s *Service) current(ctx context.Context, a Actor, action string) (Actor, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.require(ctx, tx, a, action) })
}
func (s *Service) fresh(ctx context.Context, tx pgx.Tx, a Actor, action string, authorize func() (Actor, error)) (Actor, error) {
	if authorize == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	actor, e := authorize()
	if e != nil {
		return Actor{}, e
	}
	if actor.ID != a.ID || actor.Endpoint != s.Endpoint {
		return Actor{}, fail("business_admin_denied", 403)
	}
	return s.require(ctx, tx, actor, action)
}
func (s *Service) freshOutside(ctx context.Context, a Actor, action string, authorize func() (Actor, error)) (Actor, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.fresh(ctx, tx, a, action, authorize) })
}
