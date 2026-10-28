// Package honor recomputes the existing scoped, source-authorized contribution
// projections. It has no editable award ledger or global capability score.
package honor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Actor struct {
	deviceauth.Actor
	HTTPRequestID *string
}
type Service struct {
	Pool            *pgxpool.Pool
	Endpoint        string
	Devices         *deviceauth.Service
	Assistance      *taskmaterials.Service
	Proofs          *evidence.ProofService
	Qualification   *qualification.Service
	Sharing         *contributions.Service
	CI              *civ2.Service
	Now             func() time.Time
	rules           []Object
	registryEnabled bool
}

func fail(code string, status ...int) error {
	n := 409
	if len(status) > 0 {
		n = status[0]
	}
	return fault.New(code, n)
}
func text(v any) string             { s, _ := v.(string); return s }
func str(o Object, k string) string { return text(o[k]) }
func object(v any) Object {
	switch o := v.(type) {
	case Object:
		return o
	case *protocol.OrderedObject:
		return o.Values()
	}
	return nil
}
func array(v any) []any {
	switch a := v.(type) {
	case []any:
		return a
	case []Object:
		out := []any{}
		for _, v := range a {
			out = append(out, v)
		}
		return out
	case []string:
		out := []any{}
		for _, v := range a {
			out = append(out, v)
		}
		return out
	}
	return nil
}
func number(v any) int64 {
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
func has(v any, s string) bool {
	for _, v := range array(v) {
		if v == s {
			return true
		}
	}
	return false
}
func clone(v any) any {
	switch x := v.(type) {
	case json.Number:
		f, _ := x.Float64()
		return f
	case Object:
		o := Object{}
		for k, v := range x {
			o[k] = clone(v)
		}
		return o
	case []any:
		a := []any{}
		for _, v := range x {
			a = append(a, clone(v))
		}
		return a
	}
	return v
}
func ordered(kv ...any) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for i := 0; i < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}
func absent(e error) bool {
	var f *fault.Error
	if !errors.As(e, &f) {
		return false
	}
	switch f.Status {
	case 403, 404, 409, 422, 503:
		return true
	}
	return false
}
func serviceError(e error) bool { var f *fault.Error; return errors.As(e, &f) }
func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var o Object
	e := tx.QueryRow(ctx, sql, args...).Scan(&o)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	return o, e
}
func rows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	r, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	out := []Object{}
	for r.Next() {
		var o Object
		if e = r.Scan(&o); e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, r.Err()
}
func ParseRule(input Object) (Object, error) {
	p, e := community.ParseGovernance(Object{"honorRules": []any{clone(input)}})
	if e != nil {
		return nil, e
	}
	rules := array(p["honorRules"])
	if len(rules) != 1 {
		return nil, fmt.Errorf("invalid Honor rule")
	}
	return object(rules[0]), nil
}
func New(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, rules []Object, now func() time.Time) (*Service, error) {
	s := &Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now, rules: []Object{}}
	seen := map[string]bool{}
	for _, input := range rules {
		p, e := ParseRule(input)
		if e != nil {
			return nil, e
		}
		key := str(p, "id") + "@" + str(p, "version")
		if seen[key] {
			return nil, fmt.Errorf("Duplicate Honor rule")
		}
		seen[key] = true
		s.rules = append(s.rules, p)
	}
	return s, nil
}
func (s *Service) read(ctx context.Context, a *Actor, snapshot bool, fn func(pgx.Tx) (Object, error)) (Object, error) {
	if s == nil || s.Pool == nil || s.Endpoint == "" {
		return nil, fail("honor_unavailable", 503)
	}
	for attempt := 0; ; attempt++ {
		out, e := func() (Object, error) {
			options := pgx.TxOptions{}
			if snapshot {
				options.IsoLevel = pgx.RepeatableRead
			}
			tx, e := s.Pool.BeginTx(ctx, options)
			if e != nil {
				return nil, e
			}
			defer func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = tx.Rollback(cleanup)
			}()
			if a != nil {
				if s.Devices == nil {
					return nil, fail("honor_unavailable", 503)
				}
				if e = s.Devices.AuthorizeWithin(ctx, tx, a.Actor, "history"); e != nil {
					return nil, e
				}
			}
			out, e := fn(tx)
			if e != nil {
				return nil, e
			}
			if e = tx.Commit(ctx); e != nil {
				return nil, e
			}
			return out, nil
		}()
		if e == nil {
			return out, nil
		}
		var pg *pgconn.PgError
		if !snapshot || !errors.As(e, &pg) || pg.Code != "40001" {
			return nil, e
		}
		if attempt >= 1 {
			return nil, fail("honor_sources_changed_retry")
		}
	}
}
