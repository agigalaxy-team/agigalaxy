package taskmaterials

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (g *CommentGovernance) ReadWithin(ctx context.Context, tx pgx.Tx, a Actor, id string) (Object, error) {
	current, e := g.load(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	parties, events, e := g.requireVisible(ctx, tx, a, current)
	if e != nil {
		return nil, e
	}
	independent, e := g.independent(ctx, tx, a, current)
	if e != nil {
		return nil, e
	}
	reportVisible := false
	for _, event := range events {
		if event["kind"] == nil || contains([]string{"report", "supplement", "appeal"}, str(event, "kind")) {
			reportVisible = true
		}
	}
	canModerate := independent && reportVisible
	var source Object
	comment, e := g.commentRow(ctx, tx, str(current, "comment_id"), false)
	if e != nil {
		return nil, e
	}
	if canModerate {
		source, e = g.CommentService.ReadWithin(ctx, tx, &a.Actor, str(comment, "id"), num(current["comment_revision"]), true)
		if e != nil {
			if fault.Status(e) != 403 && fault.Status(e) != 404 {
				return nil, e
			}
			source = nil
		}
	}
	var paused, closed any
	if current["pause_until"] != nil {
		paused = isoValue(current["pause_until"])
	}
	if current["closed_at"] != nil {
		closed = isoValue(current["closed_at"])
	}
	handling := "awaiting-authorized-handler"
	if len(events) > 0 && len(g.ModeratorIDs) > 0 {
		handling = "awaiting-or-recorded-handler"
	}
	recipients := []string{}
	for _, id := range append(append([]string{}, g.ModeratorIDs...), str(current, "reporter_id"), str(current, "author_id"), str(current, "requester_id")) {
		if id != a.SubjectID && !contains(recipients, id) {
			recipients = append(recipients, id)
		}
	}
	return Object{"reportId": id, "target": Object{"type": "task-comment", "id": current["comment_id"], "revision": current["comment_revision"]}, "taskId": current["task_id"], "version": current["version"], "state": current["state"], "pauseUntil": paused, "closedAt": closed, "handlingState": handling, "canModerate": canModerate, "canReviewSource": source != nil && source["body"] != nil, "source": source, "events": events, "canAppeal": contains(parties, a.SubjectID) && current["state"] == "resolved" && num(current["appeal_count"]) < 3, "canSupplement": contains(parties, a.SubjectID), "canWithdrawReport": current["reporter_id"] == a.SubjectID && current["state"] != "withdrawn", "decisionRecipients": recipients, "authority": "configured-operator-process", "independence": "not-a-proof-of-real-world-control", "capabilityVerdict": "not-decided", "automaticAccountRestriction": false}, nil
}
func (g *CommentGovernance) Config(ctx context.Context, a Actor) (any, error) {
	return g.run(ctx, a, "moderation", false, false, func(pgx.Tx, deviceauth.ControlAuthorization) (any, error) {
		return Object{"moderatorIds": append([]string{}, g.ModeratorIDs...), "canModerate": contains(g.ModeratorIDs, a.SubjectID), "reportTargets": []string{"task-comment"}, "configured": len(g.ModeratorIDs) > 0, "guaranteesResponse": false, "automaticAccountRestriction": false}, nil
	})
}
func (g *CommentGovernance) Get(ctx context.Context, a Actor, id string) (any, error) {
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	return g.run(ctx, a, "moderation", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) { return g.ReadWithin(ctx, tx, a, id) })
}
func (g *CommentGovernance) Query(ctx context.Context, a Actor, input Object) (any, error) {
	if !exactFields(input, nil, []string{"commentId", "after", "limit"}) {
		return nil, fail("invalid_comment_report_query", 400)
	}
	var comment, after any
	for _, key := range []string{"commentId", "after"} {
		if value, ok := input[key]; ok {
			if !validID(text(value)) {
				return nil, fail("invalid_comment_report_query", 400)
			}
			if key == "commentId" {
				comment = value
			} else {
				after = value
			}
		}
	}
	limit := int64(10)
	if v, ok := input["limit"]; ok {
		if !validInt(v, 1, 30) {
			return nil, fail("invalid_comment_report_query", 400)
		}
		limit = num(v)
	}
	return g.run(ctx, a, "moderation", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		candidates, e := rows(ctx, tx, `SELECT jsonb_build_object('id',r.id) FROM comment_reports_v2 r JOIN task_comments_v2 c ON c.id=r.comment_id JOIN task_requests t ON t.id=c.task_id WHERE ($1::uuid IS NULL OR r.comment_id=$1) AND ($2::uuid IS NULL OR r.id>$2) AND (r.reporter_id=$3 OR c.subject_id=$3 OR t.requester_id=$3 OR EXISTS(SELECT 1 FROM task_participations p WHERE p.task_id=t.id AND p.subject_id=$3 AND p.snapshot->>'confirmedAt' IS NOT NULL) OR EXISTS(SELECT 1 FROM comment_governance_events_v2 e JOIN consents s ON s.id=e.consent_id WHERE e.report_id=r.id AND s.intent->'viewers' ? $3)) ORDER BY r.id LIMIT 200`, comment, after, a.SubjectID)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, candidate := range candidates {
			view, e := g.ReadWithin(ctx, tx, a, str(candidate, "id"))
			if e != nil {
				if fault.Status(e) != 403 && fault.Status(e) != 404 {
					return nil, e
				}
			} else {
				items = append(items, view)
			}
			if int64(len(items)) == limit {
				break
			}
		}
		var next any
		if int64(len(items)) == limit {
			next = items[len(items)-1].(map[string]any)["reportId"]
		}
		return Object{"items": items, "nextAfter": next, "scanTruncated": len(candidates) == 200 && int64(len(items)) < limit}, nil
	})
}
func (g *CommentGovernance) Receipt(ctx context.Context, a Actor, id, hash string) (any, error) {
	if !validID(id) || !hashPattern.MatchString(hash) {
		return nil, fail("invalid_comment_receipt", 400)
	}
	return g.run(ctx, a, "moderation", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM comment_governance_events_v2 e WHERE id=$1 AND subject_id=$2", id, a.SubjectID)
		if e != nil {
			return nil, e
		}
		if event == nil {
			return Object{"state": "absent"}, nil
		}
		out := Object{"state": "conflict", "authority": "accepted-event-only"}
		if event["payload_hash"] == hash {
			out["state"] = "acknowledged"
			out["reportId"] = event["report_id"]
			out["version"] = event["version"]
			out["consentId"] = event["consent_id"]
		}
		return out, nil
	})
}
func (g *CommentGovernance) NotificationViewWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, eventID, taskID string) (Object, error) {
	event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM comment_governance_events_v2 e WHERE id=$1", eventID)
	if e != nil || event == nil {
		return nil, e
	}
	current := *g
	current.accountScope = "notifications"
	view, e := current.ReadWithin(ctx, tx, Actor{Actor: a}, str(event, "report_id"))
	if e != nil {
		return nil, e
	}
	present := false
	for _, event := range view["events"].([]Object) {
		if event["eventId"] == eventID {
			present = true
		}
	}
	if !present {
		return nil, nil
	}
	return Object{"title": "评论处理记录有更新", "eventKind": event["kind"], "actorId": event["subject_id"], "object": Object{"type": "comment-governance", "id": event["report_id"], "taskId": taskID, "eventId": event["id"]}, "serviceReceipt": true}, nil
}
