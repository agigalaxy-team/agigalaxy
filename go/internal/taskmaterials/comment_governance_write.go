package taskmaterials

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

func (g *CommentGovernance) Event(ctx context.Context, a Actor, id string, input Envelope) (any, error) {
	p, e := parseCommentGovernance(input, false)
	if e != nil {
		return nil, e
	}
	if p["reportId"] != id {
		return nil, fail("comment_report_target_mismatch", 400)
	}
	kind := str(p, "kind")
	return g.run(ctx, a, "moderation", true, kind == "withdraw-report" || kind == "resume", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "comment-governance:"+str(p, "id")); e != nil {
			return nil, e
		}
		if prior, e := g.accepted(ctx, tx, a, str(p, "id"), input); e != nil || prior != nil {
			return prior, e
		}
		first, e := g.load(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		if first == nil {
			return nil, fail("not_found", 404)
		}
		var locked string
		if e = tx.QueryRow(ctx, "SELECT id::text FROM task_requests WHERE id=$1 FOR SHARE", first["task_id"]).Scan(&locked); e != nil {
			return nil, e
		}
		comment, e := g.commentRow(ctx, tx, str(first, "comment_id"), true)
		if e != nil {
			return nil, e
		}
		current, e := g.load(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		parties, events, e := g.requireVisible(ctx, tx, a, current)
		if e != nil {
			return nil, e
		}
		if num(p["expectedVersion"]) != num(current["version"]) {
			return nil, fail("comment_governance_version_conflict")
		}
		decision := contains([]string{"pause", "resume", "resolve"}, kind)
		independent, e := g.independent(ctx, tx, a, current)
		if e != nil {
			return nil, e
		}
		authorizedReport := false
		for _, event := range events {
			if event["kind"] == nil || contains([]string{"report", "supplement", "appeal"}, str(event, "kind")) {
				authorizedReport = true
			}
		}
		if decision && (!independent || !authorizedReport) {
			return nil, fail("comment_independent_handler_required", 403)
		}
		if !decision && !contains(parties, a.SubjectID) {
			return nil, fail("comment_party_required", 403)
		}
		if kind == "withdraw-report" && current["reporter_id"] != a.SubjectID {
			return nil, fail("comment_reporter_required", 403)
		}
		grant, e := g.governanceGrant(ctx, tx, a.SubjectID, str(p, "id"), input)
		if e != nil {
			return nil, e
		}
		allowed := append([]string{}, g.ModeratorIDs...)
		if decision {
			allowed = append(allowed, parties...)
		}
		if e = privateCommentRecipients(grant, a.SubjectID, allowed); e != nil {
			return nil, e
		}
		if decision {
			for _, party := range []string{str(current, "reporter_id"), str(current, "author_id")} {
				if party != a.SubjectID && !contains(grant.Viewers, party) {
					return nil, fail("comment_decision_notice_required", 403)
				}
			}
		}
		state := current["state"]
		closed, pause := current["closed_at"], current["pause_until"]
		appeals := num(current["appeal_count"])
		if kind == "pause" {
			if num(p["until"]) <= g.now() || num(p["until"]) > g.now()+7*86400 {
				return nil, fail("comment_pause_expiry")
			}
			if _, e = g.commentSource(ctx, tx, &a.Actor, comment, num(current["comment_revision"])); e != nil {
				return nil, e
			}
			pause = stamp(num(p["until"]))
		}
		if kind == "resume" {
			if current["pause_until"] == nil {
				return nil, fail("comment_pause_not_present")
			}
			pause = nil
		}
		if kind == "resolve" {
			if state == "resolved" || state == "withdrawn" {
				return nil, fail("comment_governance_transition")
			}
			if p["reviewDisposition"] != "unchanged" {
				if num(comment["revision"]) != num(current["comment_revision"]) {
					return nil, fail("comment_review_stale")
				}
				if _, e = g.commentSource(ctx, tx, &a.Actor, comment, num(current["comment_revision"])); e != nil {
					return nil, e
				}
			}
			state = "resolved"
			closed = stamp(g.now())
		}
		if kind == "appeal" {
			if state != "resolved" || appeals >= 3 {
				return nil, fail("comment_governance_transition")
			}
			state = "appealed"
			closed = nil
			appeals++
		}
		if kind == "withdraw-report" {
			if state == "withdrawn" {
				return nil, fail("comment_governance_transition")
			}
			state = "withdrawn"
			closed = stamp(g.now())
		}
		version := num(current["version"]) + 1
		if version > 100 && kind != "withdraw-report" && kind != "resume" {
			return nil, fail("comment_governance_event_limit", 413)
		}
		if e = g.save(ctx, tx, a, auth, str(p, "id"), id, kind, version, input); e != nil {
			return nil, e
		}
		pauseEvent, decisionEvent := current["pause_event_id"], current["decision_event_id"]
		if kind == "pause" {
			pauseEvent = p["id"]
		}
		if kind == "resume" {
			pauseEvent = nil
		}
		if kind == "resolve" {
			decisionEvent = p["id"]
		}
		if _, e = tx.Exec(ctx, `UPDATE comment_reports_v2 SET version=$2,state=$3,pause_until=$4,closed_at=$5,appeal_count=$6,pause_event_id=$7,decision_event_id=$8 WHERE id=$1`, id, version, state, pause, closed, appeals, pauseEvent, decisionEvent); e != nil {
			return nil, e
		}
		if kind == "resolve" && p["reviewDisposition"] != "unchanged" {
			reviewState := "rejected"
			if p["reviewDisposition"] == "approve" {
				reviewState = "approved"
			}
			if _, e = tx.Exec(ctx, "UPDATE task_comments_v2 SET review_state=$2,review_event_id=$3 WHERE id=$1", comment["id"], reviewState, p["id"]); e != nil {
				return nil, e
			}
		}
		disposition := "separate-source-and-review-state"
		if kind == "pause" {
			disposition = "temporarily-hidden"
		}
		if kind == "resume" {
			disposition = "recheck-other-holds-and-source"
		}
		var pauseUntil any
		if pause != nil {
			pauseUntil = isoValue(pause)
		}
		return Object{"reportId": id, "eventId": p["id"], "version": version, "state": state, "pauseUntil": pauseUntil, "contentDisposition": disposition, "taskStateChanged": false, "capabilityVerdict": "not-decided"}, nil
	})
}
