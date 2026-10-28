package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
)

func helpFind(rows any, key string, id any) map[string]any {
	for _, v := range trustArray(rows) {
		r := psObject(v)
		if r[key] == id {
			return r
		}
	}
	return nil
}
func (l *helpLease) compose(ctx context.Context, id string, input map[string]any) (any, error) {
	seen := map[string]bool{}
	for _, v := range trustArray(input["offers"]) {
		offer := psObject(v)
		key := text(offer["id"])
		if seen[key] {
			return nil, helpError("help_operation_failed")
		}
		seen[key] = true
	}
	row, e := l.update(ctx, id, input["expectedRevision"], func(draft map[string]any) error {
		keys := helpKnown(draft)
		next := []any{}
		for _, v := range trustArray(input["offers"]) {
			offer := psObject(psClone(v))
			refs := []any{}
			reuse := false
			for _, key := range helpStrings(offer["basisKeys"]) {
				ref := helpFind(draft["basis"], "key", key)
				if !keys[key] || ref == nil {
					return helpError("help_basis_not_observed")
				}
				refs = append(refs, ref)
				if isOne(text(ref["kind"]), "capsule", "case", "history") {
					reuse = true
				}
			}
			if offer["path"] == "capsule-or-history" && !reuse {
				return helpError("help_reuse_source_required")
			}
			for _, v := range trustArray(offer["participants"]) {
				p := psObject(v)
				ref := helpFind(draft["basis"], "key", p["basisKey"])
				if !helpHas(offer["basisKeys"], text(p["basisKey"])) || ref == nil || !helpHas(ref["participantIds"], text(p["id"])) && !(isOne(text(ref["kind"]), "worker", "hub") && ref["id"] == p["id"]) {
					return helpError("help_participant_not_observed")
				}
			}
			offer["generatedBy"] = "user-agent"
			offer["evidenceMeaning"] = "references-not-capability-verification"
			offer["availability"] = "unknown"
			offer["kind"] = "guidance"
			if len(refs) > 0 {
				offer["kind"] = "source-backed-option"
			}
			offer["basisRefs"] = refs
			offer["checkedAt"] = l.host.now()
			next = append(next, offer)
		}
		oldSelected := []any{}
		for _, v := range trustArray(draft["offers"]) {
			old := psObject(v)
			if !helpHas(draft["selectedHelpIds"], text(old["id"])) {
				continue
			}
			changed := helpFind(input["offers"], "id", old["id"])
			if changed == nil {
				oldSelected = append(oldSelected, old)
				continue
			}
			previous := map[string]any{}
			for _, k := range []string{"id", "path", "helpDescription", "userFacingReason", "participants", "interventionKinds", "basisKeys", "environmentDifferences", "conditions"} {
				previous[k] = old[k]
			}
			if !connectionEqual(changed, previous) {
				return helpError("help_selected_offer_immutable")
			}
		}
		draft["offers"] = append(oldSelected, next...)
		return nil
	})
	if e != nil {
		return nil, e
	}
	return helpView(row), nil
}
func (l *helpLease) selectOffers(ctx context.Context, id string, input map[string]any) (any, error) {
	row, e := l.update(ctx, id, input["expectedRevision"], func(draft map[string]any) error {
		keys := helpKnown(draft)
		seen := map[string]bool{}
		for _, id := range helpStrings(input["offerIds"]) {
			if seen[id] {
				return helpError("help_operation_failed")
			}
			seen[id] = true
			offer := helpFind(draft["offers"], "id", id)
			if offer == nil {
				return helpError("help_selection_refresh_required")
			}
			for _, key := range helpStrings(offer["basisKeys"]) {
				if !keys[key] {
					return helpError("help_selection_refresh_required")
				}
			}
		}
		draft["selectedHelpIds"] = input["offerIds"]
		return nil
	})
	if e != nil {
		return nil, e
	}
	return helpView(row), nil
}
func (l *helpLease) review(ctx context.Context, id string) (map[string]any, error) {
	row, e := l.get(ctx, id)
	if e != nil {
		return nil, e
	}
	needed := map[string]bool{}
	for _, v := range trustArray(row["offers"]) {
		for _, key := range helpStrings(psObject(v)["basisKeys"]) {
			needed[key] = true
		}
	}
	statuses := map[string]map[string]any{}
	for _, v := range trustArray(row["queries"]) {
		q := psObject(v)
		relevant := false
		for _, key := range helpStrings(q["basisKeys"]) {
			if needed[key] {
				relevant = true
			}
		}
		if !relevant {
			continue
		}
		var refs []any
		if request := psObject(q["request"]); request != nil {
			_, refs, _ = l.source(ctx, request)
			if e = l.check(ctx); e != nil {
				return nil, e
			}
		}
		for _, key := range helpStrings(q["basisKeys"]) {
			if !needed[key] {
				continue
			}
			old := helpFind(row["basis"], "key", key)
			var current map[string]any
			for _, v := range refs {
				ref := psObject(v)
				if ref["id"] == old["id"] && ref["kind"] == old["kind"] {
					current = ref
					break
				}
			}
			state := "unavailable"
			if current != nil {
				state = "changed"
				if current["key"] == key {
					state = "current"
				}
			}
			if prior := statuses[key]; prior == nil || prior["state"] == "current" {
				statuses[key] = map[string]any{"key": key, "state": state, "checkedAt": l.host.now()}
			}
		}
	}
	latest, e := l.get(ctx, id)
	if e != nil {
		return nil, e
	}
	if psInt(latest["revision"]) != psInt(row["revision"]) {
		return nil, helpError("help_session_changed")
	}
	offers := []any{}
	for _, v := range trustArray(row["offers"]) {
		offer := psObject(v)
		refs := []any{}
		state := "current"
		for _, key := range helpStrings(offer["basisKeys"]) {
			status := statuses[key]
			if status == nil {
				status = map[string]any{"key": key, "state": "unavailable", "checkedAt": l.host.now()}
			}
			refs = append(refs, status)
			if status["state"] == "unavailable" {
				state = "unavailable"
			} else if status["state"] == "changed" && state != "unavailable" {
				state = "changed"
			}
		}
		entry := map[string]any{"id": offer["id"], "state": state, "basisStatuses": refs}
		if state == "current" {
			copy := psObject(psClone(offer))
			copy["sourceStatus"] = "current-readable"
			copy["checkedAt"] = l.host.now()
			entry["offer"] = copy
		}
		offers = append(offers, entry)
	}
	session := helpView(row)
	delete(session, "offers")
	delete(session, "basis")
	delete(session, "queries")
	return map[string]any{"session": session, "offers": offers, "checkedAt": l.host.now(), "sourceBodiesPersisted": false, "dataServiceProvidesModel": false}, nil
}
func (l *helpLease) task(ctx context.Context, id string) (map[string]any, error) {
	task, _, e := l.call(ctx, "/v2/tasks/"+id, nil)
	if e != nil {
		return nil, e
	}
	if task["taskId"] != id || !psSafeInteger(task["version"]) || psInt(task["version"]) < 1 {
		return nil, helpError("help_task_mismatch")
	}
	return task, nil
}
func (l *helpLease) receipt(ctx context.Context, row map[string]any, contextual bool) (map[string]any, error) {
	input := map[string]any{"taskId": row["taskId"], "eventId": row["operationId"], "payloadHash": row["payloadHash"]}
	path := "/v2/tasks/receipt"
	if contextual {
		delete(input, "taskId")
		input["grantId"] = row["grantId"]
		path = "/v2/context/receipt"
	}
	receipt, _, e := l.call(ctx, path, input)
	if e != nil {
		return nil, e
	}
	for k, v := range input {
		if receipt[k] != v {
			return nil, helpError("help_receipt_mismatch")
		}
	}
	if !isOne(text(receipt["state"]), "absent", "acknowledged", "conflict") || !contextual && receipt["state"] == "acknowledged" && (!psSafeInteger(receipt["version"]) || psInt(receipt["version"]) < 1) {
		return nil, helpError("help_receipt_mismatch")
	}
	return receipt, nil
}
func (l *helpLease) publish(ctx context.Context, id string, input map[string]any) (any, error) {
	payload, e := taskmaterials.ParseHelpPayload("publish-task", text(input["payloadJson"]))
	if e != nil {
		return nil, e
	}
	if len(trustArray(payload["materials"])) > 0 {
		return nil, helpError("task_material_atomic_route_required")
	}
	hash := identity.Digest([]byte(text(input["payloadJson"])))
	operation := text(payload["operationId"])
	_, e = l.update(ctx, id, nil, func(row map[string]any) error {
		for _, v := range trustArray(row["actionOperations"]) {
			if helpPending(psObject(v)["state"]) {
				return helpError("help_reconcile_original_operation")
			}
		}
		if row["caseId"] != nil && row["caseId"] != payload["caseId"] || row["taskId"] != nil && row["taskId"] != payload["taskId"] {
			return helpError("help_original_task_mismatch")
		}
		prior := helpFind(row["linkedOperations"], "operationId", operation)
		if prior != nil {
			if prior["payloadHash"] != hash || prior["taskId"] != payload["taskId"] {
				return helpError("help_operation_conflict")
			}
			if prior["state"] != "absent" {
				return helpError("help_reconcile_original_operation")
			}
		}
		for _, v := range trustArray(row["linkedOperations"]) {
			if helpPending(psObject(v)["state"]) {
				return helpError("help_reconcile_original_operation")
			}
		}
		row["linkedOperations"] = helpUpsert(trustArray(row["linkedOperations"]), "operationId", map[string]any{"operationId": operation, "taskId": payload["taskId"], "payloadHash": hash, "state": "submitting", "checkedAt": l.host.now()})
		return nil
	})
	if e != nil {
		return nil, e
	}
	receipt, _, sendErr := l.call(ctx, "/v2/tasks", input)
	if sendErr == nil && (receipt["taskId"] != payload["taskId"] || receipt["eventId"] != operation || psInt(receipt["version"]) != 1) {
		sendErr = helpError("help_receipt_mismatch")
	}
	row, e := l.update(ctx, id, nil, func(row map[string]any) error {
		op := helpFind(row["linkedOperations"], "operationId", operation)
		if sendErr == nil {
			op["state"] = "acknowledged"
			op["version"] = receipt["version"]
			row["taskId"] = payload["taskId"]
			row["caseId"] = payload["caseId"]
		} else if op["state"] != "acknowledged" {
			op["state"] = "unknown"
		}
		op["checkedAt"] = l.host.now()
		return nil
	})
	if e != nil {
		return nil, e
	}
	publication := map[string]any{"state": "acknowledged", "receipt": receipt}
	out := map[string]any{"session": helpView(row), "publication": publication, "invitationsSent": false}
	if sendErr != nil {
		out["publication"] = map[string]any{"state": "unknown", "taskId": payload["taskId"], "operationId": operation, "next": "reconcile-original-operation"}
	} else {
		out["candidateQueryIndependent"] = true
	}
	return out, nil
}
func (l *helpLease) reconcile(ctx context.Context, id, operation string) (map[string]any, error) {
	row, e := l.get(ctx, id)
	if e != nil {
		return nil, e
	}
	op := helpFind(row["linkedOperations"], "operationId", operation)
	if op == nil {
		return nil, helpError("help_receipt_unavailable")
	}
	receipt, e := l.receipt(ctx, op, false)
	if e != nil {
		return nil, e
	}
	next, e := l.update(ctx, id, nil, func(draft map[string]any) error {
		saved := helpFind(draft["linkedOperations"], "operationId", operation)
		if saved["state"] == "acknowledged" && receipt["state"] != "acknowledged" {
			return nil
		}
		saved["state"] = receipt["state"]
		saved["checkedAt"] = l.host.now()
		if receipt["version"] != nil {
			saved["version"] = receipt["version"]
		}
		if receipt["state"] == "acknowledged" {
			draft["taskId"] = receipt["taskId"]
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"session": helpView(next), "receipt": receipt, "currentPermissionEstablished": false, "invitationsSent": false}, nil
}
func (l *helpLease) refresh(ctx context.Context, id string) (map[string]any, error) {
	initial, e := l.get(ctx, id)
	if e != nil {
		return nil, e
	}
	operations := []any{}
	for _, legacy := range []bool{true, false} {
		field := "actionOperations"
		if legacy {
			field = "linkedOperations"
		}
		for _, v := range trustArray(initial[field]) {
			reference := psObject(v)
			if !helpPending(reference["state"]) {
				continue
			}
			var result map[string]any
			var err error
			if legacy {
				result, err = l.reconcile(ctx, id, text(reference["operationId"]))
			} else {
				result, err = l.reconcileAction(ctx, id, text(reference["operationId"]))
			}
			latest, e := l.get(ctx, id)
			if e != nil {
				return nil, e
			}
			current := helpFind(latest[field], "operationId", reference["operationId"])
			if current == nil {
				return nil, helpError("help_session_changed")
			}
			entry := map[string]any{"operationId": current["operationId"], "kind": current["kind"], "taskId": current["taskId"], "state": current["state"], "receiptState": psObject(result["receipt"])["state"]}
			if legacy {
				entry["kind"] = "publish-task"
			}
			for _, k := range []string{"participationId", "grantId"} {
				if value, ok := current[k]; ok {
					entry[k] = value
				}
			}
			if err != nil {
				entry["receiptState"] = "unavailable"
				entry["error"] = helpSourceError(err)
				entry["next"] = "reconcile-original-operation"
			}
			operations = append(operations, entry)
		}
	}
	row, e := l.get(ctx, id)
	if e != nil {
		return nil, e
	}
	reconciliation := map[string]any{"operations": operations, "automaticallyRetried": false, "currentPermissionEstablished": false}
	out := map[string]any{"session": helpView(row), "remote": nil, "state": "no-acknowledged-task", "reconciliation": reconciliation}
	if row["taskId"] == nil {
		return out, nil
	}
	remote, e := l.task(ctx, text(row["taskId"]))
	if e == nil && row["caseId"] != nil && remote["caseId"] != nil && row["caseId"] != remote["caseId"] {
		e = helpError("help_case_mismatch")
	}
	if e != nil {
		if check := l.check(ctx); check != nil {
			return nil, check
		}
		out["state"] = "unavailable"
		out["error"] = helpSourceError(e)
		out["previousReceiptsDoNotProveCurrentAccess"] = true
		return out, nil
	}
	latest, e := l.get(ctx, id)
	if e != nil {
		return nil, e
	}
	if psInt(latest["revision"]) != psInt(row["revision"]) {
		return nil, helpError("help_session_changed")
	}
	if remote["caseId"] != nil && row["caseId"] == nil {
		row, e = l.update(ctx, id, row["revision"], func(row map[string]any) error { row["caseId"] = remote["caseId"]; return nil })
		if e != nil {
			return nil, e
		}
	}
	out["session"] = helpView(row)
	out["remote"] = remote
	out["state"] = "refreshed"
	out["remoteDataStoredLocally"] = false
	out["suggestionsAreResponses"] = false
	out["roomAccess"] = "requires-separate-room-grant"
	return out, nil
}
