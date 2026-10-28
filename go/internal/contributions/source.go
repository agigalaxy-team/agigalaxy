package contributions

import (
	"context"
	"encoding/json"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

var publishableTaskKinds = []string{"task-created", "participation-proposed", "confirm", "propose-scope", "confirm-scope", "deliver", "accept", "withdraw", "cancel", "close", "dispute", "propose-resolution", "confirm-resolution", "requester-feedback"}

func tableInfo(kind string) (table, parent, action string, err error) {
	switch kind {
	case "case-event":
		return "case_events", "case_id", "case.teaser.publish", nil
	case "task-event":
		return "task_events", "task_id", "assistance.publish", nil
	}
	return "", "", "", fail("contribution_source_kind_not_publishable", 422)
}
func (s *Service) SourceWithin(ctx context.Context, tx pgx.Tx, ref Object) (Object, error) {
	table, parent, _, e := tableInfo(str(ref, "kind"))
	if e != nil {
		return nil, e
	}
	located, e := row(ctx, tx, "SELECT to_jsonb(e) FROM "+table+" e WHERE id=$1", ref["id"])
	if e != nil {
		return nil, e
	}
	if located == nil {
		return nil, fail("contribution_source_unavailable", 404)
	}
	parentTable := "task_requests"
	if ref["kind"] == "case-event" {
		parentTable = "cases"
	}
	if _, e = tx.Exec(ctx, "SELECT id FROM "+parentTable+" WHERE id=$1 FOR SHARE", located[parent]); e != nil {
		return nil, e
	}
	current, e := row(ctx, tx, "SELECT to_jsonb(e) FROM "+table+" e WHERE id=$1", ref["id"])
	if e != nil {
		return nil, e
	}
	if current == nil || str(current, "payload_text") == "" || current["payload_hash"] != ref["payloadHash"] {
		return nil, fail("contribution_source_unavailable", 404)
	}
	if ref["kind"] == "task-event" && !has(publishableTaskKinds, str(current, "kind")) {
		return nil, fail("contribution_source_kind_not_publishable", 422)
	}
	return current, nil
}
func (s *Service) SourceGrantWithin(ctx context.Context, tx pgx.Tx, kind string, current Object) (deviceauth.ConsentIntent, error) {
	empty := deviceauth.ConsentIntent{}
	if current == nil || str(current, "payload_text") == "" {
		return empty, fail("contribution_source_unavailable", 404)
	}
	_, _, action, e := tableInfo(kind)
	if e != nil {
		return empty, e
	}
	grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(current, "consent_id"), SubjectID: str(current, "subject_id"), ObjectID: str(current, "id"), Action: action, Recipient: s.Endpoint, PayloadJSON: str(current, "payload_text")})
	if e != nil {
		return grant, e
	}
	if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
		return grant, fail("contribution_source_unavailable", 404)
	}
	if kind == "case-event" {
		parent, e := row(ctx, tx, "SELECT jsonb_build_object('state',state) FROM cases WHERE id=$1 FOR SHARE", current["case_id"])
		if e != nil {
			return grant, e
		}
		if parent == nil || parent["state"] == "withdrawn" {
			return grant, fail("contribution_source_unavailable", 404)
		}
	} else {
		parent, e := row(ctx, tx, "SELECT jsonb_build_object('snapshot',snapshot) FROM task_requests WHERE id=$1 FOR SHARE", current["task_id"])
		if e != nil {
			return grant, e
		}
		if parent == nil || object(parent["snapshot"])["contentDeleted"] == true {
			return grant, fail("contribution_source_unavailable", 404)
		}
	}
	return grant, nil
}
func (s *Service) AuthorizeWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, kind string, current Object, purpose string) (Permission, error) {
	permission := Permission{PublicationIDs: []string{}, Fields: []string{}, FieldExpiresAt: map[string]float64{}}
	original, e := s.SourceGrantWithin(ctx, tx, kind, current)
	if e != nil {
		return permission, e
	}
	permission.Original = original
	if s.visible(original, a) {
		permission.Fields = append([]string{}, ProjectionFields...)
		return permission, nil
	}
	ref := Object{"kind": kind, "id": current["id"], "eventVersion": 1, "payloadHash": current["payload_hash"]}
	raw, e := json.Marshal([]any{ref})
	if e != nil {
		return permission, e
	}
	published, e := rows(ctx, tx, `SELECT to_jsonb(p)||jsonb_build_object('grant_binding_expires',b.expires_at) FROM contribution_publications p JOIN consents c ON c.id=p.consent_id AND c.subject_id=p.subject_id JOIN bindings b ON b.id=c.binding_id WHERE p.subject_id=$1 AND p.source_refs @> $2::jsonb AND p.revoked_at IS NULL ORDER BY p.id FOR SHARE OF p`, current["subject_id"], raw)
	if e != nil {
		return permission, e
	}
	for _, p := range published {
		err := func() error {
			if str(p, "payload_text") == "" {
				return fail("contribution_publication_unavailable", 404)
			}
			payload, e := ParsePublication([]byte(str(p, "payload_text")))
			if e != nil {
				return e
			}
			expiry, _ := date(payload["expiresAt"])
			if payload["kind"] != "publish" || !has(stringsIn(payload["purposes"]), purpose) || expiry.UnixMilli() <= s.now()*1000 {
				return fail("contribution_publication_unavailable", 404)
			}
			grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(p, "consent_id"), SubjectID: str(current, "subject_id"), ObjectID: str(p, "id"), Action: "contribution.publish", Recipient: s.Endpoint, PayloadJSON: str(p, "payload_text")})
			if e != nil {
				return e
			}
			if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending || grant.Visibility != "Public" || !s.visible(grant, a) {
				return fail("contribution_publication_unavailable", 404)
			}
			var selected Object
			for _, v := range array(payload["sourceRefs"]) {
				r := object(v)
				if r["kind"] == kind && r["id"] == current["id"] && r["payloadHash"] == current["payload_hash"] {
					selected = r
					break
				}
			}
			if selected == nil {
				return fail("contribution_publication_unavailable", 404)
			}
			binding, e := time.Parse(time.RFC3339Nano, str(p, "grant_binding_expires"))
			if e != nil {
				return e
			}
			expiresAt := min(float64(expiry.UnixMilli())/1000, float64(grant.ExpiresAt), float64(binding.UnixMilli())/1000)
			permission.PublicationIDs = append(permission.PublicationIDs, str(p, "id"))
			for _, field := range stringsIn(selected["fields"]) {
				if !has(permission.Fields, field) {
					permission.Fields = append(permission.Fields, field)
				}
				permission.FieldExpiresAt[field] = max(permission.FieldExpiresAt[field], expiresAt)
			}
			return nil
		}()
		if err != nil && !absent(err) {
			return permission, err
		}
	}
	if len(permission.PublicationIDs) > 0 {
		return permission, nil
	}
	return permission, fail("contribution_source_unavailable", 404)
}
func (s *Service) Reference(current Object, kind string, permission Permission) Object {
	if len(permission.PublicationIDs) > 0 {
		raw, _ := protocol.EncodeJS([]any{kind, current["id"], current["payload_hash"]})
		return Object{"publicationId": permission.PublicationIDs[0], "sourceKey": identity.Digest(raw)}
	}
	return Object{"kind": kind, "id": current["id"], "eventVersion": 1, "payloadHash": current["payload_hash"]}
}

// Project preserves the original nonnarrative source projection used by peering.
// It confers no source authorization; the caller must check the current source
// grant and the separate peer publication grant in the same transaction.
func (s *Service) Project(current Object, fields []string) (Object, error) {
	value, e := jstext.DecodeJSON([]byte(str(current, "payload_text")))
	if e != nil {
		return nil, e
	}
	payload := object(value)
	event := object(payload["event"])
	if event == nil {
		event = payload
	}
	var feedback any
	if event["kind"] == "requester-feedback" {
		feedback = Object{"descriptionClarity": event["descriptionClarity"], "scopeMatched": event["scopeMatched"]}
	}
	var summary any
	for _, key := range []string{"summary", "reason", "note"} {
		if event[key] != nil {
			summary = event[key]
			break
		}
	}
	created, e := time.Parse(time.RFC3339Nano, str(current, "created_at"))
	if e != nil {
		return nil, e
	}
	caseID, taskID, participationID := current["case_id"], current["task_id"], current["participation_id"]
	if taskID == nil {
		taskID = event["taskId"]
	}
	if participationID == nil {
		participationID = event["participationId"]
	}
	values := Object{"eventType": current["kind"], "actorId": current["subject_id"], "role": event["role"], "interventionTypes": event["types"], "scopeVersion": event["scopeVersion"], "reportedOutcome": event["reportedOutcome"], "feedback": feedback, "scope": event["agreedScope"], "title": event["title"], "summary": summary, "time": created.UTC().Format("2006-01-02T15:04:05.000Z"), "caseId": caseID, "taskId": taskID, "participationId": participationID}
	projection := Object{}
	for _, field := range fields {
		projection[field] = values[field]
	}
	return projection, nil
}

func (s *Service) ProjectWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, current Object, fields []string, permission Permission) (Object, error) {
	projection, e := s.Project(current, fields)
	if e != nil {
		return nil, e
	}
	selected := []string{}
	for _, field := range fields {
		if field == "title" || field == "summary" {
			selected = append(selected, field)
		}
	}
	if current["kind"] != "task-created" || len(selected) == 0 {
		return projection, nil
	}
	value, e := jstext.DecodeJSON([]byte(str(current, "payload_text")))
	if e != nil {
		return nil, e
	}
	payload := object(value)
	request := payload
	hasText := len(array(request["materials"])) > 0
	for _, value := range []any{request["title"], request["summary"], object(request["workContext"])["goal"], object(request["workContext"])["currentSituation"], request["expectedOutcome"]} {
		if value != nil {
			if _, ok := value.(string); !ok {
				hasText = true
			}
		}
	}
	if !hasText {
		return projection, nil
	}
	if s.Tasks == nil {
		return nil, fail("task_material_reader_unavailable", 503)
	}
	task, e := row(ctx, tx, "SELECT jsonb_build_object('id',id,'requester_id',requester_id,'root_event_id',root_event_id,'snapshot',snapshot) FROM task_requests WHERE id=$1 AND root_event_id=$2", current["task_id"], current["id"])
	if e != nil {
		return nil, e
	}
	if task == nil || object(task["snapshot"])["contentDeleted"] == true {
		return nil, fail("contribution_source_unavailable", 404)
	}
	projected, e := s.Tasks.ProjectWithin(ctx, tx, a, task, selected)
	if e != nil {
		return nil, e
	}
	textView := object(projected["textView"])
	for _, field := range selected {
		view := object(object(textView["fields"])[field])
		if until, ok := permission.FieldExpiresAt[field]; ok && view["availableUntil"] != nil {
			var current float64
			switch v := view["availableUntil"].(type) {
			case int64:
				current = float64(v)
			case float64:
				current = v
			case int:
				current = float64(v)
			}
			view["availableUntil"] = min(current, until)
		}
		projection[field] = view["text"]
	}
	projection["textView"] = textView
	return projection, nil
}
