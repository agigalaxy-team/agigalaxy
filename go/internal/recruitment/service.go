// Package recruitment owns existing signed long-term role requirements.
package recruitment

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Object = map[string]any
type Actor struct {
	Device    *deviceauth.Actor
	RequestID string
}
type TaskReader interface {
	RequireTaskWithin(context.Context, pgx.Tx, *deviceauth.Actor, string, bool) (map[string]any, error)
}
type Service struct {
	Pool          *pgxpool.Pool
	Endpoint      string
	Devices       *deviceauth.Service
	Projects      *projects.Service
	Opportunities *opportunities.Service
	Tasks         TaskReader
	Inbox         *notifications.Service
	PublicWrites  *publicwrites.Service
	Resources     *resourcebudget.Service
	Now           func() time.Time
}

func fail(code string, status int) error { return fault.New(code, status) }
func str(x Object, k string) string      { v, _ := x[k].(string); return v }
func obj(x Object, k string) Object      { v, _ := x[k].(map[string]any); return v }
func num(x Object, k string) int64       { v, _ := integer(x[k]); return v }
func truth(x Object, k string) bool      { v, _ := x[k].(bool); return v }
func has(a []string, b string) bool {
	for _, v := range a {
		if v == b {
			return true
		}
	}
	return false
}
func stringsOf(v any) []string {
	if a, ok := v.([]string); ok {
		return a
	}
	a, _ := v.([]any)
	out := []string{}
	for _, v := range a {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
func encode(v any) []byte { b, _ := protocol.Encode(v); return b }
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func stamp(n int64) time.Time { return time.Unix(n, 0).UTC() }
func iso(v any) string {
	t, _ := time.Parse(time.RFC3339Nano, v.(string))
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func unavailable(e error) bool { return e != nil && (fault.Status(e) == 403 || fault.Status(e) == 404) }
func row(ctx context.Context, tx pgx.Tx, q string, args ...any) (Object, error) {
	var raw []byte
	e := tx.QueryRow(ctx, q, args...).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var x Object
	e = json.Unmarshal(raw, &x)
	return x, e
}
func rows(ctx context.Context, tx pgx.Tx, q string, args ...any) ([]Object, error) {
	rr, e := tx.Query(ctx, q, args...)
	if e != nil {
		return nil, e
	}
	defer rr.Close()
	out := []Object{}
	for rr.Next() {
		var raw []byte
		if e = rr.Scan(&raw); e != nil {
			return nil, e
		}
		var x Object
		if e = json.Unmarshal(raw, &x); e != nil {
			return nil, e
		}
		out = append(out, x)
	}
	return out, rr.Err()
}
func (s *Service) run(ctx context.Context, a Actor, write bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if write && a.Device != nil {
		if e := deviceauth.CheckInformationWatchWrite(*a.Device, "history"); e != nil {
			return nil, e
		}
	}
	if write && a.Device == nil {
		return nil, fail("access_denied", 401)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var current deviceauth.ControlAuthorization
		auth := func(ctx context.Context, tx pgx.Tx) error {
			if a.Device == nil {
				return nil
			}
			if s.Devices == nil {
				return fail("recruitment_service_unavailable", 503)
			}
			var e error
			current, e = s.Devices.CurrentControlWithin(ctx, tx, *a.Device, "history")
			return e
		}
		if !write {
			if e := auth(ctx, tx); e != nil {
				return nil, e
			}
			return fn(tx, current)
		}
		budget := s.Resources
		if budget == nil {
			budget, _ = resourcebudget.New(nil, s.Now)
		}
		v, e := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.Device.SubjectID}, auth, func(_ context.Context, tx pgx.Tx) (any, error) { return fn(tx, current) }, resourcebudget.Options{})
		if e != nil {
			return nil, e
		}
		return v.(map[string]any), nil
	})
}
func (s *Service) source(ctx context.Context, tx pgx.Tx, id string, write bool) (Object, error) {
	if !opportunities.UUID.MatchString(id) {
		return nil, invalid()
	}
	lock := " FOR SHARE"
	if write {
		lock = " FOR UPDATE"
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(o) FROM recruitment_opportunities o WHERE id=$1"+lock, id)
	if e == nil && r == nil {
		e = fail("recruitment_not_found", 404)
	}
	return r, e
}
func (s *Service) receipt(r Object) Object {
	state := r["state"]
	t, _ := time.Parse(time.RFC3339Nano, str(r, "expires_at"))
	if state == "active" && !t.After(stamp(s.now())) {
		state = "expired"
	}
	return Object{"schemaVersion": 2, "recruitmentId": r["id"], "projectId": r["project_id"], "publisherId": r["publisher_id"], "contactSubjectId": r["contact_subject_id"], "revision": r["revision"], "state": state, "sourceEventId": r["current_event_id"], "expiresAt": iso(r["expires_at"]), "objectKind": "long-term-role-opportunity", "taskAutomaticallyCreated": false}
}
func (s *Service) grant(ctx context.Context, tx pgx.Tx, r Object) (deviceauth.ConsentIntent, error) {
	if str(r, "payload_text") == "" {
		return deviceauth.ConsentIntent{}, fail("recruitment_source_unavailable", 404)
	}
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fail("recruitment_service_unavailable", 503)
	}
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(r, "consent_id"), SubjectID: str(r, "subject_id"), Action: "recruitment.write", ObjectID: str(r, "operation_id"), Recipient: s.Endpoint, PayloadJSON: str(r, "payload_text")})
}
func (s *Service) canRead(g deviceauth.ConsentIntent, viewer string) bool {
	if g.IssuedAt > s.now() || g.ExpiresAt <= s.now() {
		return false
	}
	if viewer == g.SubjectID {
		return true
	}
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
		return false
	}
	return g.Visibility == "Public" && g.Purpose == "public-profile" || g.Visibility == "Private" && viewer != "" && has(g.Viewers, viewer)
}
