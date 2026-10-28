// Package targetgovernance owns existing private Task/room complaints and
// current operation restrictions; it never grants access to source content.
package targetgovernance

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
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
type SourceReader interface {
	GovernanceSourceWithin(context.Context, pgx.Tx, *deviceauth.Actor, string, bool, bool) (map[string]any, error)
}
type Service struct {
	Pool         *pgxpool.Pool
	Endpoint     string
	Devices      *deviceauth.Service
	Links        *accountlinks.Service
	Tasks, Chat  SourceReader
	Resources    *resourcebudget.Service
	ModeratorIDs []string
	Now          func() time.Time
	accountScope string
}

func fail(code string, status int) error { return fault.New(code, status) }
func str(x Object, k string) string      { v, _ := x[k].(string); return v }
func obj(x Object, k string) Object      { v, _ := x[k].(map[string]any); return v }
func num(x Object, k string) int64       { n, _ := integer(x[k]); return n }
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
func unique(a []string) []string {
	out := []string{}
	for _, s := range a {
		if !has(out, s) {
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
func seconds(v any) int64 {
	s, _ := v.(string)
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t.Unix()
}
func iso(v any) any {
	if v == nil {
		return nil
	}
	return stamp(seconds(v)).Format("2006-01-02T15:04:05.000Z")
}
func missing(e error) bool { return e != nil && has([]string{"403", "404", "410"}, faultStatus(e)) }
func faultStatus(e error) string {
	switch fault.Status(e) {
	case 403:
		return "403"
	case 404:
		return "404"
	case 410:
		return "410"
	}
	return ""
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
	if a.Device == nil {
		return nil, fail("access_denied", 401)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var current deviceauth.ControlAuthorization
		auth := func(ctx context.Context, tx pgx.Tx) error {
			if s.Devices == nil {
				return fail("target_governance_unavailable", 503)
			}
			var e error
			current, e = s.Devices.CurrentControlWithin(ctx, tx, *a.Device, "moderation")
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
		v, e := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.Device.SubjectID}, auth, func(_ context.Context, tx pgx.Tx) (any, error) { return fn(tx, current) }, resourcebudget.Options{Control: control})
		if e != nil {
			return nil, e
		}
		return v.(map[string]any), nil
	})
}
func (s *Service) source(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, target Object, authorize, lock bool) (Object, error) {
	reader := s.Tasks
	if target["type"] == "room" {
		reader = s.Chat
	}
	if reader == nil {
		return nil, fail("target_source_unavailable", 503)
	}
	return reader.GovernanceSourceWithin(ctx, tx, a, str(target, "id"), authorize, lock)
}
func (s *Service) target(r Object) Object {
	out := Object{"type": r["target_type"], "id": r["task_id"], "version": r["target_version"]}
	if r["target_type"] == "task" {
		out["rootEventId"] = r["root_event_id"]
	} else {
		out["id"] = r["room_id"]
	}
	return out
}
func (s *Service) load(ctx context.Context, tx pgx.Tx, id string, lock bool) (Object, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	return row(ctx, tx, "SELECT to_jsonb(r) FROM target_reports_v2 r WHERE id=$1"+suffix, id)
}
func (s *Service) grant(ctx context.Context, tx pgx.Tx, r Object) (deviceauth.ConsentIntent, error) {
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(r, "consent_id"), SubjectID: str(r, "subject_id"), ObjectID: str(r, "id"), Action: "moderation.publish", Recipient: s.Endpoint, PayloadJSON: str(r, "payload_text")})
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
	if g.Visibility == "Public" {
		return g.Purpose == "public-profile"
	}
	return g.Visibility == "Private" && viewer != "" && has(g.Viewers, viewer)
}
func (s *Service) parties(ctx context.Context, tx pgx.Tx, r Object) ([]string, error) {
	current := []string{}
	src, e := s.source(ctx, tx, nil, s.target(r), false, false)
	if e != nil && !missing(e) {
		return nil, e
	}
	if src != nil {
		current = stringsOf(src["parties"])
	}
	return unique(append(append([]string{str(r, "subject_id")}, stringsOf(r["party_ids"])...), current...)), nil
}
func (s *Service) independent(ctx context.Context, tx pgx.Tx, a Actor, parties []string) (bool, error) {
	if !has(s.ModeratorIDs, a.Device.SubjectID) || has(parties, a.Device.SubjectID) {
		return false, nil
	}
	if s.Links != nil {
		scope := s.accountScope
		if scope == "" {
			scope = "moderation"
		}
		account, e := s.Links.ForScope(scope).ResolveWithin(ctx, tx, *a.Device, "", false)
		if e != nil {
			if fault.Code(e) == "account_verification_required" {
				return true, nil
			}
			return false, e
		}
		linked, e := s.Links.HasLinkedPartyWithin(ctx, tx, str(account, "id"), parties)
		if e != nil {
			return false, e
		}
		if linked {
			return false, nil
		}
	}
	return true, nil
}
func (s *Service) Config(ctx context.Context, a Actor) (Object, error) {
	return s.run(ctx, a, false, false, func(_ pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return Object{"moderatorIds": append([]string{}, s.ModeratorIDs...), "configured": len(s.ModeratorIDs) > 0, "roleConfigured": has(s.ModeratorIDs, a.Device.SubjectID), "guaranteesResponse": false, "reportTargets": []string{"task", "room"}, "independentHandlerCheckedPerCase": true, "automaticAccountRestriction": false}, nil
	})
}
func (s *Service) receiptWithin(ctx context.Context, tx pgx.Tx, a Actor, q Object) (Object, error) {
	r, e := row(ctx, tx, "SELECT to_jsonb(e) FROM (SELECT id,report_id,subject_id,version,payload_hash FROM target_governance_events_v2 WHERE id=$1)e", q["eventId"])
	if e != nil {
		return nil, e
	}
	if r != nil && r["subject_id"] != a.Device.SubjectID {
		return nil, fail("not_found", 404)
	}
	state := "absent"
	if r != nil {
		state = "conflict"
		if r["payload_hash"] == q["payloadHash"] {
			state = "acknowledged"
		}
	}
	out := Object{"eventId": q["eventId"], "state": state, "checkedAt": s.now(), "authority": "accepted-event-only; not-current-restriction-or-permission"}
	if r != nil {
		out["reportId"], out["version"] = r["report_id"], r["version"]
	}
	return out, nil
}
func (s *Service) Receipt(ctx context.Context, a Actor, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil || !strict(q, "eventId", "payloadHash") || !opportunities.UUID.MatchString(str(q, "eventId")) || !identityDigest(str(q, "payloadHash")) {
		return nil, invalid()
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.receiptWithin(ctx, tx, a, q)
	})
}
func identityDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func (s *Service) replay(ctx context.Context, tx pgx.Tx, a Actor, id, consent, payload string) (Object, error) {
	r, e := row(ctx, tx, "SELECT to_jsonb(e) FROM target_governance_events_v2 e WHERE id=$1", id)
	if e != nil || r == nil {
		return nil, e
	}
	if r["subject_id"] != a.Device.SubjectID || r["consent_id"] != consent || r["payload_hash"] != identity.Digest([]byte(payload)) {
		return nil, fail("target_governance_conflict", 409)
	}
	return s.receiptWithin(ctx, tx, a, Object{"eventId": id, "payloadHash": identity.Digest([]byte(payload))})
}
