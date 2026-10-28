// Package operationsrules owns the existing P14 policy drafts, publications,
// samples and process adoption ledger. It does not grant business authority.
package operationsrules

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
	"time"
)

type Object = map[string]any
type Actor = p.Actor
type Service struct {
	authorizeWithin func(context.Context, pgx.Tx, Actor) (Actor, error)
	Pool            *pgxpool.Pool
	Endpoint        string
	Authority       p.Authority
	Now             func() time.Time
}

var Keys = []string{"resource-budget", "community-quota", "forum-quota", "business-controls"}
var Targets = []string{"forum-post", "forum-reply", "chat-message", "forum-upload", "chat-upload"}

func invalid() error                     { return fault.New("invalid_operations_rule_request", 400) }
func fail(code string, status int) error { return fault.New(code, status) }
func str(v any) string                   { s, _ := v.(string); return s }
func obj(v any) Object                   { o, _ := v.(map[string]any); return o }
func list(v any) []any {
	switch a := v.(type) {
	case []any:
		return a
	case []Object:
		out := make([]any, len(a))
		for i, v := range a {
			out[i] = v
		}
		return out
	case []string:
		out := make([]any, len(a))
		for i, v := range a {
			out[i] = v
		}
		return out
	}
	return nil
}
func array(v any) bool {
	switch v.(type) {
	case []any, []Object, []string:
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
func closed(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	for k := range o {
		if !has(required, k) && !has(optional, k) {
			return false
		}
	}
	return true
}
func integer(v any, min, max int64) bool {
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
	return !math.IsNaN(f) && !math.IsInf(f, 0) && math.Trunc(f) == f && f >= float64(min) && f <= float64(max)
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
func same(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
func clone(o Object) Object {
	x := Object{}
	for k, v := range o {
		x[k] = v
	}
	return x
}
func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
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

func one(ctx context.Context, q Reader, sql string, args ...any) (Object, error) {
	var raw []byte
	e := q.QueryRow(ctx, sql, args...).Scan(&raw)
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
	return &businessadmin.Domain{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Now: s.Now}
}
