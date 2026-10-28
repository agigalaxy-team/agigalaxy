package messaging

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type Object = map[string]any
type Actor = operationspermissions.Actor
type Reader interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}
type Enqueuer interface {
	EnqueueWithin(context.Context, pgx.Tx, jobs.Task, time.Time) (string, error)
}
type Scheduler interface {
	PreviewSchedule(context.Context, string, string, time.Time, int) ([]time.Time, error)
	ScheduleWithin(context.Context, pgx.Tx, string, string, string, string, jobs.Task, string) error
	UnscheduleWithin(context.Context, pgx.Tx, string, string) error
}
type DirectoryIdentity struct {
	Issuer, ExternalSubject, State, Email string
	Enabled, EmailVerified                bool
}
type DirectoryLookup func(context.Context, string, string) (DirectoryIdentity, error)
type ApprovalAuthority interface {
	PersonWithin(context.Context, pgx.Tx, string, bool) (Actor, error)
}
type ApprovedActor struct {
	Actor                Actor
	Kind                 string
	Context              Object
	ExecutionID, GrantID *string
}
type Service struct {
	Pool               *pgxpool.Pool
	Endpoint           string
	Authority          operationspermissions.Authority
	Jobs               Enqueuer
	Scheduler          Scheduler
	Now                func() time.Time
	Directory          DirectoryLookup
	Mail               *SMTPService
	ContinueAIApproval func(context.Context, pgx.Tx, Object) (ApprovedActor, error)
	Approver           ApprovalAuthority
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}
func failure(code string, status ...int) error {
	n := 409
	if len(status) > 0 {
		n = status[0]
	}
	return fault.New(code, n)
}
func invalidInput() error { return failure("invalid_operations_messaging_request", 400) }
func obj(v any) Object    { x, _ := v.(map[string]any); return x }
func arr(v any) []any     { x, _ := v.([]any); return x }
func str(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	}
	return ""
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
		i, _ := n.Int64()
		return i
	}
	return 0
}
func intOK(v any, min, max int64) bool {
	switch n := v.(type) {
	case int:
		return int64(n) >= min && int64(n) <= max
	case int64:
		return n >= min && n <= max
	case float64:
		return !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && n >= float64(min) && n <= float64(max)
	case json.Number:
		i, e := n.Int64()
		return e == nil && i >= min && i <= max
	}
	return false
}
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func has(a Actor, permission string) bool { return contains(a.Permissions, permission) }
func boolValue(v any) bool                { x, _ := v.(bool); return x }
func list(v any) []string {
	out := []string{}
	for _, value := range arr(v) {
		out = append(out, str(value))
	}
	return out
}
func stringValues(values []string) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = v
	}
	return out
}
func encode(value any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(value)
	return strings.TrimSuffix(b.String(), "\n")
}
func decode(raw []byte) (Object, error) {
	var out Object
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&out) != nil || d.Decode(new(any)) != io.EOF || out == nil {
		return nil, invalidInput()
	}
	return out, nil
}
func keys(value Object, allowed ...string) bool {
	for key := range value {
		if !contains(allowed, key) {
			return false
		}
	}
	return true
}
func required(value Object, fields ...string) bool {
	for _, field := range fields {
		if _, ok := value[field]; !ok {
			return false
		}
	}
	return true
}
func clone(value any) any {
	raw := encode(value)
	d := json.NewDecoder(strings.NewReader(raw))
	d.UseNumber()
	var out any
	_ = d.Decode(&out)
	return out
}
func same(a, b any) bool {
	left, e := identity.Canonical(a)
	right, e2 := identity.Canonical(b)
	return e == nil && e2 == nil && bytes.Equal(left, right)
}
func encodeCanonical(value any) string { raw, _ := json.Marshal(value); return string(raw) }

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func uuidOK(v any) bool { return uuidPattern.MatchString(str(v)) }
func textValue(v any, max int) (string, bool) {
	value, ok := v.(string)
	if !ok {
		return "", false
	}
	value = strings.TrimFunc(value, func(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' })
	if value == "" || utf8.RuneCountInString(value) > max {
		return "", false
	}
	for _, r := range value {
		if r < 32 && r != '\n' && r != '\r' && r != '\t' {
			return "", false
		}
	}
	return value, true
}
func date(value any) (time.Time, error) { return time.Parse(time.RFC3339Nano, str(value)) }
func stamp(value any) any {
	if value == nil || str(value) == "" {
		return nil
	}
	at, e := date(value)
	if e != nil {
		return nil
	}
	return iso(at)
}
func iso(at time.Time) string { return at.UTC().Format("2006-01-02T15:04:05.000Z") }
func one(ctx context.Context, db Reader, query string, args ...any) (Object, error) {
	var raw []byte
	e := db.QueryRow(ctx, query, args...).Scan(&raw)
	if e != nil {
		return nil, e
	}
	return decode(raw)
}
func many(ctx context.Context, db Reader, query string, args ...any) ([]Object, error) {
	rows, e := db.Query(ctx, query, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var raw []byte
		if e = rows.Scan(&raw); e != nil {
			return nil, e
		}
		value, e := decode(raw)
		if e != nil {
			return nil, e
		}
		out = append(out, value)
	}
	return out, rows.Err()
}
func (s *Service) planWithin(ctx context.Context, db Reader, id string, lock bool) (Object, error) {
	if !uuidOK(id) {
		return nil, invalidInput()
	}
	suffix := ""
	if lock {
		suffix = " FOR UPDATE OF p"
	}
	row, e := one(ctx, db, `SELECT to_jsonb(p)||jsonb_build_object('config',v.config) FROM operations_messaging_plans_v1 p JOIN operations_messaging_versions_v1 v ON v.plan_id=p.id AND v.version=p.version WHERE p.id=$1 AND p.endpoint=$2`+suffix, id, s.Endpoint)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, failure("operations_messaging_plan_not_found", 404)
	}
	return row, e
}
func (s *Service) runWithin(ctx context.Context, db Reader, id string, lock bool) (Object, error) {
	if !uuidOK(id) {
		return nil, invalidInput()
	}
	if lock {
		row, e := one(ctx, db, `SELECT jsonb_build_object('planId',plan_id) FROM operations_messaging_runs_v1 WHERE id=$1 AND endpoint=$2`, id, s.Endpoint)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, failure("operations_messaging_run_not_found", 404)
		}
		if e != nil {
			return nil, e
		}
		if _, e = s.planWithin(ctx, db, str(row["planId"]), true); e != nil {
			return nil, e
		}
	}
	suffix := ""
	if lock {
		suffix = " FOR UPDATE OF r"
	}
	row, e := one(ctx, db, `SELECT to_jsonb(r)||jsonb_build_object('config',v.config) FROM operations_messaging_runs_v1 r JOIN operations_messaging_versions_v1 v ON v.plan_id=r.plan_id AND v.version=r.plan_version WHERE r.id=$1 AND r.endpoint=$2`+suffix, id, s.Endpoint)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, failure("operations_messaging_run_not_found", 404)
	}
	return row, e
}
func (s *Service) require(ctx context.Context, tx pgx.Tx, a Actor, permission string) (Actor, error) {
	if s.Authority == nil {
		return Actor{}, failure("operations_authorization_unavailable", 503)
	}
	if a.Endpoint != s.Endpoint {
		return Actor{}, failure("business_admin_denied", 403)
	}
	return s.Authority.RequireWithin(ctx, tx, a, permission)
}
