// Package notifications owns the existing personal business-source Inbox.
// Official messaging plans and SMTP delivery remain separate consumers.
package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Actor struct {
	deviceauth.Actor
	HTTPRequestID *string
}
type SourceReader func(context.Context, pgx.Tx, deviceauth.Actor, Object) (Object, error)
type CurrentReaders struct{ Chat, Task, Comment, CommentGovernance, Qualification, Information, TargetGovernance, Moderation, Assistance, Context, Capsule SourceReader }
type Service struct {
	Pool      *pgxpool.Pool
	Endpoint  string
	Devices   *deviceauth.Service
	Now       func() time.Time
	Resources *resourcebudget.Service
	Readers   CurrentReaders
	// Match the original configured incident processing gate; this never grants
	// a source read or starts an external delivery transport.
	EvidenceBlocked func() bool
}

func fail(code string, status ...int) error {
	value := 409
	if len(status) > 0 {
		value = status[0]
	}
	return fault.New(code, value)
}
func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func stamp(v int64) string          { return time.Unix(v, 0).UTC().Format("2006-01-02T15:04:05.000Z") }
func text(v any) string             { s, _ := v.(string); return s }
func str(v Object, k string) string { return text(v[k]) }
func object(v any) Object           { x, _ := v.(map[string]any); return x }
func num(v any) int64 {
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
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	}
	return 0
}
func boolean(v any) bool { x, _ := v.(bool); return x }
func contains(v []string, s string) bool {
	for _, value := range v {
		if value == s {
			return true
		}
	}
	return false
}
func array(v any) []any { x, _ := v.([]any); return x }
func stringsOf(v any) []string {
	switch x := v.(type) {
	case []string:
		return x
	case []any:
		out := []string{}
		for _, v := range x {
			out = append(out, text(v))
		}
		return out
	}
	return nil
}
func encode(v any) []byte { b, _ := protocol.Encode(v); return b }
func shape(v Object, required, optional []string) bool {
	for key, value := range v {
		if value == nil || !contains(required, key) && !contains(optional, key) {
			return false
		}
	}
	for _, key := range required {
		if _, ok := v[key]; !ok {
			return false
		}
	}
	return true
}
func integer(v any, min, max int64) bool {
	n := num(v)
	if n < min || n > max {
		return false
	}
	switch x := v.(type) {
	case int, int64:
		return true
	case float64:
		return x == float64(n)
	case json.Number:
		f, e := x.Float64()
		return e == nil && f == float64(n)
	}
	return false
}

var uuidPattern = regexp.MustCompile(`(?i)^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)

func validID(v string) bool { return uuidPattern.MatchString(v) }
func iso(v any) string {
	t, e := time.Parse(time.RFC3339Nano, text(v))
	if e != nil {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func milliseconds(v any) int64 {
	t, e := time.Parse(time.RFC3339Nano, text(v))
	if e != nil {
		return 0
	}
	return t.UnixMilli()
}
func one(ctx context.Context, tx pgx.Tx, query string, args ...any) (Object, error) {
	var result Object
	e := tx.QueryRow(ctx, query, args...).Scan(&result)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return result, e
}
func many(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]Object, error) {
	r, e := tx.Query(ctx, query, args...)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	result := []Object{}
	for r.Next() {
		var row Object
		if e = r.Scan(&row); e != nil {
			return nil, e
		}
		result = append(result, row)
	}
	return result, r.Err()
}
func (s *Service) run(ctx context.Context, a Actor, write bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (any, error)) (any, error) {
	if s == nil || s.Pool == nil || s.Devices == nil || s.Endpoint == "" || s.Endpoint != s.Devices.Endpoint {
		return nil, fail("notification_service_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (any, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func(ctx context.Context, tx pgx.Tx) error {
			var e error
			auth, e = s.Devices.CurrentControlWithin(ctx, tx, a.Actor, "notifications")
			return e
		}
		if write {
			resource := s.Resources
			if resource == nil {
				resource, _ = resourcebudget.New(nil, s.Now)
			}
			return resource.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.SubjectID}, authorize, func(context.Context, pgx.Tx) (any, error) { return fn(tx, auth) }, resourcebudget.Options{})
		}
		if e := authorize(ctx, tx); e != nil {
			return nil, e
		}
		return fn(tx, auth)
	})
}
func key(c Object) string { return str(c, "kind") + ":" + str(c, "event_id") }
func locator(id string, legacy bool) (string, string, error) {
	kind, eventID, ok := strings.Cut(id, ":")
	kinds := []string{"assistance", "context", "context-accept", "capsule", "incident"}
	if !legacy {
		kinds = append(kinds, "moderation-report", "moderation-event", "target-governance", "information-change", "qualification-request", "room-message", "room-invite", "task-v2", "task-comment", "comment-governance")
	}
	if !ok || !contains(kinds, kind) || strings.ToLower(eventID) != eventID || !validID(eventID) {
		return "", "", fail("invalid_inbox_request", 400)
	}
	return kind, eventID, nil
}

// IsBlockedWithin is the original symmetric current blocked-subject check.
// A business caller must authorize its real source before consuming this port.
func (s *Service) IsBlockedWithin(ctx context.Context, tx pgx.Tx, viewerID, candidateID string) (bool, error) {
	if viewerID == "" || candidateID == "" {
		return false, nil
	}
	var blocked bool
	e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM notification_options_v2 WHERE (subject_id=$1 AND settings->'blockedSubjectIds' ? $2) OR (subject_id=$2 AND settings->'blockedSubjectIds' ? $1))`, viewerID, candidateID).Scan(&blocked)
	return blocked, e
}
