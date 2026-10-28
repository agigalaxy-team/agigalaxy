package maintenance

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"math"
	"strings"
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
	Pool             *pgxpool.Pool
	Endpoint         string
	Authority        p.Authority
	StoredAuthority  StoredAuthority
	Duty             p.DutyAuthority
	PrincipalWithin  func(context.Context, pgx.Tx, Actor) error
	Native           Native
	IncidentSnapshot func() Object
	QueueSnapshot    func(context.Context) (Object, error)
	ChatProbe        func(context.Context) (Object, error)
	Now              func() time.Time
}

func catalog() Object             { var c Object; _ = json.Unmarshal([]byte(catalogJSON), &c); return c }
func ModuleIDs() []string         { return texts(catalog()["maintenanceModuleIds"]) }
func OpeningConditions() []string { return texts(catalog()["maintenanceOpeningConditions"]) }
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func (s *Service) envelope(o Object) Object {
	o["checkedAt"] = s.now().Unix()
	o["readExpiresAt"] = s.now().Unix() + 30
	o["metadataOnly"] = true
	return o
}
func invalid() error                        { return fault.New("invalid_maintenance_request", 400) }
func failure(code string, status int) error { return fault.New(code, status) }
func str(v any) string                      { s, _ := v.(string); return s }
func obj(v any) Object                      { o, _ := v.(map[string]any); return o }
func list(v any) []any {
	a, _ := v.([]any)
	if a == nil {
		if rows, ok := v.([]Object); ok {
			a = []any{}
			for _, r := range rows {
				a = append(a, r)
			}
		}
		if rows, ok := v.([]string); ok {
			a = []any{}
			for _, r := range rows {
				a = append(a, r)
			}
		}
	}
	return a
}
func array(v any) bool {
	switch v.(type) {
	case []any, []Object, []string:
		return true
	}
	return false
}
func texts(v any) []string {
	out := []string{}
	for _, v := range list(v) {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
func includes(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}
func clone(v Object) Object {
	o := Object{}
	for k, v := range v {
		o[k] = v
	}
	return o
}
func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func whole(v any, min, max int64) bool {
	var f float64
	switch n := v.(type) {
	case int:
		f = float64(n)
	case int64:
		f = float64(n)
	case float64:
		f = n
	case json.Number:
		var e error
		f, e = n.Float64()
		if e != nil {
			return false
		}
	default:
		return false
	}
	return !math.IsNaN(f) && !math.IsInf(f, 0) && f == math.Trunc(f) && f >= float64(min) && f <= float64(max)
}
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
	r, e := one(ctx, q, sql, args...)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return r, e
}
func within(ctx context.Context, pool *pgxpool.Pool, f func(pgx.Tx) error) error {
	_, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) { return true, f(tx) })
	return e
}
func (s *Service) domain() *businessadmin.Domain {
	return &businessadmin.Domain{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Duty: s.Duty, PrincipalWithin: s.PrincipalWithin, Permissions: func(action string, _ Object) []string {
		permission := str(obj(catalog()["maintenanceActionPermissions"])[action])
		if permission == "" {
			return nil
		}
		return []string{permission}
	}, Now: s.Now}
}
