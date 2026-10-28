// Package contributions owns explicit bounded publication of already-authored
// source fields. It does not change the original Task or Case permissions.
package contributions

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Actor struct {
	deviceauth.Actor
	HTTPRequestID *string
}
type Service struct {
	Pool      *pgxpool.Pool
	Endpoint  string
	Devices   *deviceauth.Service
	Resources *resourcebudget.Service
	Tasks     *taskmaterials.Service
	Now       func() time.Time
}
type Permission struct {
	Original               deviceauth.ConsentIntent
	PublicationIDs, Fields []string
	FieldExpiresAt         map[string]float64
}

var ProjectionFields = []string{"eventType", "actorId", "role", "interventionTypes", "scopeVersion", "reportedOutcome", "feedback", "scope", "title", "summary", "time", "caseId", "taskId", "participationId"}

const PublicationScope = "selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged"

func fail(code string, status ...int) error {
	n := 403
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
	switch x := v.(type) {
	case int:
		return int64(x)
	case int64:
		return x
	case float64:
		return int64(x)
	case json.Number:
		f, _ := x.Float64()
		return int64(f)
	}
	return 0
}
func has(values []string, s string) bool {
	for _, v := range values {
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
func absent(e error) bool {
	var f *fault.Error
	return errors.As(e, &f) && (f.Status == 403 || f.Status == 404 || f.Status == 409 || f.Status == 422)
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
func (s *Service) visible(g deviceauth.ConsentIntent, a *deviceauth.Actor) bool {
	if g.IssuedAt > s.now() || g.ExpiresAt <= s.now() {
		return false
	}
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	if viewer == g.SubjectID {
		return true
	}
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
		return false
	}
	if g.Visibility == "Public" {
		return g.Purpose == "public-profile"
	}
	return g.Visibility == "Private" && viewer != "" && has(g.Viewers, viewer)
}
func (s *Service) run(ctx context.Context, a *Actor, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (any, error)) (any, error) {
	if write && a != nil {
		if e := deviceauth.CheckInformationWatchWrite(a.Actor, "history"); e != nil {
			return nil, e
		}
	}
	if s == nil || s.Pool == nil || s.Endpoint == "" || s.Devices == nil || s.Endpoint != s.Devices.Endpoint {
		return nil, fail("contribution_unavailable", 503)
	}
	if write && a == nil {
		return nil, fail("access_denied", 401)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (any, error) {
		var auth deviceauth.ControlAuthorization
		if a == nil {
			return fn(tx, auth)
		}
		authorize := func(ctx context.Context, tx pgx.Tx) error {
			var e error
			auth, e = s.Devices.CurrentControlWithin(ctx, tx, a.Actor, "history")
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
