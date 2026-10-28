package operationsmodels

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"math"
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
	mu              sync.Mutex
	reconciling     map[string]*reconciliation
}
type reconciliation struct {
	done chan struct{}
	row  Object
	err  error
}

var Domains = []string{"overview", "governance", "messaging", "discovery", "maintenance"}
var Formats = []string{"openai-chat", "openai-responses", "anthropic", "gemini"}
var Efforts = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

func invalid() error             { return fault.New("invalid_model_settings_request", 400) }
func fail(c string, s int) error { return fault.New(c, s) }
func str(v any) string           { s, _ := v.(string); return s }
func obj(v any) Object           { o, _ := v.(map[string]any); return o }
func list(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	out := []any{}
	if a, ok := v.([]Object); ok {
		for _, v := range a {
			out = append(out, v)
		}
	}
	if a, ok := v.([]string); ok {
		for _, v := range a {
			out = append(out, v)
		}
	}
	return out
}
func isArray(v any) bool {
	switch v.(type) {
	case []any, []Object, []string:
		return true
	}
	return false
}
func has(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}
func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func clone(o Object) Object {
	x := Object{}
	for k, v := range o {
		x[k] = v
	}
	return x
}
func integer(v any, min, max int64) bool {
	f := float64(0)
	switch v := v.(type) {
	case int:
		f = float64(v)
	case int64:
		f = float64(v)
	case float64:
		f = v
	case json.Number:
		var e error
		f, e = v.Float64()
		if e != nil {
			return false
		}
	default:
		return false
	}
	return !math.IsNaN(f) && !math.IsInf(f, 0) && f == math.Trunc(f) && f >= float64(min) && f <= float64(max)
}
func num(v any) int64 {
	switch v := v.(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		f, _ := v.Float64()
		return int64(f)
	}
	return 0
}
func same(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func stamp(v any) any {
	if v == nil {
		return nil
	}
	if t, ok := v.(time.Time); ok {
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	t, e := time.Parse(time.RFC3339Nano, str(v))
	if e != nil {
		return nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func (s *Service) envelope(o Object) Object {
	o["checkedAt"] = s.now().Unix()
	o["readExpiresAt"] = s.now().Unix() + 30
	o["metadataOnly"] = true
	return o
}

type Reader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func one(ctx context.Context, q Reader, query string, args ...any) (Object, error) {
	var raw []byte
	e := q.QueryRow(ctx, query, args...).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var o Object
	e = json.Unmarshal(raw, &o)
	return o, e
}
func (s *Service) domain() *businessadmin.Domain {
	return &businessadmin.Domain{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Now: s.Now, Permissions: func(action string, _ Object) []string { return []string{action} }}
}
func (s *Service) require(ctx context.Context, tx pgx.Tx, a Actor, permission string) (Actor, error) {
	if a.AIProof != nil || s.domain().IsDuty(a) {
		return Actor{}, fail("model_settings_human_required", 403)
	}
	if s.Authority == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	return s.Authority.RequireWithin(ctx, tx, a, permission)
}

func decode(raw []byte) (Object, error) { var o Object; e := json.Unmarshal(raw, &o); return o, e }
