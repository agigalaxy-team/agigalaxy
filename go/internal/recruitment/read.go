package recruitment

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Get(ctx context.Context, a Actor, id string) (Object, error) {
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.ReadWithin(ctx, tx, a.Device, id, false)
	})
}
func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, requireOpen bool) (Object, error) {
	viewer := ""
	if a != nil {
		if s.Devices == nil {
			return nil, fail("recruitment_service_unavailable", 503)
		}
		if e := s.Devices.AuthorizeWithin(ctx, tx, *a, "history"); e != nil {
			return nil, e
		}
		viewer = a.SubjectID
	}
	return s.readWithin(ctx, tx, a, viewer, id, requireOpen)
}

// readWithin also serves the already-proved Contact context. A subject reference
// never becomes a fabricated authenticated actor or grants task-link access.
func (s *Service) readWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, viewer, id string, requireOpen bool) (Object, error) {
	if s.Projects == nil {
		return nil, fail("recruitment_project_adapter_unavailable", 503)
	}
	r, e := s.source(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	p, e := s.Projects.ReadForContactWithin(ctx, tx, viewer, str(r, "project_id"))
	if e != nil {
		return nil, e
	}
	source, e := row(ctx, tx, "SELECT to_jsonb(e) FROM recruitment_events e WHERE operation_id=$1", r["current_event_id"])
	if e != nil {
		return nil, e
	}
	grant, e := s.grant(ctx, tx, source)
	if e != nil {
		return nil, e
	}
	if !s.canRead(grant, viewer) {
		return nil, fail("recruitment_not_found", 404)
	}
	event, e := ParseEvent([]byte(str(source, "payload_text")))
	if e != nil {
		return nil, e
	}
	if !has([]string{"create", "revise", "renew"}, str(event, "kind")) || event["recruitmentId"] != r["id"] || event["projectId"] != r["project_id"] {
		return nil, fail("recruitment_source_unavailable", 404)
	}
	project, e := s.Projects.SourceRowWithin(ctx, tx, str(r, "project_id"), false)
	if e != nil {
		return nil, e
	}
	publisher, e := s.Projects.RolesWithin(ctx, tx, project, str(r, "publisher_id"))
	if e != nil {
		return nil, e
	}
	contact, e := s.Projects.RolesWithin(ctx, tx, project, str(r, "contact_subject_id"))
	if e != nil {
		return nil, e
	}
	role := func(a []string) bool { return has(a, "owner") || has(a, "representative") }
	authority := role(publisher) && role(contact)
	wish, e := s.Projects.EffectiveWishWithin(ctx, tx, str(r, "contact_subject_id"), str(r, "project_id"), true, []string{"recruitment"})
	if e != nil {
		return nil, e
	}
	blocked := false
	if s.Inbox != nil {
		blocked, e = s.Inbox.IsBlockedWithin(ctx, tx, viewer, str(r, "contact_subject_id"))
		if e != nil {
			return nil, e
		}
	}
	out := s.receipt(r)
	accepting := out["state"] == "active" && authority && truth(wish, "enabled") && !blocked
	if requireOpen && !accepting {
		return nil, fail("recruitment_unavailable_for_contact", 404)
	}
	links := []Object{}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(l) FROM recruitment_task_links l WHERE recruitment_id=$1 ORDER BY task_id", id)
	if e != nil {
		return nil, e
	}
	for _, link := range rr {
		if a == nil || !has(a.Scopes, "assistance") {
			continue
		}
		if s.Tasks == nil {
			return nil, fail("recruitment_task_adapter_unavailable", 503)
		}
		visible, e := func() (bool, error) {
			event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM recruitment_events e WHERE operation_id=$1", link["operation_id"])
			if e != nil {
				return false, e
			}
			g, e := s.grant(ctx, tx, event)
			if e != nil {
				return false, e
			}
			if !s.canRead(g, viewer) {
				return false, nil
			}
			if e = s.Devices.AuthorizeWithin(ctx, tx, *a, "assistance"); e != nil {
				return false, e
			}
			_, e = s.Tasks.RequireTaskWithin(ctx, tx, a, str(link, "task_id"), false)
			return e == nil, e
		}()
		if e != nil {
			if unavailable(e) {
				continue
			}
			return nil, e
		}
		if visible {
			links = append(links, Object{"taskId": link["task_id"], "linkedBy": link["subject_id"], "operationId": link["operation_id"], "linkedAt": iso(link["created_at"])})
		}
	}
	for k, v := range (Object{"document": event["document"], "project": Object{"projectId": p["projectId"], "title": obj(p, "document")["title"], "classification": p["classification"]}, "acceptingContacts": accepting, "representativeCurrentlyAuthorized": authority, "contactPreferenceEnabled": wish["enabled"], "classification": "declared-role-requirement", "capabilityVerified": false, "taskLinks": links, "taskLinkScope": "currently-readable-tasks-only", "originalSource": Object{"operationId": source["operation_id"], "subjectId": source["subject_id"], "consentId": source["consent_id"], "payloadHash": source["payload_hash"], "recordedAt": iso(source["created_at"])}, "interpretation": "user-side-model-or-user", "activeEntries": []string{"discover", "publish-task", "participate-task", "ordinary-chat"}}) {
		out[k] = v
	}
	return out, nil
}
func (s *Service) OperationReceipt(ctx context.Context, a Actor, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil || !strict(q, "recruitmentId", "operationId", "payloadHash") || !opportunities.UUID.MatchString(str(q, "recruitmentId")) || !opportunities.UUID.MatchString(str(q, "operationId")) || !hashPattern.MatchString(str(q, "payloadHash")) {
		return nil, fail("invalid_recruitment_receipt_query", 400)
	}
	if a.Device == nil {
		return nil, fail("access_denied", 401)
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		r, e := row(ctx, tx, "SELECT to_jsonb(e) FROM (SELECT operation_id,recruitment_id,payload_hash,revision,created_at FROM recruitment_events WHERE operation_id=$1 AND subject_id=$2)e", q["operationId"], a.Device.SubjectID)
		if e != nil {
			return nil, e
		}
		out := Object{"schemaVersion": 2, "query": q, "authority": "accepted-operation-only", "audience": "owner-only", "currentAccessGranted": false, "contentReturned": false, "sourceAccessChecked": false}
		if r == nil {
			out["state"] = "absent"
			out["absenceMeaning"] = "no-retained-owner-operation"
		} else if r["recruitment_id"] != q["recruitmentId"] || r["payload_hash"] != q["payloadHash"] {
			out["state"] = "conflict"
			out["reason"] = "original-operation-mismatch"
		} else {
			out["state"] = "acknowledged"
			out["receipt"] = Object{"recruitmentId": q["recruitmentId"], "operationId": q["operationId"], "payloadHash": q["payloadHash"], "revision": r["revision"], "acceptedAt": iso(r["created_at"])}
		}
		return out, nil
	})
}
