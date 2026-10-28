// Package experiencereviews owns author declarations and registered scoped
// reviewer reports. These are not automatic external or capability verification.
package experiencereviews

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
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
	Resources       *resourcebudget.Service
	Links           *accountlinks.Service
	Now             func() time.Time
	reviewers       []Object
	registryEnabled bool
}

func fail(code string, status ...int) error {
	n := 409
	if len(status) > 0 {
		n = status[0]
	}
	return fault.New(code, n)
}
func text(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case jstext.String:
		return x.Decoded()
	}
	return ""
}
func str(o Object, k string) string { return text(o[k]) }
func object(v any) Object           { o, _ := v.(map[string]any); return o }
func array(v any) []any             { a, _ := v.([]any); return a }
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
func closed(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	allowed := map[string]bool{}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
		allowed[k] = true
	}
	for _, k := range optional {
		allowed[k] = true
	}
	for k := range o {
		if !allowed[k] {
			return false
		}
	}
	return true
}
func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func unavailable(e error) bool {
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
func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var v Object
	e := tx.QueryRow(ctx, sql, args...).Scan(&v)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	return v, e
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
func ParseReviewer(input Object) (Object, error) {
	parsed, e := community.ParseGovernance(Object{"experienceReviewers": []any{clone(input)}})
	if e != nil {
		return nil, e
	}
	values := array(parsed["experienceReviewers"])
	if len(values) != 1 {
		return nil, fmt.Errorf("invalid experience reviewer")
	}
	return object(values[0]), nil
}
func New(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, reviewers []Object, now func() time.Time) (*Service, error) {
	s := &Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now, reviewers: []Object{}}
	seen := map[string]bool{}
	for _, input := range reviewers {
		p, e := ParseReviewer(input)
		if e != nil {
			return nil, e
		}
		id := str(p, "subjectId")
		if seen[id] {
			return nil, fmt.Errorf("Duplicate experience reviewer")
		}
		seen[id] = true
		s.reviewers = append(s.reviewers, p)
	}
	return s, nil
}
func (s *Service) run(ctx context.Context, a Actor, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (any, error)) (any, error) {
	if write {
		if e := deviceauth.CheckInformationWatchWrite(a.Actor, "assistance"); e != nil {
			return nil, e
		}
	}
	if s == nil || s.Pool == nil || s.Devices == nil || s.Endpoint == "" || s.Endpoint != s.Devices.Endpoint {
		return nil, fail("experience_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (any, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func(ctx context.Context, tx pgx.Tx) error {
			var e error
			auth, e = s.Devices.CurrentControlWithin(ctx, tx, a.Actor, "assistance")
			return e
		}
		if write {
			budget := s.Resources
			if budget == nil {
				budget, _ = resourcebudget.New(nil, s.Now)
			}
			return budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.SubjectID}, authorize, func(context.Context, pgx.Tx) (any, error) { return fn(tx, auth) }, resourcebudget.Options{Control: control})
		}
		if e := authorize(ctx, tx); e != nil {
			return nil, e
		}
		return fn(tx, auth)
	})
}
func (s *Service) controller(ctx context.Context, tx pgx.Tx, subject string) (string, error) {
	if s.Links == nil {
		return "", fail("experience_controller_unavailable", 503)
	}
	linked, e := s.Links.ResolveControllerAccountWithin(ctx, tx, subject)
	if e != nil {
		if fault.Code(e) == "account_verification_required" {
			return "", nil
		}
		return "", e
	}
	return str(linked, "id"), nil
}
func (s *Service) independent(ctx context.Context, tx pgx.Tx, a, b string) error {
	if a == b {
		return fail("experience_nonparty_reviewer_required", 403)
	}
	left, e := s.controller(ctx, tx, a)
	if e != nil {
		return e
	}
	right, e := s.controller(ctx, tx, b)
	if e != nil {
		return e
	}
	if left != "" && right != "" && left == right {
		return fail("experience_nonparty_reviewer_required", 403)
	}
	return nil
}
