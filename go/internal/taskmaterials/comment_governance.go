package taskmaterials

import (
	"context"
	"math"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

type CommentGovernance struct {
	*CommentService
	ModeratorIDs []string
	accountScope string
}

func (g *CommentGovernance) governanceGrant(ctx context.Context, tx pgx.Tx, subject, id string, input Envelope) (deviceauth.ConsentIntent, error) {
	return g.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: input.ConsentID, SubjectID: subject, Action: "moderation.publish", ObjectID: id, Recipient: g.Endpoint, PayloadJSON: input.PayloadJSON})
}
func privateCommentRecipients(grant deviceauth.ConsentIntent, actor string, allowed []string) error {
	if grant.Visibility != "Private" {
		return fail("comment_report_audience_mismatch", 403)
	}
	for _, id := range grant.Viewers {
		if id != actor && !contains(allowed, id) {
			return fail("comment_report_audience_mismatch", 403)
		}
	}
	return nil
}
func (g *CommentGovernance) load(ctx context.Context, tx pgx.Tx, id string, lock bool) (Object, error) {
	query := `SELECT to_jsonb(r)||jsonb_build_object('task_id',c.task_id,'author_id',c.subject_id,'requester_id',t.requester_id) FROM comment_reports_v2 r JOIN task_comments_v2 c ON c.id=r.comment_id JOIN task_requests t ON t.id=c.task_id WHERE r.id=$1`
	if lock {
		query += " FOR UPDATE OF r"
	}
	return row(ctx, tx, query, id)
}
func (g *CommentGovernance) parties(ctx context.Context, tx pgx.Tx, current Object) ([]string, error) {
	participants, e := rows(ctx, tx, "SELECT jsonb_build_object('subject_id',subject_id) FROM task_participations WHERE task_id=$1 AND snapshot->>'confirmedAt' IS NOT NULL", current["task_id"])
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for _, key := range []string{"reporter_id", "author_id", "requester_id"} {
		id := str(current, key)
		if !contains(ids, id) {
			ids = append(ids, id)
		}
	}
	for _, p := range participants {
		id := str(p, "subject_id")
		if !contains(ids, id) {
			ids = append(ids, id)
		}
	}
	return ids, nil
}
func (g *CommentGovernance) independent(ctx context.Context, tx pgx.Tx, a Actor, current Object) (bool, error) {
	if !contains(g.ModeratorIDs, a.SubjectID) {
		return false, nil
	}
	parties, e := g.parties(ctx, tx, current)
	if e != nil {
		return false, e
	}
	if contains(parties, a.SubjectID) {
		return false, nil
	}
	links := g.Links
	if links == nil && g.Writes != nil {
		links = g.Writes.Links
	}
	if links != nil {
		scope := g.accountScope
		if scope == "" {
			scope = "moderation"
		}
		account, e := links.ForScope(scope).ResolveWithin(ctx, tx, a.Actor, "", false)
		if e != nil && fault.Code(e) != "account_verification_required" {
			return false, e
		}
		if account != nil {
			var shared bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_account_links WHERE account_id=$1 AND subject_id=ANY($2::text[]))", account["id"], parties).Scan(&shared); e != nil {
				return false, e
			}
			if shared {
				return false, nil
			}
		}
	}
	return true, nil
}
func (g *CommentGovernance) readableEvents(ctx context.Context, tx pgx.Tx, a Actor, id string) ([]Object, error) {
	events, e := rows(ctx, tx, `SELECT to_jsonb(e) FROM comment_governance_events_v2 e JOIN comment_reports_v2 r ON r.id=e.report_id WHERE report_id=$1 AND (r.closed_at IS NULL OR r.closed_at>$2) ORDER BY e.version`, id, stamp(g.now()-180*86400))
	if e != nil {
		return nil, e
	}
	out := []Object{}
	for _, event := range events {
		if str(event, "payload_text") == "" || event["erased_at"] != nil {
			continue
		}
		grant, e := g.governanceGrant(ctx, tx, str(event, "subject_id"), str(event, "id"), Envelope{ConsentID: str(event, "consent_id"), PayloadJSON: str(event, "payload_text")})
		if e != nil {
			if fault.Status(e) == 403 || fault.Status(e) == 404 {
				continue
			}
			return nil, e
		}
		if !g.visible(grant, a.SubjectID) {
			continue
		}
		payload, e := parseObject(str(event, "payload_text"))
		if e != nil {
			return nil, e
		}
		view := Object{"eventId": event["id"], "authorId": event["subject_id"], "version": event["version"], "at": isoValue(event["created_at"])}
		for key, value := range payload {
			view[key] = value
		}
		out = append(out, view)
	}
	return out, nil
}
func (g *CommentGovernance) requireVisible(ctx context.Context, tx pgx.Tx, a Actor, current Object) ([]string, []Object, error) {
	if current == nil {
		return nil, nil, fail("not_found", 404)
	}
	parties, e := g.parties(ctx, tx, current)
	if e != nil {
		return nil, nil, e
	}
	events, e := g.readableEvents(ctx, tx, a, str(current, "id"))
	if e != nil {
		return nil, nil, e
	}
	if !contains(parties, a.SubjectID) && len(events) == 0 {
		return nil, nil, fail("not_found", 404)
	}
	return parties, events, nil
}
func (g *CommentGovernance) accepted(ctx context.Context, tx pgx.Tx, a Actor, id string, input Envelope) (Object, error) {
	prior, e := row(ctx, tx, "SELECT to_jsonb(e) FROM comment_governance_events_v2 e WHERE id=$1", id)
	if e != nil || prior == nil {
		return nil, e
	}
	if prior["subject_id"] != a.SubjectID || prior["consent_id"] != input.ConsentID || prior["payload_hash"] != identity.Digest([]byte(input.PayloadJSON)) {
		return nil, fail("comment_governance_conflict")
	}
	return Object{"reportId": prior["report_id"], "eventId": prior["id"], "version": prior["version"], "acknowledged": true, "authority": "accepted-event-only; not-current-decision"}, nil
}
func (g *CommentGovernance) save(ctx context.Context, tx pgx.Tx, a Actor, auth deviceauth.ControlAuthorization, id, reportID, kind string, version int64, input Envelope) error {
	if _, e := tx.Exec(ctx, `INSERT INTO comment_governance_events_v2(id,report_id,subject_id,version,kind,consent_id,payload_text,payload_hash,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, reportID, a.SubjectID, version, kind, input.ConsentID, input.PayloadJSON, identity.Digest([]byte(input.PayloadJSON)), stamp(g.now())); e != nil {
		return e
	}
	return g.commentAudit(ctx, tx, a, auth, id, "comment.moderation."+kind, true)
}
func parseCommentGovernance(input Envelope, report bool) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_comment_payload", 400) }
	if len([]byte(input.PayloadJSON)) > 30000 {
		return invalid()
	}
	p, e := parseObject(input.PayloadJSON)
	if e != nil || !validInt(p["schemaVersion"], 2, 2) || !validID(str(p, "id")) || !trimmed(p, "summary", 1600) {
		return invalid()
	}
	if report {
		target := obj(p, "target")
		if !exactFields(p, []string{"schemaVersion", "id", "target", "category", "summary"}, nil) || !exactFields(target, []string{"type", "id", "revision"}, nil) || target["type"] != "task-comment" || !validID(str(target, "id")) || !validInt(target["revision"], 1, math.MaxInt64) || !contains([]string{"advertising", "harassment", "privacy", "review-request", "other"}, str(p, "category")) {
			return invalid()
		}
		return p, nil
	}
	if !validID(str(p, "reportId")) || !validInt(p["expectedVersion"], 1, math.MaxInt64) {
		return invalid()
	}
	required := []string{"schemaVersion", "id", "reportId", "expectedVersion", "summary", "kind"}
	switch str(p, "kind") {
	case "supplement", "appeal", "withdraw-report", "resume":
	case "pause":
		required = append(required, "until", "rule")
		if !validInt(p["until"], 1, math.MaxInt64) || !trimmed(p, "rule", 120) {
			return invalid()
		}
	case "resolve":
		required = append(required, "verdict", "reviewDisposition", "rule")
		if _, ok := p["reviewDisposition"]; !ok {
			p["reviewDisposition"] = "unchanged"
		}
		if !contains([]string{"upheld", "dismissed"}, str(p, "verdict")) || !contains([]string{"unchanged", "approve", "reject"}, str(p, "reviewDisposition")) || !trimmed(p, "rule", 120) {
			return invalid()
		}
	default:
		return invalid()
	}
	if !exactFields(p, required, nil) {
		return invalid()
	}
	return p, nil
}
func (g *CommentGovernance) Report(ctx context.Context, a Actor, input Envelope) (any, error) {
	p, e := parseCommentGovernance(input, true)
	if e != nil {
		return nil, e
	}
	return g.run(ctx, a, "moderation", true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "comment-governance:"+str(p, "id")); e != nil {
			return nil, e
		}
		if prior, e := g.accepted(ctx, tx, a, str(p, "id"), input); e != nil || prior != nil {
			return prior, e
		}
		target := obj(p, "target")
		first, e := g.commentRow(ctx, tx, str(target, "id"), false)
		if e != nil {
			return nil, e
		}
		if first == nil {
			return nil, fail("not_found", 404)
		}
		if _, e = g.RequireTaskWithin(ctx, tx, &a.Actor, str(first, "task_id"), false); e != nil {
			return nil, e
		}
		source, e := g.commentRow(ctx, tx, str(target, "id"), true)
		if e != nil {
			return nil, e
		}
		current, e := g.CommentService.ReadWithin(ctx, tx, &a.Actor, str(source, "id"), 0, false)
		if e != nil {
			return nil, e
		}
		if num(source["revision"]) != num(target["revision"]) {
			return nil, fail("comment_report_version_conflict")
		}
		if current["body"] == nil && a.SubjectID != str(source, "subject_id") {
			return nil, fail("comment_report_source_unavailable", 403)
		}
		grant, e := g.governanceGrant(ctx, tx, a.SubjectID, str(p, "id"), input)
		if e != nil {
			return nil, e
		}
		if e = privateCommentRecipients(grant, a.SubjectID, g.ModeratorIDs); e != nil {
			return nil, e
		}
		if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
			return nil, fail("comment_report_author_deletion_pending", 403)
		}
		var count int
		if e = tx.QueryRow(ctx, "SELECT count(*) FROM comment_reports_v2 WHERE comment_id=$1 AND reporter_id=$2", source["id"], a.SubjectID).Scan(&count); e != nil {
			return nil, e
		}
		if count >= 3 {
			return nil, fail("comment_report_limit", 429)
		}
		if _, e = tx.Exec(ctx, "INSERT INTO comment_reports_v2(id,comment_id,comment_revision,reporter_id,subject_id,created_at)VALUES($1,$2,$3,$4,$4,$5)", p["id"], source["id"], target["revision"], a.SubjectID, stamp(g.now())); e != nil {
			return nil, e
		}
		if e = g.save(ctx, tx, a, auth, str(p, "id"), str(p, "id"), "report", 1, input); e != nil {
			return nil, e
		}
		handling := "awaiting-authorized-handler"
		for _, viewer := range grant.Viewers {
			if viewer != a.SubjectID && contains(g.ModeratorIDs, viewer) {
				handling = "awaiting-independent-handler"
			}
		}
		return Object{"reportId": p["id"], "eventId": p["id"], "version": 1, "state": "received", "handlingState": handling, "contentDisposition": "unchanged", "restrictionCreated": false, "capabilityVerdict": "not-decided"}, nil
	})
}
