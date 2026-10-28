// Package moderation owns the existing Case/legacy Assistance private handling
// process, verifier participation and original accepted-operation receipts.
package moderation

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Object = map[string]any
type Actor struct {
	Device    *deviceauth.Actor
	RequestID string
}
type EvidenceReader interface {
	ModerationTargetWithin(context.Context, pgx.Tx, string, string, string, string) (map[string]any, error)
}
type Service struct {
	Pool         *pgxpool.Pool
	Endpoint     string
	Devices      *deviceauth.Service
	Cases        *cases.Service
	Assistance   *taskmaterials.Service
	Evidence     EvidenceReader
	Resources    *resourcebudget.Service
	ModeratorIDs []string
	Now          func() time.Time
}

func fail(code string, status int) error { return fault.New(code, status) }
func str(x Object, k string) string      { v, _ := x[k].(string); return v }
func obj(x Object, k string) Object {
	switch v := x[k].(type) {
	case map[string]any:
		return v
	case *protocol.OrderedObject:
		return v.Values()
	}
	return nil
}
func num(x Object, k string) int64  { n, _ := integer(x[k], 0, 9007199254740991); return n }
func truth(x Object, k string) bool { v, _ := x[k].(bool); return v }
func has(a []string, b string) bool {
	for _, v := range a {
		if v == b {
			return true
		}
	}
	return false
}
func unique(a []string) []string {
	out := []string{}
	for _, v := range a {
		if !has(out, v) {
			out = append(out, v)
		}
	}
	return out
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
func objectsOf(v any) []Object {
	if a, ok := v.([]Object); ok {
		return a
	}
	out := []Object{}
	if a, ok := v.([]any); ok {
		for _, v := range a {
			switch x := v.(type) {
			case map[string]any:
				out = append(out, x)
			case *protocol.OrderedObject:
				out = append(out, x.Values())
			}
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
func serviceError(e error) bool { var f *fault.Error; return errors.As(e, &f) }
func digestText(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
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
func (s *Service) run(ctx context.Context, a Actor, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if write && a.Device != nil {
		if e := deviceauth.CheckInformationWatchWrite(*a.Device, "moderation"); e != nil {
			return nil, e
		}
	}
	if a.Device == nil {
		return nil, fail("access_denied", 401)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var current deviceauth.ControlAuthorization
		authorize := func(ctx context.Context, tx pgx.Tx) error {
			if s.Devices == nil {
				return fail("moderation_unavailable", 503)
			}
			var e error
			current, e = s.Devices.CurrentControlWithin(ctx, tx, *a.Device, "moderation")
			return e
		}
		if !write {
			if e := authorize(ctx, tx); e != nil {
				return nil, e
			}
			return fn(tx, current)
		}
		budget := s.Resources
		if budget == nil {
			budget, _ = resourcebudget.New(nil, s.Now)
		}
		v, e := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.Device.SubjectID}, authorize, func(_ context.Context, tx pgx.Tx) (any, error) { return fn(tx, current) }, resourcebudget.Options{Control: control})
		if e != nil {
			return nil, e
		}
		return v.(map[string]any), nil
	})
}
func (s *Service) grant(ctx context.Context, tx pgx.Tx, subject, consent, id, payload string) (deviceauth.ConsentIntent, error) {
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: consent, SubjectID: subject, Action: "moderation.publish", ObjectID: id, Recipient: s.Endpoint, PayloadJSON: payload})
}
func (s *Service) visible(g deviceauth.ConsentIntent, viewer string) bool {
	if g.IssuedAt > s.now() || g.ExpiresAt <= s.now() {
		return false
	}
	if g.SubjectID == viewer {
		return true
	}
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
		return false
	}
	if g.Visibility == "Public" {
		return g.Purpose == "public-profile"
	}
	return g.Visibility == "Private" && has(g.Viewers, viewer)
}
func (s *Service) stored(ctx context.Context, tx pgx.Tx, r Object, report bool, subject string) (Object, error) {
	payload, ok := r["payload_text"].(string)
	if !ok || identity.Digest([]byte(payload)) != str(r, "payload_hash") {
		c, e := row(ctx, tx, "SELECT to_jsonb(c) FROM (SELECT revoked_at,expires_at FROM consents WHERE id=$1 AND subject_id=$2)c", r["consent_id"], subject)
		if e != nil {
			return nil, e
		}
		if c != nil {
			expires, _ := time.Parse(time.RFC3339Nano, str(c, "expires_at"))
			if c["revoked_at"] != nil || !expires.After(time.Unix(s.now(), 0)) {
				return nil, nil
			}
		}
		return nil, fail("stored_integrity_mismatch", 500)
	}
	x, e := ParsePayload([]byte(payload), report)
	if e != nil {
		return nil, fail("stored_integrity_mismatch", 500)
	}
	return x, nil
}
func (s *Service) load(ctx context.Context, tx pgx.Tx, id string, write bool) (Object, error) {
	suffix := ""
	if write {
		suffix = " FOR UPDATE"
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(r) FROM moderation_reports r WHERE id=$1"+suffix, id)
	if e != nil || r == nil {
		return r, e
	}
	recorded, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM moderation_events e WHERE report_id=$1 ORDER BY version LIMIT 100", id)
	if e != nil {
		return nil, e
	}
	report, e := s.stored(ctx, tx, r, true, str(r, "reporter_id"))
	if e != nil {
		return nil, e
	}
	projectable := []Object{}
	for _, event := range recorded {
		payload, e := s.stored(ctx, tx, event, false, str(event, "subject_id"))
		if e != nil {
			return nil, e
		}
		if payload != nil {
			copy := Object{}
			for k, v := range event {
				copy[k] = v
			}
			copy["parsedPayload"] = payload
			projectable = append(projectable, copy)
		}
	}
	r["recorded"], r["reportData"], r["verifiers"] = recorded, report, ProjectVerifiers(projectable)
	return r, nil
}
func (s *Service) isModerator(subject string) bool { return has(s.ModeratorIDs, subject) }
func (s *Service) allowed(subject string, r Object) bool {
	return s.isModerator(subject) || has(parties(r), subject) || verifier(r, subject) != nil
}
func (s *Service) independent(subject string, r Object) bool {
	return s.isModerator(subject) && !has(parties(r), subject) && verifier(r, subject) == nil
}
func (s *Service) caseSource(ctx context.Context, tx pgx.Tx, viewer, id string, write bool) (Object, error) {
	if s.Cases == nil {
		return nil, fail("moderation_case_source_unavailable", 503)
	}
	return s.Cases.ModerationSourceWithin(ctx, tx, id, viewer, write)
}
func (s *Service) evidenceTarget(ctx context.Context, tx pgx.Tx, viewer, caseID, target, id string) (Object, error) {
	if s.Evidence == nil {
		return nil, fail("evidence_revalidation_unavailable", 409)
	}
	return s.Evidence.ModerationTargetWithin(ctx, tx, viewer, caseID, target, id)
}
