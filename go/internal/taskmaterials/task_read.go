package taskmaterials

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func clone(v Object) Object { var out Object; _ = json.Unmarshal(jsonBytes(v), &out); return out }
func (s *Service) ReadTaskWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, error) {
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	return s.readTaskViewerWithin(ctx, tx, viewer, a != nil, id)
}
func (s *Service) readTaskViewerWithin(ctx context.Context, tx pgx.Tx, viewer string, identified bool, id string) (Object, error) {
	access, e := s.requireTaskViewerWithin(ctx, tx, viewer, id, false)
	if e != nil {
		return nil, e
	}
	task := obj(access, "row")
	state := obj(task, "snapshot")
	request := obj(state, "request")
	requester := identified && viewer == str(task, "requester_id")
	governance := obj(access, "governance")
	enrollment := str(obj(state, "enrollment"), "state")
	if enrollment == "" {
		enrollment = "open"
	}
	view := "public"
	if requester {
		view = "requester"
	} else if identified {
		view = "participant-or-reader"
	}
	out := Object{"schemaVersion": 2, "taskId": id, "caseId": task["case_id"], "request": request, "requesterId": task["requester_id"], "version": state["version"], "state": state["state"], "enrollmentState": enrollment, "enrollmentOpen": str(state, "state") == "open" && enrollment != "stopped" && num(request["enrollmentExpiresAt"]) > s.now() && !contains(stringsOf(governance["scopes"]), "new-participation-paused"), "paused": access["paused"], "governance": governance, "paymentExecuted": false, "contextAccessGranted": false, "roomMembershipGranted": false, "compatibility": Object{"writableApiVersion": 2, "legacyWrites": false}, "view": view}
	material := len(arr(request["materials"])) > 0
	for _, v := range textFields(request) {
		if _, ok := v.(string); !ok {
			material = true
		}
	}
	if material {
		projection, e := s.projectViewerWithin(ctx, tx, viewer, task, nil)
		if e != nil {
			return nil, e
		}
		for k, v := range projection {
			out[k] = v
		}
	}
	if !identified {
		return out, nil
	}
	events, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE task_id=$1 ORDER BY version", id)
	if e != nil {
		return nil, e
	}
	visible := map[string]bool{}
	for _, event := range events {
		grant, e := s.grant(ctx, tx, event)
		if e != nil {
			if fault.Status(e) == 403 || fault.Status(e) == 404 {
				continue
			}
			return nil, e
		}
		if s.visible(grant, viewer) {
			visible[str(event, "id")] = true
		}
	}
	suggestions := Object{"state": "private", "items": []any{}}
	if requester {
		suggestions["state"] = "not-available"
		if visible[str(obj(state, "suggestions"), "eventId")] {
			suggestions = clone(obj(state, "suggestions"))
		}
	}
	invitations := []Object{}
	for _, v := range arr(state["invitations"]) {
		i, ok := v.(map[string]any)
		if !ok || !requester && str(i, "recipientId") != viewer || !visible[str(i, "invitationId")] {
			continue
		}
		value := clone(i)
		replies := []Object{}
		for _, v := range arr(i["replies"]) {
			reply, _ := v.(map[string]any)
			if visible[str(reply, "eventId")] {
				replies = append(replies, reply)
			}
		}
		if str(i, "state") == "revoked" {
			value["state"] = "revoked"
		} else if num(i["expiresAt"]) <= s.now() {
			value["state"] = "expired"
		} else if len(replies) > 0 {
			value["state"] = replies[len(replies)-1]["response"]
		} else {
			value["state"] = "pending"
		}
		value["replies"] = replies
		invitations = append(invitations, value)
	}
	applications := []Object{}
	for _, v := range arr(state["applications"]) {
		application, _ := v.(map[string]any)
		if (requester || str(application, "subjectId") == viewer) && visible[str(application, "applicationId")] {
			applications = append(applications, application)
		}
	}
	out["contacts"] = Object{"suggestions": suggestions, "responses": Object{"invitations": invitations, "applications": applications}}
	participations, e := rows(ctx, tx, "SELECT to_jsonb(p) FROM task_participations p WHERE task_id=$1 ORDER BY id", id)
	if e != nil {
		return nil, e
	}
	projected := []Object{}
	for _, p := range participations {
		snapshot := obj(p, "snapshot")
		if !requester && str(p, "subject_id") != viewer || !visible[str(snapshot, "proposalEventId")] {
			continue
		}
		own := clone(snapshot)
		if !visible[str(own, "scopeEventId")] {
			own["agreedScope"] = nil
			own["scopeAvailable"] = false
		}
		if pending := obj(own, "pendingScope"); pending != nil && !visible[str(pending, "eventId")] {
			own["pendingScope"] = nil
		}
		deliveries := []Object{}
		for _, v := range arr(own["deliveries"]) {
			d, _ := v.(map[string]any)
			if !visible[str(d, "deliveryId")] {
				continue
			}
			copy := clone(d)
			if acceptance := obj(copy, "acceptance"); acceptance != nil && !visible[str(acceptance, "eventId")] {
				copy["acceptance"] = nil
			}
			deliveries = append(deliveries, copy)
		}
		own["deliveries"] = deliveries
		for _, field := range []string{"dispute", "disputeResolution", "feedback"} {
			if value := obj(own, field); value != nil && !visible[str(value, "eventId")] {
				own[field] = nil
			}
		}
		records := []Object{}
		for _, v := range arr(own["events"]) {
			record, _ := v.(map[string]any)
			if visible[str(obj(record, "event"), "eventId")] {
				records = append(records, record)
			}
		}
		own["events"] = records
		projected = append(projected, own)
	}
	out["participations"] = projected
	return out, nil
}
func (s *Service) GetTask(ctx context.Context, a *Actor, id string) (any, error) {
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	read := func(tx pgx.Tx) (any, error) {
		var exists bool
		if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM task_requests WHERE id=$1)", id).Scan(&exists); e != nil {
			return nil, e
		}
		if !exists {
			if a == nil {
				return nil, fail("not_found", 404)
			}
			if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM assistance_requests WHERE id=$1)", id).Scan(&exists); e != nil {
				return nil, e
			}
			if exists {
				legacy, e := s.LegacyReadWithin(ctx, tx, &a.Actor, id)
				if e != nil {
					return nil, e
				}
				return legacyTaskView(legacy), nil
			}
		}
		var actor *deviceauth.Actor
		if a != nil {
			actor = &a.Actor
		}
		return s.ReadTaskWithin(ctx, tx, actor, id)
	}
	if a == nil {
		return postgres.InTx(ctx, s.Pool, read)
	}
	return s.run(ctx, *a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) { return read(tx) })
}
func (s *Service) TaskReceipt(ctx context.Context, a Actor, taskID, eventID, hash string) (any, error) {
	if !validID(taskID) || !validID(eventID) || !hashPattern.MatchString(hash) {
		return nil, fail("invalid_task_receipt", 400)
	}
	return s.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", eventID)
		if e != nil {
			return nil, e
		}
		if event != nil && str(event, "subject_id") != a.SubjectID {
			return nil, fail("not_found", 404)
		}
		state := "absent"
		matches := event != nil && str(event, "task_id") == taskID && str(event, "payload_hash") == hash
		if event != nil {
			state = "conflict"
		}
		if matches {
			state = "acknowledged"
		}
		out := Object{"taskId": taskID, "eventId": eventID, "payloadHash": hash, "state": state, "checkedAt": s.now(), "authority": "accepted-event-only; not-current-authorization"}
		if matches {
			out["version"] = event["version"]
			out["participationVersion"] = event["participation_version"]
			out["participationId"] = event["participation_id"]
			out["kind"] = event["kind"]
		}
		return out, nil
	})
}
func (s *Service) QueryTasks(ctx context.Context, a *Actor, view, query, after string, limit int) (any, error) {
	return s.queryTasks(ctx, a, view, query, after, limit, false)
}
func (s *Service) queryTasks(ctx context.Context, a *Actor, view, query, after string, limit int, wire bool) (any, error) {
	if view == "" {
		view = "open"
	}
	if limit == 0 {
		limit = 12
	}
	query = jsTrim(query)
	if !contains([]string{"open", "requested", "participating"}, view) || a == nil && view != "open" || protocol.TextLength(query) > 200 || after != "" && !validID(after) || limit < 1 || limit > 40 {
		return nil, fail("invalid_task_query", 400)
	}
	operation := func(tx pgx.Tx) (any, error) {
		items := []Object{}
		var position any
		if after != "" {
			position = after
		}
		var subject any
		if a != nil {
			subject = a.SubjectID
		}
		for {
			candidates, e := rows(ctx, tx, `SELECT jsonb_build_object('id',id) FROM task_requests WHERE ($1::uuid IS NULL OR id>$1) AND ($2='open' AND snapshot->>'state'='open' AND COALESCE(snapshot->'enrollment'->>'state','open')='open' AND (snapshot->'request'->>'enrollmentExpiresAt')::bigint>$3 OR $2='requested' AND requester_id=$4 OR $2='participating' AND EXISTS(SELECT 1 FROM task_participations p WHERE p.task_id=task_requests.id AND p.subject_id=$4) OR $2='participating' AND snapshot->'invitations' @> jsonb_build_array(jsonb_build_object('recipientId',$4::text)) OR $2='participating' AND EXISTS(SELECT 1 FROM task_events e WHERE e.task_id=task_requests.id AND e.subject_id=$4)) ORDER BY id LIMIT 100`, position, view, s.now(), subject)
			if e != nil {
				return nil, e
			}
			for _, candidate := range candidates {
				var device *deviceauth.Actor
				if a != nil {
					device = &a.Actor
				}
				item, e := s.ReadTaskWithin(ctx, tx, device, str(candidate, "id"))
				if e != nil {
					if fault.Status(e) == 403 || fault.Status(e) == 404 {
						continue
					}
					return nil, e
				}
				g := obj(item, "governance")
				if view == "open" && (truth(item["paused"]) || contains(stringsOf(g["scopes"]), "discovery-hidden") || contains(stringsOf(g["scopes"]), "new-participation-paused")) {
					continue
				}
				request := obj(item, "request")
				if !strings.Contains(strings.ToLower(str(request, "title")+" "+str(request, "summary")), strings.ToLower(query)) {
					continue
				}
				delete(item, "contacts")
				delete(item, "participations")
				items = append(items, item)
				if len(items) > limit {
					break
				}
			}
			if len(items) > limit || len(candidates) < 100 {
				break
			}
			position = candidates[len(candidates)-1]["id"]
		}
		var next any
		if len(items) > limit {
			next = items[limit-1]["taskId"]
		}
		page := items[:min(len(items), limit)]
		if wire {
			return s.queryTasksWireWithin(ctx, tx, page, next)
		}
		return Object{"items": page, "nextAfter": next, "coverage": "visible-page-only"}, nil
	}
	if a == nil {
		return postgres.InTx(ctx, s.Pool, operation)
	}
	return s.run(ctx, *a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) { return operation(tx) })
}
