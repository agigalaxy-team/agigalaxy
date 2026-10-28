package notifications

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) visible(ctx context.Context, tx pgx.Tx, a Actor, candidate Object) (Object, error) {
	kind := str(candidate, "kind")
	if kind == "incident" {
		notice, e := one(ctx, tx, "SELECT to_jsonb(n) FROM incident_notices n WHERE id=$1 AND subject_id=$2", candidate["event_id"], a.SubjectID)
		if e != nil || notice == nil {
			return nil, e
		}
		return Object{"title": notice["title"], "summary": notice["summary"], "actorId": "operator:" + str(notice, "operator_ref"), "eventKind": "incident-update", "incidentId": notice["incident_id"], "incidentRevision": notice["incident_revision"]}, nil
	}
	var reader SourceReader
	switch kind {
	case "room-message", "room-invite":
		reader = s.Readers.Chat
	case "task-v2":
		reader = s.Readers.Task
	case "task-comment":
		reader = s.Readers.Comment
	case "comment-governance":
		reader = s.Readers.CommentGovernance
	case "qualification-request":
		reader = s.Readers.Qualification
	case "information-change":
		reader = s.Readers.Information
	case "target-governance":
		reader = s.Readers.TargetGovernance
	case "moderation-report", "moderation-event":
		reader = s.Readers.Moderation
	case "assistance":
		reader = s.Readers.Assistance
	case "context", "context-accept":
		reader = s.Readers.Context
	case "capsule":
		reader = s.Readers.Capsule
	default:
		return nil, fail("notification_source_unavailable", 503)
	}
	if reader == nil {
		return nil, fail("notification_source_unavailable", 503)
	}
	return reader(ctx, tx, a.Actor, candidate)
}
func (s *Service) inboxVisible(ctx context.Context, tx pgx.Tx, a Actor, candidate Object) (Object, error) {
	view, e := s.visible(ctx, tx, a, candidate)
	if e != nil || view == nil {
		return nil, e
	}
	kind := str(candidate, "kind")
	if contains([]string{"assistance", "context", "context-accept", "capsule", "incident"}, kind) {
		delete(view, "summary")
		if kind == "capsule" && view["object"] != nil {
		} else if candidate["assistance_id"] != nil {
			view["object"] = Object{"type": "assistance", "id": candidate["assistance_id"]}
		} else if kind == "incident" {
			view["object"] = Object{"type": "incident", "id": view["incidentId"]}
		} else {
			view["object"] = Object{"type": kind, "id": candidate["event_id"]}
		}
		view["serviceReceipt"] = kind == "incident"
	}
	return view, nil
}
func (s *Service) item(ctx context.Context, tx pgx.Tx, a Actor, candidate Object, legacy, extra Object) (Object, error) {
	view, e := s.inboxVisible(ctx, tx, a, candidate)
	if e != nil {
		if fault.Status(e) == 403 || fault.Status(e) == 404 {
			return nil, nil
		}
		return nil, e
	}
	if view == nil {
		return nil, nil
	}
	settings := object(extra["settings"])
	old := object(legacy["settings"])
	room := str(candidate, "room_id")
	actorID := str(view, "actorId")
	blocked := contains(stringsOf(settings["blockedSubjectIds"]), actorID)
	for _, value := range array(settings["roomBlocks"]) {
		b := object(value)
		if b["roomId"] == room && b["subjectId"] == actorID {
			blocked = true
		}
	}
	category := candidate["category"]
	if value, ok := view["category"]; ok {
		category = value
	}
	disabled := false
	if value, ok := old[text(category)]; ok {
		if v, ok := value.(bool); ok && !v {
			disabled = true
		}
	}
	quiet := !boolean(old["enabled"]) || disabled || blocked || contains(stringsOf(old["mutedAssistanceIds"]), str(candidate, "assistance_id")) || room != "" && (contains(stringsOf(settings["mutedRoomIds"]), room) || !boolean(settings["rooms"])) || contains([]string{"task-v2", "task-comment"}, str(candidate, "kind")) && !boolean(settings["tasks"])
	if !boolean(view["serviceReceipt"]) && (blocked || !boolean(old["enabled"]) || disabled) {
		return nil, nil
	}
	present, e := one(ctx, tx, "SELECT jsonb_build_object('presented_at',presented_at) FROM notification_presentations WHERE subject_id=$1 AND kind=$2 AND event_id=$3", a.SubjectID, candidate["kind"], candidate["event_id"])
	if e != nil {
		return nil, e
	}
	read := candidate["read_at"] != nil
	presented := present != nil && present["presented_at"] != nil
	out := Object{"id": key(candidate), "category": category, "at": iso(candidate["created_at"]), "read": read}
	for key, value := range view {
		out[key] = value
	}
	out["quiet"] = quiet
	out["interruptiveEligible"] = !quiet && !read && !presented
	out["presented"] = presented
	return out, nil
}
func (s *Service) Query(ctx context.Context, a Actor, input Object) (any, error) {
	q, e := parseQuery(input, false)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		state, e := s.collect(ctx, tx, a, q, nil)
		if e != nil {
			return nil, e
		}
		items := []any{}
		var scanned any
		stopped := false
		for _, candidate := range state.Candidates {
			scanned = key(candidate)
			item, e := s.item(ctx, tx, a, candidate, state.Legacy, state.Extra)
			if e != nil {
				return nil, e
			}
			if item != nil {
				items = append(items, item)
			}
			if int64(len(items)) == q.Limit {
				stopped = true
				break
			}
		}
		if !stopped && !state.PossiblyMore {
			scanned = nil
		}
		return Object{"items": items, "nextAfter": scanned, "lastCheckedAt": stamp(s.now()), "externalDelivery": "disabled", "deliveryConfirmed": false}, nil
	})
}
func (s *Service) OneWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
	kind, eventID, e := locator(id, false)
	if e != nil {
		return nil, e
	}
	actor := Actor{Actor: a}
	state, e := s.collect(ctx, tx, actor, queryInput{}, &exactLocator{kind, eventID})
	if e != nil {
		return nil, e
	}
	for _, candidate := range state.Candidates {
		if key(candidate) != id {
			continue
		}
		item, e := s.item(ctx, tx, actor, candidate, state.Legacy, state.Extra)
		if e != nil {
			return nil, e
		}
		if item != nil {
			return item, nil
		}
	}
	return nil, fail("notification_not_found", 404)
}
