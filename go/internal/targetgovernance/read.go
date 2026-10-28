package targetgovernance

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (s *Service) readableEvents(ctx context.Context, tx pgx.Tx, a Actor, r Object) ([]Object, error) {
	out := []Object{}
	if r["closed_at"] != nil && seconds(r["closed_at"]) <= s.now()-180*86400 {
		return out, nil
	}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM target_governance_events_v2 e WHERE report_id=$1 ORDER BY version", r["id"])
	if e != nil {
		return nil, e
	}
	for _, event := range rr {
		if str(event, "payload_text") == "" || event["erased_at"] != nil {
			continue
		}
		g, e := s.grant(ctx, tx, event)
		if e != nil {
			if missing(e) {
				continue
			}
			return nil, e
		}
		if s.canRead(g, a.Device.SubjectID) {
			view := Object{"eventId": event["id"], "authorId": event["subject_id"], "at": iso(event["created_at"]), "version": event["version"]}
			var payload Object
			if protocol.Decode([]byte(str(event, "payload_text")), &payload) != nil {
				return nil, fail("internal_error", 500)
			}
			for k, v := range payload {
				view[k] = v
			}
			out = append(out, view)
		}
	}
	return out, nil
}
func (s *Service) visible(ctx context.Context, tx pgx.Tx, a Actor, r Object) ([]string, []Object, error) {
	if r == nil {
		return nil, nil, fail("not_found", 404)
	}
	parties, e := s.parties(ctx, tx, r)
	if e != nil {
		return nil, nil, e
	}
	events, e := s.readableEvents(ctx, tx, a, r)
	if e != nil {
		return nil, nil, e
	}
	var own bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM target_governance_events_v2 WHERE report_id=$1 AND subject_id=$2)", r["id"], a.Device.SubjectID).Scan(&own)
	if e != nil {
		return nil, nil, e
	}
	if !has(parties, a.Device.SubjectID) && len(events) == 0 && !own {
		return nil, nil, fail("not_found", 404)
	}
	return parties, events, nil
}

// RestrictionsWithin is a current operational summary. Callers must establish
// their real target/current ordinary permission before exposing this projection.
func (s *Service) RestrictionsWithin(ctx context.Context, tx pgx.Tx, kind, id string) (Object, error) {
	if !has([]string{"task", "room"}, kind) {
		return nil, invalid()
	}
	ids := []string{id}
	column := "task_id"
	if kind == "room" {
		column = "room_id"
		var parent *string
		if e := tx.QueryRow(ctx, "SELECT parent_room_id::text FROM chat_rooms WHERE room_id=$1", id).Scan(&parent); e != nil && e != pgx.ErrNoRows {
			return nil, e
		}
		if parent != nil {
			ids = append(ids, *parent)
		}
	}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM (SELECT id,restriction_scopes,restriction_until,restriction_event_id FROM target_reports_v2 WHERE "+column+"=ANY($1::uuid[]) AND restriction_until>$2 ORDER BY id)r", ids, stamp(s.now()))
	if e != nil {
		return nil, e
	}
	if kind == "room" {
		more, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM (SELECT id,restriction_scopes,restriction_until,restriction_event_id FROM account_chat_reports_v1 WHERE room_id=ANY($1::uuid[]) AND restriction_until>$2 ORDER BY id)r", ids, stamp(s.now()))
		if e != nil {
			return nil, e
		}
		rr = append(rr, more...)
	}
	scopes := []string{}
	restrictions := []Object{}
	for _, r := range rr {
		scopes = unique(append(scopes, stringsOf(r["restriction_scopes"])...))
		restrictions = append(restrictions, Object{"reportId": r["id"], "eventId": r["restriction_event_id"], "scopes": r["restriction_scopes"], "until": iso(r["restriction_until"])})
	}
	return Object{"scopes": scopes, "restrictions": restrictions, "authority": "current-target-operation-restrictions; not-capability-or-source-permission"}, nil
}
func (s *Service) TargetInfo(ctx context.Context, a Actor, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || !validTarget(q, false) {
		return nil, invalid()
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		src, e := s.source(ctx, tx, a.Device, q, true, false)
		if e != nil {
			return nil, e
		}
		restrictions, e := s.RestrictionsWithin(ctx, tx, str(q, "type"), str(q, "id"))
		if e != nil {
			return nil, e
		}
		return Object{"target": src["target"], "state": src["state"], "sourceAvailable": src["sourceAvailable"], "contentAccess": src["contentAccess"], "currentRestrictions": restrictions}, nil
	})
}
func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, a Actor, id string) (Object, error) {
	r, e := s.load(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	parties, events, e := s.visible(ctx, tx, a, r)
	if e != nil {
		return nil, e
	}
	independent, e := s.independent(ctx, tx, a, parties)
	if e != nil {
		return nil, e
	}
	src, e := s.source(ctx, tx, nil, s.target(r), false, false)
	if e != nil && !missing(e) {
		return nil, e
	}
	canRead := false
	if src != nil {
		_, e = s.source(ctx, tx, a.Device, s.target(r), true, false)
		if e != nil && !missing(e) {
			return nil, e
		}
		canRead = e == nil
	}
	restrictions, e := s.RestrictionsWithin(ctx, tx, str(r, "target_type"), str(s.target(r), "id"))
	if e != nil {
		return nil, e
	}
	handling := "awaiting-authorized-independent-handler"
	for _, v := range events {
		if has([]string{"review", "resolve", "pause"}, str(v, "kind")) || has(s.ModeratorIDs, str(v, "authorId")) {
			handling = "handler-event-recorded"
			break
		}
	}
	var target, own any
	if src != nil {
		t := Object{}
		for k, v := range obj(src, "target") {
			t[k] = v
		}
		t["state"], t["sourceAvailable"], t["contentAccess"], t["canReadTarget"] = src["state"], src["sourceAvailable"], src["contentAccess"], canRead
		target = t
	}
	effective := r["restriction_until"] != nil && seconds(r["restriction_until"]) > s.now()
	if effective {
		own = Object{"scopes": r["restriction_scopes"], "until": iso(r["restriction_until"]), "eventId": r["restriction_event_id"]}
	}
	var canAppeal any
	if r["state"] == "resolved" || r["restriction_until"] != nil {
		canAppeal = (r["state"] == "resolved" || effective) && has(parties, a.Device.SubjectID) && num(r, "appeal_count") < 3
	}
	return Object{"schemaVersion": 2, "reportId": r["id"], "target": s.target(r), "version": r["version"], "state": r["state"], "reporterId": r["subject_id"], "events": events, "closedAt": iso(r["closed_at"]), "canModerate": independent, "canAppeal": canAppeal, "canRespond": has(parties, a.Device.SubjectID), "canWithdraw": r["subject_id"] == a.Device.SubjectID && r["state"] != "withdrawn", "handling": handling, "currentTarget": target, "requiredDecisionViewers": []any{r["subject_id"]}, "currentRestrictions": restrictions, "ownRestriction": own, "guaranteesResponse": false, "authority": "private-handling-and-target-operations; not-task-result-or-capability-verdict"}, nil
}
func (s *Service) Read(ctx context.Context, a Actor, id string) (Object, error) {
	if !opportunities.UUID.MatchString(id) {
		return nil, invalid()
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.ReadWithin(ctx, tx, a, id)
	})
}
func (s *Service) Query(ctx context.Context, a Actor, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil || !strict(q, "after", "limit", "target") {
		return nil, invalid()
	}
	if _, ok := q["after"]; ok && !opportunities.UUID.MatchString(str(q, "after")) {
		return nil, invalid()
	}
	if _, ok := q["limit"]; !ok {
		q["limit"] = 20
	}
	limit, ok := integer(q["limit"])
	if !ok || limit > 40 {
		return nil, invalid()
	}
	if _, ok := q["target"]; ok && !validTarget(obj(q, "target"), false) {
		return nil, invalid()
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rr, e := rows(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT r.id FROM target_reports_v2 r WHERE ($1::uuid IS NULL OR r.id>$1) AND ($2::text IS NULL OR target_type=$2 AND COALESCE(task_id,room_id)=$3) AND (r.subject_id=$4 OR r.party_ids ? $4 OR EXISTS(SELECT 1 FROM target_governance_events_v2 e JOIN consents c ON c.id=e.consent_id WHERE e.report_id=r.id AND (e.subject_id=$4 OR c.intent->'viewers' ? $4)) OR EXISTS(SELECT 1 FROM chat_memberships m WHERE m.room_id=r.room_id AND m.subject_id=$4 AND m.left_at IS NULL) OR EXISTS(SELECT 1 FROM task_events e WHERE e.task_id=r.task_id AND e.subject_id=$4)) ORDER BY r.id LIMIT 200)r`, nullable(str(q, "after")), nullable(str(obj(q, "target"), "type")), nullable(str(obj(q, "target"), "id")), a.Device.SubjectID)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		var last any = nullable(str(q, "after"))
		for _, r := range rr {
			last = r["id"]
			v, e := s.ReadWithin(ctx, tx, a, str(r, "id"))
			if e != nil {
				if !missing(e) {
					return nil, e
				}
			} else {
				items = append(items, v)
			}
			if len(items) == int(limit) {
				break
			}
		}
		var next any
		if len(rr) == 200 || len(items) == int(limit) {
			next = last
		}
		return Object{"items": items, "next": next, "coverage": "currently-visible-page-only"}, nil
	})
}
