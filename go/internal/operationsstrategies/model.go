package operationsstrategies

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"math"
	"strings"
	"time"
)

type Object = map[string]any
type Actor = p.Actor
type Effects interface {
	Inspect(context.Context, string, string, []Object) (Object, error)
	InspectWithin(context.Context, pgx.Tx, string, string, []Object) (Object, error)
	Execute(context.Context, Object) (Object, error)
	PriorEffect(context.Context, Object) (Object, error)
	Describe(context.Context, string) (Object, error)
	ReadForAnalysis(context.Context, Object) (Object, error)
}
type Native interface {
	Status(context.Context) (Object, error)
	Start(context.Context, Object) (Object, error)
	Read(context.Context, Object, bool) (Object, error)
	Continue(context.Context, Object, Object) (Object, error)
	Continuation(context.Context, Object, string, bool, *string) (Object, error)
}
type StoredAuthority interface {
	p.StoredPersonAuthority
	Revalidate(context.Context, pgx.Tx, string, string) error
}

type Service struct {
	authorizeWithin        func(context.Context, pgx.Tx, Actor) (Actor, error)
	Pool                   *pgxpool.Pool
	StoredAuthority        StoredAuthority
	RequireExecutionWithin func(context.Context, pgx.Tx, string, bool) error
	Endpoint               string
	Authority              p.Authority
	Duty                   p.DutyAuthority
	Autonomy               *operationsautonomy.Service
	Effects                Effects
	Executor               OrdinaryExecutor
	Native                 Native
	Now                    func() time.Time
	ActionReady            func(string, string) bool
	PreviewObjectWithin    func(context.Context, pgx.Tx, Actor, string, string) (Object, error)
}

var Domains = []string{"overview", "governance", "messaging", "discovery", "maintenance"}
var Modes = []string{"code-automatic", "ai-autonomous", "ai-human-participation", "human-led"}

const WorkflowID = "galaxy-p13-selected-content-v1"

func invalid() error                     { return fault.New("invalid_p13_strategy_request", 400) }
func fail(code string, status int) error { return fault.New(code, status) }
func str(v any) string                   { s, _ := v.(string); return s }
func obj(v any) Object                   { o, _ := v.(map[string]any); return o }
func list(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	out := []any{}
	switch a := v.(type) {
	case []Object:
		for _, v := range a {
			out = append(out, v)
		}
	case []string:
		for _, v := range a {
			out = append(out, v)
		}
	case []int:
		for _, v := range a {
			out = append(out, v)
		}
	}
	return out
}
func array(v any) bool {
	switch v.(type) {
	case []any, []Object, []string, []int:
		return true
	}
	return false
}
func has(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}
func texts(v any) []string {
	out := []string{}
	for _, v := range list(v) {
		out = append(out, str(v))
	}
	return out
}
func clone(o Object) Object {
	x := Object{}
	for k, v := range o {
		x[k] = v
	}
	return x
}
func deepClone(o Object) Object {
	b, _ := json.Marshal(o)
	var x Object
	_ = json.Unmarshal(b, &x)
	return x
}
func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
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
func iso(v any) any {
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
func (s *Service) metadata(o Object) Object {
	at := s.now().Unix()
	o["checkedAt"], o["readExpiresAt"], o["metadataOnly"] = at, at+30, true
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
	var out Object
	e = json.Unmarshal(raw, &out)
	return out, e
}
func (s *Service) domain() *businessadmin.Domain {
	return &businessadmin.Domain{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Duty: s.Duty, Now: s.Now, Permissions: func(action string, _ Object) []string { return []string{action} }}
}

func decode(raw []byte) (Object, error) { var o Object; e := json.Unmarshal(raw, &o); return o, e }

type Writer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}
