package taskmaterials

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

func (s *Service) grant(ctx context.Context, tx pgx.Tx, event Object) (deviceauth.ConsentIntent, error) {
	if event == nil || str(event, "payload_text") == "" || contains([]string{"suggest-contacts", "invite", "invitation-reply", "apply", "withdraw-application", "revoke-invitation"}, str(event, "kind")) && sec(event["created_at"])+90*86400 <= s.now() {
		return deviceauth.ConsentIntent{}, fail("task_content_unavailable", 403)
	}
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(event, "consent_id"), SubjectID: str(event, "subject_id"), Action: "assistance.publish", ObjectID: str(event, "id"), Recipient: s.Endpoint, PayloadJSON: str(event, "payload_text")})
}
func (s *Service) visible(g deviceauth.ConsentIntent, viewer string) bool {
	if g.IssuedAt > s.now() || g.ExpiresAt <= s.now() {
		return false
	}
	if viewer == g.SubjectID {
		return true
	}
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
		return false
	}
	switch g.Visibility {
	case "Public":
		return g.Purpose == "public-profile"
	case "Private":
		return viewer != "" && contains(g.Viewers, viewer)
	}
	return false
}

// RequireTaskWithin is the original current Task authority, not an existence
// check. It is used within the caller's already authenticated transaction.
func (s *Service) RequireTaskWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, write bool) (Object, error) {
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	return s.requireTaskViewerWithin(ctx, tx, viewer, id, write)
}
func (s *Service) requireTaskViewerWithin(ctx context.Context, tx pgx.Tx, viewer, id string, write bool) (Object, error) {
	lock := "SHARE"
	if write {
		lock = "UPDATE"
	}
	task, e := row(ctx, tx, "SELECT to_jsonb(t) FROM task_requests t WHERE id=$1 FOR "+lock, id)
	if e != nil {
		return nil, e
	}
	if task == nil || truth(obj(task, "snapshot")["contentDeleted"]) {
		return nil, fail("not_found", 404)
	}
	root, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", task["root_event_id"])
	if e != nil {
		return nil, e
	}
	if root == nil || str(root, "payload_text") == "" {
		return nil, fail("not_found", 404)
	}
	grant, e := s.grant(ctx, tx, root)
	if e != nil {
		return nil, e
	}
	if !s.visible(grant, viewer) {
		return nil, fail("not_found", 404)
	}
	if task["case_id"] != nil {
		parent, e := row(ctx, tx, "SELECT to_jsonb(c) FROM cases c WHERE id=$1 AND subject_id=$2 FOR SHARE", task["case_id"], task["requester_id"])
		if e != nil {
			return nil, e
		}
		if parent == nil || str(parent, "state") == "withdrawn" {
			return nil, fail("task_case_unavailable", 403)
		}
	}
	paused := false
	if task["case_id"] != nil {
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM moderation_reports WHERE case_id=$1 AND paused=true)", task["case_id"]).Scan(&paused); e != nil {
			return nil, e
		}
	}
	reports, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM target_reports_v2 r WHERE task_id=$1 AND restriction_until>$2 ORDER BY id", id, time.Unix(s.now(), 0))
	if e != nil {
		return nil, e
	}
	scopes := []string{}
	restrictions := []Object{}
	for _, report := range reports {
		rs := stringsOf(report["restriction_scopes"])
		for _, v := range rs {
			if !contains(scopes, v) {
				scopes = append(scopes, v)
			}
		}
		restrictions = append(restrictions, Object{"reportId": report["id"], "eventId": report["restriction_event_id"], "scopes": rs, "until": stamp(sec(report["restriction_until"]))})
	}
	governance := Object{"scopes": scopes, "restrictions": restrictions, "authority": "current-target-operation-restrictions; not-capability-or-source-permission"}
	if contains(scopes, "discovery-hidden") && viewer != str(task, "requester_id") {
		related := false
		if viewer != "" {
			for _, v := range arr(obj(task, "snapshot")["invitations"]) {
				inv, _ := v.(map[string]any)
				if str(inv, "recipientId") == viewer {
					related = true
				}
			}
			if !related {
				if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM task_participations WHERE task_id=$1 AND subject_id=$2 UNION SELECT 1 FROM task_events WHERE task_id=$1 AND subject_id=$2)", id, viewer).Scan(&related); e != nil {
					return nil, e
				}
			}
		}
		if !related {
			return nil, fail("not_found", 404)
		}
	}
	return Object{"row": task, "snapshot": task["snapshot"], "requesterId": task["requester_id"], "caseId": task["case_id"], "rootGrant": grant, "paused": paused, "governance": governance}, nil
}

func (s *Service) RequireParticipationWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, taskID, participationID string, write bool) (Object, error) {
	task, e := s.RequireTaskWithin(ctx, tx, &a, taskID, write)
	if e != nil {
		return nil, e
	}
	mode := "SHARE"
	if write {
		mode = "UPDATE"
	}
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM task_participations p WHERE id=$1 FOR "+mode, participationID)
	if e != nil {
		return nil, e
	}
	if p == nil || truth(obj(p, "snapshot")["contentDeleted"]) || str(p, "task_id") != taskID || !contains([]string{str(p, "subject_id"), str(task, "requesterId")}, a.SubjectID) {
		return nil, fail("participation_not_authorized", 403)
	}
	state := obj(p, "snapshot")
	seen := map[string]bool{}
	for _, id := range []string{str(state, "proposalEventId"), str(state, "scopeEventId")} {
		if seen[id] {
			continue
		}
		seen[id] = true
		event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", id)
		if e != nil {
			return nil, e
		}
		grant, e := s.grant(ctx, tx, event)
		if e != nil {
			return nil, e
		}
		if !s.visible(grant, a.SubjectID) {
			return nil, fail("participation_not_authorized", 403)
		}
	}
	result := clone(state)
	result["paused"] = task["paused"]
	result["taskState"] = obj(task, "snapshot")["state"]
	return result, nil
}

// AttachCaseWithin is the original TaskRepository owner CAS. Case owns the
// surrounding confirmed operation/receipt transaction; no Task version changes.
func (s *Service) AttachCaseWithin(ctx context.Context, tx pgx.Tx, taskID, caseID, requesterID string) (Object, error) {
	task, e := row(ctx, tx, "SELECT to_jsonb(t) FROM task_requests t WHERE id=$1 FOR UPDATE", taskID)
	if e != nil {
		return nil, e
	}
	if task == nil || str(task, "requester_id") != requesterID {
		return nil, fail("task_case_link_denied", 403)
	}
	if task["case_id"] != nil && str(task, "case_id") != caseID {
		return nil, fail("task_case_link_conflict")
	}
	if str(task, "case_id") == caseID {
		return task, nil
	}
	snapshot := obj(task, "snapshot")
	obj(snapshot, "request")["caseId"] = caseID
	if _, e = tx.Exec(ctx, "UPDATE task_requests SET version=$2,snapshot=$3::jsonb,case_id=$4 WHERE id=$1", taskID, num(snapshot["version"]), jsonBytes(snapshot), caseID); e != nil {
		return nil, e
	}
	task["case_id"] = caseID
	return task, nil
}
