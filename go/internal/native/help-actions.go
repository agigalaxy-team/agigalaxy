package native

import (
	"context"
	contextdata "github.com/agigalaxy-team/agigalaxy/go/internal/context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/google/uuid"
	"sort"
	"strings"
)

func helpPayload(kind, raw string) (map[string]any, error) {
	if strings.HasPrefix(kind, "context-") {
		return contextdata.ParseHelpPayload(kind, raw)
	}
	return taskmaterials.ParseHelpPayload(kind, raw)
}
func helpRecipients(values, payload map[string]any, subject string) ([]any, error) {
	if values["kind"] != "publish-task" {
		if _, ok := values["recipientIds"]; ok {
			return nil, helpError("help_action_scope_changed")
		}
		return []any{}, nil
	}
	ids := helpStrings(values["recipientIds"])
	if payload["visibility"] == "Public" && len(ids) > 0 {
		return nil, helpError("help_action_scope_changed")
	}
	seen := map[string]bool{}
	kept := []string{}
	for _, id := range ids {
		if id != subject && !seen[id] {
			seen[id] = true
			kept = append(kept, id)
		}
	}
	sort.Strings(kept)
	out := []any{}
	for _, id := range kept {
		out = append(out, id)
	}
	return out, nil
}
func (l *helpLease) describe(ctx context.Context, session, values map[string]any) (map[string]any, error) {
	kind := text(values["kind"])
	payload, e := helpPayload(kind, text(values["payloadJson"]))
	if e != nil {
		return nil, e
	}
	if kind == "publish-task" && len(trustArray(payload["materials"])) > 0 {
		return nil, helpError("task_material_atomic_route_required")
	}
	maximum := 24000
	if strings.HasPrefix(kind, "context-") {
		maximum = 40000
	}
	if len([]byte(text(values["payloadJson"]))) > maximum {
		return nil, helpError("help_action_payload_too_large")
	}
	recipients, e := helpRecipients(values, payload, l.scope.Owner)
	if e != nil {
		return nil, e
	}
	event := psObject(payload["event"])
	if event == nil {
		event = payload
	}
	operation := event["operationId"]
	if operation == nil {
		operation = event["eventId"]
	}
	if operation == nil {
		operation = event["id"]
	}
	taskID := payload["taskId"]
	if taskID == nil {
		taskID = values["taskId"]
	}
	if !controlUUID(taskID) {
		return nil, helpError("help_original_task_mismatch")
	}
	if values["taskId"] != nil && values["taskId"] != taskID || session["taskId"] != nil && session["taskId"] != taskID || session["caseId"] != nil && payload["caseId"] != nil && session["caseId"] != payload["caseId"] {
		return nil, helpError("help_original_task_mismatch")
	}
	for _, v := range trustArray(session["linkedOperations"]) {
		if helpPending(psObject(v)["state"]) {
			return nil, helpError("help_reconcile_original_operation")
		}
	}
	for _, v := range trustArray(session["actionOperations"]) {
		op := psObject(v)
		if op["operationId"] != operation && op["kind"] == "publish-task" && helpPending(op["state"]) {
			return nil, helpError("help_reconcile_original_operation")
		}
	}
	partID := payload["participationId"]
	if partID == nil {
		partID = values["participationId"]
	}
	if values["participationId"] != nil && partID != values["participationId"] {
		return nil, helpError("help_action_target_mismatch")
	}
	scope := map[string]any{}
	materials := []any{}
	visibility := "Private"
	var participation map[string]any
	if kind == "publish-task" {
		if session["taskId"] != nil {
			return nil, helpError("help_task_already_linked")
		}
		visibility = text(payload["visibility"])
		scope = map[string]any{"intent": payload["intent"], "goal": psObject(payload["workContext"])["goal"], "expectedOutcome": payload["expectedOutcome"]}
	} else {
		if session["taskId"] != taskID {
			return nil, helpError("help_acknowledged_task_required")
		}
		task, e := l.task(ctx, text(taskID))
		if e != nil {
			return nil, e
		}
		if psInt(task["schemaVersion"]) != 2 {
			return nil, helpError("help_legacy_task_read_only")
		}
		if session["caseId"] != nil && task["caseId"] != nil && session["caseId"] != task["caseId"] {
			return nil, helpError("help_original_task_mismatch")
		}
		recipients = []any{task["requesterId"]}
		switch kind {
		case "task-event":
			if psInt(event["expectedTaskVersion"]) != psInt(task["version"]) {
				return nil, helpError("help_task_version_changed")
			}
			if event["kind"] == "invite" {
				recipients = append(recipients, event["recipientId"])
			}
			if event["kind"] == "revoke-invitation" {
				invitation := helpFind(psObject(psObject(task["contacts"])["responses"])["invitations"], "invitationId", event["invitationId"])
				if invitation == nil {
					return nil, helpError("help_invitation_unavailable")
				}
				recipients = append(recipients, invitation["recipientId"])
			}
			scope = map[string]any{"eventKind": event["kind"], "expectedTaskVersion": event["expectedTaskVersion"]}
		case "participation-propose":
			if psInt(event["expectedTaskVersion"]) != psInt(task["version"]) {
				return nil, helpError("help_task_version_changed")
			}
			recipients = append(recipients, payload["subjectId"])
			scope = map[string]any{"role": payload["role"], "scopeVersion": 1, "agreedScope": payload["agreedScope"]}
		default:
			participation = helpFind(task["participations"], "participationId", partID)
			if participation == nil || participation["scopeAvailable"] == false {
				return nil, helpError("help_participation_unavailable")
			}
			recipients = append(recipients, participation["subjectId"])
			scope = map[string]any{"participationId": partID, "participantId": participation["subjectId"], "scopeVersion": participation["scopeVersion"], "scopeEventId": participation["scopeEventId"], "agreedScope": participation["agreedScope"]}
			if kind == "participation-event" && psInt(event["expectedParticipationVersion"]) != psInt(participation["version"]) {
				return nil, helpError("help_participation_version_changed")
			}
			if strings.HasPrefix(kind, "context-") {
				if psInt(payload["scopeVersion"]) != psInt(participation["scopeVersion"]) || task["paused"] == true || task["state"] != "open" || !isOne(text(participation["state"]), "active", "delivered", "accepted") {
					if kind != "context-event" || payload["kind"] == "accept" {
						return nil, helpError("help_context_scope_changed")
					}
				}
				if kind == "context-grant" {
					if task["requesterId"] != l.scope.Owner || payload["participantId"] != participation["subjectId"] || payload["scopeEventId"] != participation["scopeEventId"] || psInt(payload["expiresAt"]) <= l.host.now() {
						return nil, helpError("help_context_scope_changed")
					}
					recipients = []any{payload["participantId"]}
					materials = trustArray(payload["materials"])
				} else {
					current, _, e := l.call(ctx, "/v2/context/"+text(payload["grantId"])+"/metadata", nil)
					if e != nil {
						return nil, e
					}
					metadata := psObject(current["metadata"])
					if metadata["grantId"] != payload["grantId"] || current["contextAccessGranted"] != false {
						return nil, helpError("help_context_unavailable")
					}
					for _, v := range trustArray(current["materials"]) {
						if _, present := psObject(v)["content"]; present {
							return nil, helpError("help_context_unavailable")
						}
					}
					if metadata["taskId"] != taskID || metadata["participationId"] != partID || metadata["materialsHash"] != payload["materialsHash"] || psInt(metadata["scopeVersion"]) != psInt(payload["scopeVersion"]) {
						return nil, helpError("help_context_material_changed")
					}
					if payload["kind"] == "accept" && current["state"] != "pending" {
						return nil, helpError("help_context_unavailable")
					}
					actor, recipient := metadata["participantId"], metadata["ownerId"]
					if payload["kind"] == "revoke" {
						actor, recipient = metadata["ownerId"], metadata["participantId"]
					}
					if actor != l.scope.Owner {
						return nil, helpError("help_context_actor_mismatch")
					}
					recipients = []any{recipient}
					scope["materialsHash"] = payload["materialsHash"]
					scope["grantId"] = payload["grantId"]
					scope["eventKind"] = payload["kind"]
				}
			}
		}
	}
	if values["offerId"] != nil {
		if !helpHas(session["selectedHelpIds"], text(values["offerId"])) {
			return nil, helpError("help_selected_offer_required")
		}
		review, e := l.review(ctx, text(session["id"]))
		if e != nil {
			return nil, e
		}
		selected := helpFind(review["offers"], "id", values["offerId"])
		if selected["state"] != "current" {
			return nil, helpError("help_selection_refresh_required")
		}
		target := participation["subjectId"]
		if event["kind"] == "invite" {
			target = event["recipientId"]
		} else if kind == "participation-propose" {
			target = payload["subjectId"]
		}
		if target != nil && helpFind(psObject(selected["offer"])["participants"], "id", target) == nil {
			return nil, helpError("help_selected_participant_mismatch")
		}
	}
	actual := []any{}
	for _, id := range recipients {
		if id != l.scope.Owner {
			actual = append(actual, id)
		}
	}
	actual = helpUnique(actual)
	out := psObject(psClone(values))
	out["payload"] = payload
	out["operationId"] = operation
	out["taskId"] = taskID
	if partID != nil {
		out["participationId"] = partID
	}
	if kind == "context-grant" {
		out["grantId"] = payload["id"]
	} else if kind == "context-event" {
		out["grantId"] = payload["grantId"]
	}
	out["payloadHash"] = identity.Digest([]byte(text(values["payloadJson"])))
	out["recipientIds"] = actual
	out["visibility"] = visibility
	out["scope"] = scope
	out["materials"] = materials
	out["consentAction"] = "assistance.publish"
	out["expiresAt"] = l.host.now() + 3600
	if strings.HasPrefix(kind, "context-") {
		out["consentAction"] = "context.grant"
	}
	if kind == "context-grant" {
		out["expiresAt"] = payload["expiresAt"]
	}
	return out, nil
}
func helpActionPreview(row map[string]any) map[string]any {
	out := map[string]any{}
	for _, k := range []string{"operationId", "payloadHash", "kind", "taskId", "participationId", "grantId", "recipientIds", "visibility", "scope", "state"} {
		if v, ok := row[k]; ok {
			out[k] = v
		}
	}
	out["authorizationRequestId"] = row["authorizationRequestId"]
	if out["authorizationRequestId"] == nil {
		out["authorizationRequestId"] = row["operationId"]
	}
	out["authorizationExpiresAt"] = row["expiresAt"]
	out["materials"] = []any{}
	if row["payloadJson"] != nil {
		payload, _ := trustParseText(row["payloadJson"])
		out["payload"] = payload
		prepare := map[string]any{}
		for _, k := range []string{"kind", "payloadJson", "taskId", "participationId", "offerId"} {
			if v, ok := row[k]; ok {
				prepare[k] = v
			}
		}
		if row["kind"] == "publish-task" {
			prepare["recipientIds"] = row["recipientIds"]
		}
		out["prepareInput"] = prepare
		if row["kind"] == "context-grant" {
			out["materials"] = payload["materials"]
		}
	}
	out["requiresExactAuthorization"] = true
	out["selectionIsCommitment"] = false
	out["paymentExecuted"] = false
	return out
}
func (l *helpLease) actionReference(ctx context.Context, id string, row map[string]any) error {
	_, e := l.update(ctx, id, nil, func(session map[string]any) error {
		if row["state"] == "submitting" {
			for _, v := range trustArray(session["linkedOperations"]) {
				if helpPending(psObject(v)["state"]) {
					return helpError("help_reconcile_original_operation")
				}
			}
			for _, v := range trustArray(session["actionOperations"]) {
				op := psObject(v)
				if op["operationId"] != row["operationId"] && (op["taskId"] == row["taskId"] || op["kind"] == "publish-task" || row["kind"] == "publish-task") && helpPending(op["state"]) {
					return helpError("help_reconcile_original_operation")
				}
			}
			if row["kind"] == "publish-task" && session["taskId"] != nil {
				return helpError("help_task_already_linked")
			}
		}
		ref := map[string]any{"operationId": row["operationId"], "kind": row["kind"], "taskId": row["taskId"], "payloadHash": row["payloadHash"], "state": row["state"], "checkedAt": l.host.now()}
		for _, k := range []string{"participationId", "grantId"} {
			if v, ok := row[k]; ok {
				ref[k] = v
			}
		}
		session["actionOperations"] = helpUpsert(trustArray(session["actionOperations"]), "operationId", ref)
		if row["state"] == "acknowledged" && row["kind"] == "publish-task" {
			session["taskId"] = row["taskId"]
			session["caseId"] = row["caseId"]
		}
		return nil
	})
	return e
}
func (l *helpLease) prepareAction(ctx context.Context, id string, input map[string]any) (any, error) {
	parsed, e := helpPayload(text(input["kind"]), text(input["payloadJson"]))
	if e != nil {
		return nil, e
	}
	event := psObject(parsed["event"])
	if event == nil {
		event = parsed
	}
	op := event["operationId"]
	if op == nil {
		op = event["eventId"]
	}
	if op == nil {
		op = event["id"]
	}
	operation := text(op)
	original, e := l.operation(ctx, id, operation, nil)
	if e != nil {
		return nil, e
	}
	taskID := parsed["taskId"]
	if taskID == nil {
		taskID = input["taskId"]
	}
	partID := parsed["participationId"]
	if partID == nil {
		partID = input["participationId"]
	}
	if input["kind"] == "publish-task" && len(trustArray(parsed["materials"])) > 0 {
		return nil, helpError("task_material_atomic_route_required")
	}
	if original != nil {
		recipients, e := helpRecipients(input, parsed, l.scope.Owner)
		if e != nil {
			return nil, e
		}
		if original["payloadHash"] != identity.Digest([]byte(text(input["payloadJson"]))) || original["kind"] != input["kind"] || original["taskId"] != taskID || original["participationId"] != partID || original["offerId"] != input["offerId"] || input["kind"] == "publish-task" && !connectionEqual(original["recipientIds"], recipients) {
			return nil, helpError("help_operation_conflict")
		}
		authID := original["authorizationRequestId"]
		if authID == nil {
			authID = op
		}
		changed := input["authorizationRequestId"] != nil && input["authorizationRequestId"] != authID
		if changed && original["state"] != "absent" {
			return nil, helpError("help_authorization_renewal_requires_absence")
		}
		if isOne(text(original["state"]), "prepared", "absent") && (psInt(original["expiresAt"]) <= l.host.now() || changed) {
			session, e := l.get(ctx, id)
			if e != nil {
				return nil, e
			}
			fresh, e := l.describe(ctx, session, input)
			if e != nil {
				return nil, e
			}
			if !connectionEqual(fresh["recipientIds"], original["recipientIds"]) || !connectionEqual(fresh["scope"], original["scope"]) {
				return nil, helpError("help_action_scope_changed")
			}
			row, e := l.operation(ctx, id, operation, func(prior map[string]any) (map[string]any, error) {
				if !isOne(text(prior["state"]), "prepared", "absent") || prior["authorizationRequestId"] != original["authorizationRequestId"] || psInt(prior["expiresAt"]) != psInt(original["expiresAt"]) {
					return nil, helpError("help_reconcile_original_operation")
				}
				prior["authorizationRequestId"] = uuid.NewString()
				if changed {
					prior["authorizationRequestId"] = input["authorizationRequestId"]
				}
				prior["expiresAt"] = fresh["expiresAt"]
				prior["checkedAt"] = l.host.now()
				return prior, nil
			})
			if e != nil {
				return nil, e
			}
			if e = l.actionReference(ctx, id, row); e != nil {
				return nil, e
			}
			return helpActionPreview(row), nil
		}
		if e = l.actionReference(ctx, id, original); e != nil {
			return nil, e
		}
		return helpActionPreview(original), nil
	}
	session, e := l.get(ctx, id)
	if e != nil {
		return nil, e
	}
	description, e := l.describe(ctx, session, input)
	if e != nil {
		return nil, e
	}
	row, e := l.operation(ctx, id, operation, func(prior map[string]any) (map[string]any, error) {
		if prior != nil {
			for _, k := range []string{"payloadHash", "kind", "taskId", "participationId", "offerId"} {
				if prior[k] != description[k] {
					return nil, helpError("help_operation_conflict")
				}
			}
			if !connectionEqual(prior["recipientIds"], description["recipientIds"]) {
				return nil, helpError("help_operation_conflict")
			}
			return prior, nil
		}
		row := psObject(psClone(description))
		delete(row, "payload")
		delete(row, "materials")
		row["authorizationRequestId"] = input["authorizationRequestId"]
		if row["authorizationRequestId"] == nil {
			row["authorizationRequestId"] = op
		}
		row["sessionId"] = id
		row["subjectId"] = l.scope.Owner
		row["endpoint"] = l.scope.Endpoint
		if row["kind"] == "publish-task" {
			row["caseId"] = psObject(description["payload"])["caseId"]
		}
		row["state"] = "prepared"
		row["checkedAt"] = l.host.now()
		return row, nil
	})
	if e != nil {
		return nil, e
	}
	if e = l.actionReference(ctx, id, row); e != nil {
		return nil, e
	}
	return helpActionPreview(row), nil
}
func (l *helpLease) recordAction(ctx context.Context, id, operation, state string, receipt map[string]any) (map[string]any, error) {
	row, e := l.operation(ctx, id, operation, func(prior map[string]any) (map[string]any, error) {
		if prior == nil {
			return nil, helpError("help_action_unavailable")
		}
		if prior["state"] == "acknowledged" && state != "acknowledged" {
			return prior, nil
		}
		prior["state"] = state
		prior["checkedAt"] = l.host.now()
		if receipt != nil {
			prior["receipt"] = receipt
		}
		if state == "acknowledged" {
			delete(prior, "payloadJson")
			delete(prior, "materials")
		}
		return prior, nil
	})
	if e != nil {
		return nil, e
	}
	return row, l.actionReference(ctx, id, row)
}
func (l *helpLease) reconcileAction(ctx context.Context, id, operation string) (map[string]any, error) {
	row, e := l.operation(ctx, id, operation, nil)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return nil, helpError("help_action_unavailable")
	}
	receipt, e := l.receipt(ctx, row, strings.HasPrefix(text(row["kind"]), "context-"))
	if e != nil {
		return nil, e
	}
	row, e = l.recordAction(ctx, id, operation, text(receipt["state"]), receipt)
	if e != nil {
		return nil, e
	}
	return map[string]any{"operation": helpActionPreview(row), "receipt": receipt, "currentPermissionEstablished": false, "automaticallyRetried": false}, nil
}
func (l *helpLease) executeAction(ctx context.Context, id string, input map[string]any, expected *ChoiceScope) (any, error) {
	session, e := l.get(ctx, id)
	if e != nil {
		return nil, e
	}
	operation := text(input["operationId"])
	row, e := l.operation(ctx, id, operation, nil)
	if e != nil {
		return nil, e
	}
	if row == nil || row["payloadHash"] != input["payloadHash"] {
		return nil, helpError("help_action_preview_changed")
	}
	if row["state"] == "acknowledged" {
		return map[string]any{"operation": helpActionPreview(row), "receipt": row["receipt"], "currentPermissionEstablished": false}, nil
	}
	auth := row["authorizationRequestId"]
	if auth == nil {
		auth = row["operationId"]
	}
	requested := input["authorizationRequestId"]
	if requested == nil {
		requested = input["operationId"]
	}
	if auth != requested {
		return nil, helpError("help_authorization_preview_changed")
	}
	if helpPending(row["state"]) {
		return nil, helpError("help_reconcile_original_operation")
	}
	for _, v := range trustArray(session["actionOperations"]) {
		op := psObject(v)
		if op["operationId"] != operation && op["taskId"] == row["taskId"] && helpPending(op["state"]) {
			return nil, helpError("help_reconcile_original_operation")
		}
	}
	if expected == nil || *expected != l.scope || row["payloadJson"] == nil || identity.Digest([]byte(text(row["payloadJson"]))) != input["payloadHash"] {
		return nil, helpError("help_exact_authorization_unavailable")
	}
	if psInt(row["expiresAt"]) <= l.host.now() {
		return nil, helpError("help_authorization_refresh_required")
	}
	prepare := psObject(helpActionPreview(row)["prepareInput"])
	description, e := l.describe(ctx, session, prepare)
	if e != nil {
		return nil, e
	}
	if !connectionEqual(description["recipientIds"], row["recipientIds"]) || !connectionEqual(description["scope"], row["scope"]) {
		return nil, helpError("help_action_scope_changed")
	}
	original := row
	row, e = l.operation(ctx, id, operation, func(prior map[string]any) (map[string]any, error) {
		if !isOne(text(prior["state"]), "prepared", "absent") {
			return nil, helpError("help_reconcile_original_operation")
		}
		if prior["authorizationRequestId"] != original["authorizationRequestId"] || psInt(prior["expiresAt"]) != psInt(original["expiresAt"]) {
			return nil, helpError("help_authorization_preview_changed")
		}
		prior["state"] = "submitting"
		prior["checkedAt"] = l.host.now()
		return prior, nil
	})
	if e != nil {
		return nil, e
	}
	if e = l.actionReference(ctx, id, row); e != nil {
		return nil, e
	}
	submission, sendErr := l.host.runtime.AuthorizeReviewed(ctx, map[string]any{"requestId": auth, "action": row["consentAction"], "objectId": operation, "payloadJson": row["payloadJson"], "visibility": row["visibility"], "viewers": row["recipientIds"], "expiresAt": row["expiresAt"]}, expected)
	var receipt map[string]any
	if sendErr == nil {
		_, sendErr = l.get(ctx, id)
	}
	if sendErr == nil && (submission["payloadJson"] != row["payloadJson"] || !controlUUID(submission["consentId"])) {
		sendErr = helpError("help_authorization_payload_changed")
	}
	if sendErr == nil {
		path := ""
		switch row["kind"] {
		case "publish-task":
			path = "/v2/tasks"
		case "task-event":
			path = "/v2/tasks/" + text(row["taskId"]) + "/events"
		case "participation-propose":
			path = "/v2/tasks/" + text(row["taskId"]) + "/participations"
		case "participation-event":
			path = "/v2/participations/" + text(row["participationId"]) + "/events"
		case "context-grant":
			path = "/v2/context/grants"
		case "context-event":
			path = "/v2/context/" + text(row["grantId"]) + "/events"
		}
		receipt, _, sendErr = l.call(ctx, path, map[string]any{"consentId": submission["consentId"], "payloadJson": row["payloadJson"]})
		if sendErr == nil {
			if strings.HasPrefix(text(row["kind"]), "context-") {
				if receipt["grantId"] != row["grantId"] || receipt["eventId"] != operation || !isOne(text(receipt["state"]), "recorded-awaiting-recipient-acceptance", "accepted", "declined", "revoked", "acknowledged") {
					sendErr = helpError("help_receipt_mismatch")
				}
			} else if receipt["taskId"] != row["taskId"] || receipt["eventId"] != operation || !psSafeInteger(receipt["version"]) || psInt(receipt["version"]) < 1 || row["kind"] == "publish-task" && psInt(receipt["version"]) != 1 || row["participationId"] != nil && receipt["participationId"] != row["participationId"] {
				sendErr = helpError("help_receipt_mismatch")
			}
		}
	}
	if sendErr != nil {
		current, e := l.recordAction(ctx, id, operation, "unknown", nil)
		if e != nil {
			return nil, e
		}
		return map[string]any{"operation": helpActionPreview(current), "state": "unknown", "next": "reconcile-original-operation", "automaticallyRetried": false}, nil
	}
	current, e := l.recordAction(ctx, id, operation, "acknowledged", receipt)
	if e != nil {
		return nil, e
	}
	return map[string]any{"operation": helpActionPreview(current), "receipt": receipt, "currentPermissionEstablished": false, "successFactsCreated": false}, nil
}
