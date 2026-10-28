package taskmaterials

import (
	"context"
	"errors"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func ownerControlEffects(out Object) Object {
	out["historyRetained"] = true
	out["materialAccessChanged"] = false
	out["completeTaskAccessGranted"] = false
	out["settlementExecuted"] = false
	return out
}
func (s *Service) ownerControlSource(ctx context.Context, tx pgx.Tx, a Actor, id string, auth deviceauth.ControlAuthorization) (Object, []Object, error) {
	control, e := ownerCurrent(a, auth)
	if e != nil {
		return nil, nil, e
	}
	task, events, e := s.ownerSource(ctx, tx, a, id, nil, control)
	if fault.Code(e) == "task_owner_read_source_unavailable" {
		e = fail("task_owner_control_source_unavailable", 403)
	}
	return task, events, e
}
func ownerControlPaused(ctx context.Context, tx pgx.Tx, task Object, kind string) error {
	if task["case_id"] == nil || kind != "close" {
		return nil
	}
	var paused bool
	if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM moderation_reports WHERE case_id=$1 AND paused=true)", task["case_id"]).Scan(&paused); e != nil {
		return e
	}
	if paused {
		return fail("task_paused", 403)
	}
	return nil
}
func (s *Service) OwnerControlPrepare(ctx context.Context, a Actor, input Object) (any, error) {
	if !exactFields(input, []string{"taskId", "operationId", "kind", "reason"}, []string{"terminationIntent"}) || !validID(str(input, "taskId")) || !validID(str(input, "operationId")) || !contains([]string{"cancel", "close", "stop-enrollment"}, str(input, "kind")) || !trimmed(input, "reason", 1500) {
		return nil, fail("invalid_task_owner_control", 400)
	}
	if intent, ok := input["terminationIntent"]; ok && intent != "terminate-task" {
		return nil, fail("invalid_task_owner_control", 400)
	}
	if input["kind"] == "close" && input["terminationIntent"] != "terminate-task" {
		return nil, fail("task_termination_intent_required")
	}
	return s.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		task, events, e := s.ownerControlSource(ctx, tx, a, str(input, "taskId"), auth)
		if e != nil {
			return nil, e
		}
		root := events[0]
		prior, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", input["operationId"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["task_id"] == task["id"] && prior["subject_id"] == a.SubjectID {
				return nil, fail("task_owner_control_receipt_required")
			}
			return nil, fail("task_event_conflict")
		}
		current, e := row(ctx, tx, "SELECT jsonb_build_object('state',snapshot->>'state') FROM task_requests WHERE id=$1", task["id"])
		if e != nil {
			return nil, e
		}
		if contains([]string{"canceled", "closed"}, str(current, "state")) {
			return nil, fail("task_transition_denied")
		}
		if e = ownerControlPaused(ctx, tx, task, str(input, "kind")); e != nil {
			return nil, e
		}
		event := taskOrdered("eventId", input["operationId"], "expectedTaskVersion", task["version"], "kind", input["kind"], "reason", input["reason"])
		if input["kind"] == "close" {
			event.Set("terminationIntent", input["terminationIntent"])
		}
		envelope := taskOrdered("taskId", task["id"], "event", event)
		payload := string(jsonBytes(envelope))
		control, e := ownerCurrent(a, auth)
		if e != nil {
			return nil, e
		}
		authorization := Object{"action": "assistance.publish", "objectId": input["operationId"], "visibility": "Private", "viewers": []any{}, "purpose": "operational", "recipient": s.Endpoint, "fields": []string{"taskId", "event"}}
		for key, value := range control {
			authorization[key] = value
		}
		return ownerControlEffects(Object{"taskId": task["id"], "operationId": input["operationId"], "kind": input["kind"], "expectedTaskVersion": task["version"], "payloadJson": payload, "payloadHash": identity.Digest([]byte(payload)), "expiresAt": min(s.now()+3600, num(root["readExpiresAt"])), "authorization": authorization, "source": Object{"eventId": root["id"], "version": root["version"], "payloadHash": root["payload_hash"], "expiresAt": root["readExpiresAt"]}}), nil
	})
}
func (s *Service) OwnerControl(ctx context.Context, a Actor, taskID string, input Envelope) (any, error) {
	if !validID(input.ConsentID) || !validText(input.PayloadJSON, 20000) {
		return nil, fail("invalid_task_owner_control", 400)
	}
	envelope, e := parseTaskEvent(input.PayloadJSON)
	if e != nil || !contains([]string{"cancel", "close", "stop-enrollment"}, str(obj(envelope, "event"), "kind")) {
		return nil, fail("invalid_task_owner_control", 400)
	}
	if envelope["taskId"] != taskID {
		return nil, fail("task_owner_control_scope_mismatch", 403)
	}
	event := obj(envelope, "event")
	kind := str(event, "kind")
	out, e := s.run(ctx, a, "assistance", true, true, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "task-owner-control-event:"+str(event, "eventId")); e != nil {
			return nil, e
		}
		task, e := row(ctx, tx, "SELECT to_jsonb(t) FROM task_requests t WHERE id=$1 FOR UPDATE", taskID)
		if e != nil {
			return nil, e
		}
		if task == nil || task["requester_id"] != a.SubjectID {
			return nil, fail("not_found", 404)
		}
		_, events, e := s.ownerControlSource(ctx, tx, a, taskID, auth)
		if e != nil {
			return nil, e
		}
		root := events[0]
		grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: input.ConsentID, SubjectID: a.SubjectID, Action: "assistance.publish", ObjectID: str(event, "eventId"), Recipient: s.Endpoint, PayloadJSON: input.PayloadJSON})
		if e != nil {
			return nil, e
		}
		if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
			return nil, fail("task_owner_control_source_unavailable", 403)
		}
		if grant.BindingID != a.BindingID || grant.Visibility != "Private" || len(grant.Viewers) != 0 || grant.Purpose != "operational" || len(grant.Fields) != 2 || !contains(grant.Fields, "taskId") || !contains(grant.Fields, "event") || grant.ExpiresAt > min(s.now()+3600, num(root["readExpiresAt"])) {
			return nil, fail("task_owner_control_scope_mismatch", 403)
		}
		original, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", root["id"])
		if e != nil {
			return nil, e
		}
		if original == nil || str(original, "payload_text") == "" || identity.Digest([]byte(str(original, "payload_text"))) != root["payload_hash"] {
			return nil, fail("task_owner_control_integrity_error", 500)
		}
		result := func(receipt Object) Object {
			receipt["state"] = "closed"
			if kind == "cancel" {
				receipt["state"] = "canceled"
			}
			if kind == "stop-enrollment" {
				receipt["state"] = "enrollment-stopped"
			}
			receipt["payloadHash"] = identity.Digest([]byte(input.PayloadJSON))
			receipt["authority"] = "accepted-operation-only"
			receipt["currentAccessGranted"] = false
			return ownerControlEffects(receipt)
		}
		if prior, e := taskReplay(ctx, tx, a, taskID, str(event, "eventId"), input.ConsentID, input.PayloadJSON); e != nil || prior != nil {
			if e != nil {
				return nil, e
			}
			return result(prior), nil
		}
		if e = ownerControlPaused(ctx, tx, task, kind); e != nil {
			return nil, e
		}
		next, e := applyTaskEvent(obj(task, "snapshot"), a.SubjectID, event, s.now())
		if e != nil {
			return nil, e
		}
		if e = saveTask(ctx, tx, next); e != nil {
			return nil, e
		}
		receipt, e := s.recordTaskEvent(ctx, tx, a, auth, next, str(event, "eventId"), kind, input.ConsentID, input.PayloadJSON, nil)
		if e != nil {
			return nil, e
		}
		return result(receipt), nil
	})
	var pgError *pgconn.PgError
	if errors.As(e, &pgError) && pgError.Code == "23505" {
		return nil, fail("task_event_conflict")
	}
	return out, e
}
