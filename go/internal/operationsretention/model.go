// Package operationsretention preserves the original bounded operations
// cleanup requests. It never changes an owner's expiry or creates a new TTL.
package operationsretention

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
	"time"
)

type Object = map[string]any
type Actor = p.Actor
type StoredAuthority interface {
	p.StoredPersonAuthority
	Revalidate(context.Context, pgx.Tx, string, string) error
}
type Service struct {
	Pool            *pgxpool.Pool
	Endpoint        string
	Authority       p.Authority
	StoredAuthority StoredAuthority
	EnqueueWithin   func(context.Context, pgx.Tx, string) (string, error)
	CleanWithin     func(context.Context, pgx.Tx, string, int64) (Object, error)
	Now             func() time.Time
}

const PolicyVersion = "galaxy-retention/v1-product-v2"

var targets = []string{"private-conversation-archives", "data-exports", "information-watches"}

func fail(code string, status int) error { return fault.New(code, status) }
func invalid() error                     { return fail("invalid_operations_product_request", 400) }
func str(v any) string                   { s, _ := v.(string); return s }
func obj(v any) Object                   { o, _ := v.(map[string]any); return o }
func has(v []string, s string) bool {
	for _, x := range v {
		if x == s {
			return true
		}
	}
	return false
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
func integer(v any, min, max int64) bool {
	var n float64
	switch v := v.(type) {
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	case float64:
		n = v
	case json.Number:
		n, _ = v.Float64()
	default:
		return false
	}
	return !math.IsInf(n, 0) && !math.IsNaN(n) && math.Trunc(n) == n && n >= float64(min) && n <= float64(max)
}
func same(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
func clone(o Object) Object {
	out := Object{}
	for k, v := range o {
		out[k] = v
	}
	return out
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
func (s *Service) domain() *businessadmin.Domain {
	return &businessadmin.Domain{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Now: s.Now, Permissions: func(action string, _ Object) []string {
		if action == "retention-request" {
			return []string{"retention.request"}
		}
		return nil
	}}
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
	var out Object
	e = json.Unmarshal(raw, &out)
	return out, e
}
func collect(rows pgx.Rows) ([]Object, error) {
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var raw []byte
		if e := rows.Scan(&raw); e != nil {
			return nil, e
		}
		var o Object
		if e := json.Unmarshal(raw, &o); e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
func view(r Object) Object {
	return Object{"id": r["id"], "target": r["target"], "state": r["state"], "requestedBy": r["requested_by"], "attempts": r["attempts"], "result": r["result"], "errorCode": r["error_code"], "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"]), "finishedAt": iso(r["finished_at"]), "jobId": r["job_id"]}
}
