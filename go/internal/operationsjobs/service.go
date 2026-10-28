// Package operationsjobs owns the original authorized queue controls and audit.
// River IDs are never public IDs and cancelling transport never undoes effects.
package operationsjobs

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsretention"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type Object = map[string]any
type Actor = p.Actor

// JobRead returns the original public queue view plus verified actual source
// arguments. Lock serializes commands with the real transport completion row.
type JobRead func(context.Context, pgx.Tx, string, string, string, bool) (Object, jobs.Task, error)
type JobList func(context.Context, string, string, string, int) (Object, error)
type Cancellation func(context.Context, pgx.Tx, Actor, jobs.Task) error
type Service struct {
	Pool                *pgxpool.Pool
	Endpoint            string
	Authority           p.Authority
	Duty                p.DutyAuthority
	Now                 func() time.Time
	Queue               *jobs.Queue
	Watches             *information.Watches
	Retention           *operationsretention.Service
	ReadJobWithin       JobRead
	ListJobs            JobList
	Search              *discovery.LegacyIndex
	SearchQualifyWithin func(context.Context, pgx.Tx, string, int64) error
	// Only owning domain consumers may occupy these original cancellation slots.
	Cancellations map[string]Cancellation
}

var Queues = []string{"information-watch", "search-recovery", "content-publication", "account-notice", "retention-cleanup", "messaging-run", "messaging-delivery", "autonomy-task", "autonomy-tick"}
var aiQueues = Queues[:7]
var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func fail(code string, status int) error { return fault.New(code, status) }
func text(v any) string                  { s, _ := v.(string); return s }
func object(v any) Object                { o, _ := v.(map[string]any); return o }
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
func integer(v any, min int64) bool {
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
	return !math.IsNaN(f) && !math.IsInf(f, 0) && math.Trunc(f) == f && f >= float64(min) && f <= 9007199254740991
}
func has(values []string, v string) bool {
	for _, x := range values {
		if x == v {
			return true
		}
	}
	return false
}
func trim(v string) string {
	return strings.Trim(v, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func exact(o Object, keys ...string) bool {
	if o == nil || len(o) != len(keys) {
		return false
	}
	for _, k := range keys {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	return true
}
func (s *Service) domain() *businessadmin.Domain {
	return &businessadmin.Domain{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Duty: s.Duty, Now: s.Now, Permissions: func(action string, _ Object) []string {
		switch action {
		case "job-cancel":
			return []string{"jobs.cancel"}
		case "job-retry":
			return []string{"jobs.retry"}
		case "search-retry":
			return []string{"search.retry"}
		}
		return nil
	}}
}
func domainPermission(queue, kind string) string {
	switch queue {
	case "content-publication":
		return "cms.publish"
	case "account-notice", "messaging-run", "messaging-delivery":
		if kind == "job-cancel" {
			return "notices.withdraw"
		}
		return "notices.publish"
	case "retention-cleanup":
		return "retention.request"
	case "search-recovery":
		return "search.retry"
	}
	return ""
}
func permission(kind string) string {
	if kind == "search-retry" {
		return "search.retry"
	}
	if kind == "job-cancel" {
		return "jobs.cancel"
	}
	return "jobs.retry"
}
func readPermission(kind string) string {
	if kind == "search-retry" {
		return "search.read"
	}
	return "jobs.read"
}
func request(kind string, r Object) error {
	if !has([]string{"job-cancel", "job-retry", "search-retry"}, kind) || !uuidPattern.MatchString(text(r["targetId"])) || kind != "search-retry" && !has(aiQueues, text(r["queue"])) {
		return fail("invalid_operations_job_action", 400)
	}
	return nil
}
func ParseCommand(kind string, input Object) (Object, error) {
	keys := []string{"operationId", "expectedState", "expectedRetryCount", "reason"}
	if kind == "search-retry" {
		keys = []string{"operationId", "expectedGeneration", "reason"}
	}
	if !has([]string{"job-cancel", "job-retry", "search-retry"}, kind) || !exact(input, keys...) || !uuidPattern.MatchString(text(input["operationId"])) {
		return nil, fail("invalid_operations_job_action", 400)
	}
	reason, ok := input["reason"].(string)
	reason = trim(reason)
	if !ok || utf8.RuneCountInString(reason) < 3 || utf8.RuneCountInString(reason) > 1600 {
		return nil, fail("invalid_operations_job_action", 400)
	}
	out := Object{}
	for k, v := range input {
		out[k] = v
	}
	out["reason"] = reason
	if kind == "search-retry" {
		if !integer(input["expectedGeneration"], 1) {
			return nil, fail("invalid_operations_job_action", 400)
		}
	} else if state, ok := input["expectedState"].(string); !ok || utf8.RuneCountInString(state) < 1 || utf8.RuneCountInString(state) > 32 || !integer(input["expectedRetryCount"], 0) {
		return nil, fail("invalid_operations_job_action", 400)
	}
	return out, nil
}
func (s *Service) job(ctx context.Context, tx pgx.Tx, queue, id string, lock bool) (Object, jobs.Task, error) {
	read := s.ReadJobWithin
	if read == nil && s.Queue != nil {
		read = s.Queue.OperationWithin
	}
	if read == nil {
		return nil, jobs.Task{}, fail("operations_jobs_unavailable", 503)
	}
	v, t, e := read(ctx, tx, s.Endpoint, queue, id, lock)
	if e != nil || v == nil {
		return v, t, e
	}
	if t.ID != id || t.Endpoint != s.Endpoint || t.Action != queue || v["id"] != id || v["queue"] != queue {
		return nil, t, fail("operations_job_source_changed", 409)
	}
	return v, t, nil
}
func (s *Service) List(ctx context.Context, a Actor, queue, after string, limit int) (Object, error) {
	if !has(Queues, queue) || after != "" && !uuidPattern.MatchString(after) || limit < 1 || limit > 100 {
		return nil, fail("invalid_operations_query", 400)
	}
	list := s.ListJobs
	if list == nil && s.Queue != nil {
		list = s.Queue.ListOperations
	}
	if list == nil {
		return nil, fail("operations_jobs_unavailable", 503)
	}
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.domain().Fresh(ctx, tx, a, "jobs.read") })
	if e != nil {
		return nil, e
	}
	page, e := list(ctx, s.Endpoint, queue, after, limit)
	if e != nil {
		return nil, e
	}
	out := Object{"queue": queue}
	for k, v := range page {
		out[k] = v
	}
	return out, nil
}
func (s *Service) Get(ctx context.Context, a Actor, queue, id string) (Object, error) {
	if !has(aiQueues, queue) || !uuidPattern.MatchString(id) {
		return nil, fail("invalid_operations_query", 400)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.domain().Fresh(ctx, tx, a, "jobs.read"); e != nil {
			return nil, e
		}
		v, _, e := s.job(ctx, tx, queue, id, false)
		return Object{"job": v}, e
	})
}
func (s *Service) Read(ctx context.Context, a Actor, kind string, r Object) (Object, error) {
	if e := request(kind, r); e != nil {
		return nil, e
	}
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.domain().Fresh(ctx, tx, a, readPermission(kind)) })
	if e != nil {
		return nil, e
	}
	var v Object
	if kind == "search-retry" {
		if s.Search == nil {
			return nil, fail("operations_search_unavailable", 503)
		}
		v, e = s.Search.FailureStatus(ctx, text(r["targetId"]))
	} else {
		out, err := s.Get(ctx, a, text(r["queue"]), text(r["targetId"]))
		e = err
		v = object(out["job"])
	}
	if e == nil && v == nil {
		e = fail("operations_job_not_found", 404)
	}
	return v, e
}
func (s *Service) SearchFailures(ctx context.Context, a Actor, after string, limit int) (Object, error) {
	if s.Search == nil {
		return nil, fail("operations_search_unavailable", 503)
	}
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.domain().Fresh(ctx, tx, a, "search.read") })
	if e != nil {
		return nil, e
	}
	return s.Search.Failures(ctx, after, limit)
}
func (s *Service) SearchFailure(ctx context.Context, a Actor, id string) (Object, error) {
	if s.Search == nil {
		return nil, fail("operations_search_unavailable", 503)
	}
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.domain().Fresh(ctx, tx, a, "search.read") })
	if e != nil {
		return nil, e
	}
	v, e := s.Search.FailureStatus(ctx, id)
	return Object{"job": v}, e
}
func equal(a, b any) bool {
	x, e := identity.Canonical(a)
	y, f := identity.Canonical(b)
	return e == nil && f == nil && string(x) == string(y)
}
