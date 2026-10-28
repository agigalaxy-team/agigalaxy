package native

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

func workerUseState(value any) (*protocol.OrderedObject, error) {
	if value == nil {
		s := protocol.NewOrderedObject()
		s.Set("active", nil)
		s.Set("stopped", []any{})
		return s, nil
	}
	s := workerOrdered(value)
	if s == nil {
		return nil, a2aError("invalid original PackUse journal")
	}
	if _, ok := s.Values()["stopped"].([]any); !ok {
		return nil, a2aError("invalid original PackUse journal")
	}
	return s, nil
}
func workerSameUse(a, b any) bool {
	x, y := a2aObject(a), a2aObject(b)
	return x != nil && y != nil && x["operationId"] == y["operationId"] && x["payloadHash"] == y["payloadHash"] && x["type"] == y["type"]
}
func workerUseLoad(ctx context.Context, l *nativeIdentityLease) (*protocol.OrderedObject, error) {
	v, e := workerRead(ctx, l, workerOperationsKey(l))
	if e != nil {
		return nil, e
	}
	return workerUseState(v)
}
func workerReplaceUse(ctx context.Context, l *nativeIdentityLease, previous, next *protocol.OrderedObject) (*protocol.OrderedObject, error) {
	out, e := workerUpdate(ctx, l, workerOperationsKey(l), func(v any) (any, error) {
		s, e := workerUseState(v)
		if e != nil {
			return nil, e
		}
		current := s.Values()["active"]
		a, _ := protocol.EncodeJS(current)
		b, _ := protocol.EncodeJS(previous)
		if !workerSameUse(current, previous) || string(a) != string(b) {
			return nil, a2aError("original PackUse stopped or changed")
		}
		s.Set("active", next)
		return s, nil
	})
	if e != nil {
		return nil, e
	}
	return workerOrdered(a2aObject(out)["active"]), nil
}
func workerPatchUse(ctx context.Context, l *nativeIdentityLease, previous *protocol.OrderedObject, fields map[string]any) (*protocol.OrderedObject, error) {
	next := workerOrdered(workerClone(previous))
	for key, value := range fields {
		next.Set(key, value)
	}
	return workerReplaceUse(ctx, l, previous, next)
}
func workerClearUse(ctx context.Context, l *nativeIdentityLease, op any) error {
	_, e := workerUpdate(ctx, l, workerOperationsKey(l), func(v any) (any, error) {
		s, e := workerUseState(v)
		if e != nil {
			return nil, e
		}
		if workerSameUse(s.Values()["active"], op) {
			s.Set("active", nil)
		}
		stopped := []any{}
		for _, old := range uploadRows(s.Values()["stopped"]) {
			if !workerSameUse(old, op) {
				stopped = append(stopped, old)
			}
		}
		s.Set("stopped", stopped)
		return s, nil
	})
	return e
}
func workerUseReceipt(ctx context.Context, l *nativeIdentityLease, op map[string]any) (map[string]any, error) {
	result, e := l.call(ctx, "/v2/builders/pack-uses/receipt", map[string]any{"operationId": op["operationId"], "payloadHash": op["payloadHash"]}, false)
	if e != nil {
		return nil, e
	}
	if result["operationId"] != op["operationId"] || !isOne(text(result["state"]), "acknowledged", "absent") || result["payloadHash"] != nil && result["payloadHash"] != op["payloadHash"] || result["currentReadPermissionConfirmed"] != false {
		return nil, a2aError("original PackUse receipt mismatch or conflict")
	}
	return result, nil
}
func workerOriginalUse(l *nativeIdentityLease, op map[string]any) (int64, error) {
	invalid := a2aError("original PackUse content, scope or authorization mismatch")
	payloadJSON := text(op["payloadJson"])
	wire, e := builders.PackUseWire(a2aObject(op["payload"]))
	if e != nil {
		return 0, invalid
	}
	var payload map[string]any
	if protocol.Decode([]byte(payloadJSON), &payload) != nil || !connectionEqual(payload, a2aObject(op["payload"])) || !connectionEqual(payload, a2aObjectFromJSON(wire)) || op["type"] != "worker-pack" || op["path"] != "/v2/builders/pack-uses/events" || op["operationId"] != payload["operationId"] || identity.Digest([]byte(payloadJSON)) != op["payloadHash"] || !isOne(text(op["visibility"]), "Private", "Public") {
		return 0, invalid
	}
	viewers, valid := uploadStringValues(op["viewers"])
	if !valid || len(viewers) > 16 || op["visibility"] == "Public" && len(viewers) > 0 {
		return 0, invalid
	}
	seen := map[string]bool{}
	for _, id := range viewers {
		if seen[id] || !referenceSubject.MatchString(id) {
			return 0, invalid
		}
		seen[id] = true
	}
	expires := a2aInteger(op["authorizationExpiresAt"])
	prepared := uploadObject(op["prepared"])
	if prepared != nil {
		intent, e := nativeAuthorizationPrepared(l, prepared)
		if e != nil {
			return 0, e
		}
		if expires == 0 {
			expires = intent.ExpiresAt
		}
		fields, e := nativeAuthorizationFields(string(wire))
		if e != nil {
			return 0, e
		}
		if prepared["payloadJson"] != payloadJSON || intent.Recipient != l.runtime.config.Endpoint || intent.Action != "builder.publish" || intent.ObjectID != op["operationId"] || intent.PayloadHash != op["payloadHash"] || intent.Visibility != op["visibility"] || intent.Purpose != map[bool]string{true: "public-profile", false: "operational"}[op["visibility"] == "Public"] || !connectionEqual(intent.Fields, fields) || !connectionEqual(intent.Viewers, viewers) || intent.ExpiresAt != expires {
			return 0, invalid
		}
		if submission := a2aObject(op["submission"]); submission != nil && (submission["consentId"] != intent.ID || submission["payloadJson"] != payloadJSON) {
			return 0, invalid
		}
	} else if op["submission"] != nil {
		return 0, invalid
	}
	return expires, nil
}
func a2aObjectFromJSON(raw []byte) map[string]any {
	var v map[string]any
	_ = protocol.Decode(raw, &v)
	return v
}
func workerUseBusinessRejected(e error) bool {
	var remote *ConnectionHTTPError
	if !errors.As(e, &remote) || remote.Outcome != "rejected" {
		return false
	}
	return remote.Status >= 400 && remote.Status < 500 && remote.Status != 401 && remote.Status != 408 && remote.Status != 429 && !isOne(remote.Code, "unauthorized", "binding_revoked", "invalid_session", "session_expired", "access_denied")
}
func uploadStringValues(value any) ([]string, bool) {
	if v, ok := value.([]string); ok {
		return v, true
	}
	rows, ok := value.([]any)
	if !ok {
		return nil, false
	}
	out := []string{}
	for _, v := range rows {
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}
func (h *NativeWorkerHost) sendUse(ctx context.Context, l *nativeIdentityLease, op *protocol.OrderedObject, explicit bool) (map[string]any, error) {
	current, e := workerUseLoad(ctx, l)
	if e != nil {
		return nil, e
	}
	if !connectionEqual(current.Values()["active"], op) {
		return nil, a2aError("original PackUse changed")
	}
	value := op.Values()
	if value["automaticRetryBlock"] != nil && !explicit {
		return map[string]any{"state": "absent", "operationId": value["operationId"], "reason": "business-rejected", "rejection": value["automaticRetryBlock"]}, nil
	}
	if value["submission"] == nil {
		if value["prepared"] == nil {
			prepared, e := workerPreparedAuthorization(ctx, l, text(value["payloadJson"]), "builder.publish", text(value["operationId"]), text(value["visibility"]), mustUploadStrings(value["viewers"]), a2aInteger(value["authorizationExpiresAt"]), "")
			if e != nil {
				return nil, e
			}
			op, e = workerPatchUse(ctx, l, op, map[string]any{"prepared": prepared})
			if e != nil {
				return nil, e
			}
			value = op.Values()
		}
		op, e = workerPatchUse(ctx, l, op, map[string]any{"authorizationAttempted": true})
		if e != nil {
			return nil, e
		}
		prepared := uploadObject(op.Values()["prepared"])
		intent, e := nativeAuthorizationPrepared(l, prepared)
		if e != nil {
			return nil, e
		}
		submission, e := h.runtime.submitSavedAuthorization(ctx, l, prepared, intent)
		if e != nil {
			return nil, e
		}
		op, e = workerPatchUse(ctx, l, op, map[string]any{"submission": submission})
		if e != nil {
			return nil, e
		}
		value = op.Values()
	}
	next := workerOrdered(workerClone(op))
	next.Set("businessAttempted", true)
	delete(next.Values(), "automaticRetryBlock")
	op, e = workerReplaceUse(ctx, l, op, next)
	if e != nil {
		return nil, e
	}
	_, e = l.call(ctx, "/v2/builders/pack-uses/events", op.Values()["submission"], false)
	if e != nil {
		if workerUseBusinessRejected(e) {
			_, _ = workerPatchUse(ctx, l, op, map[string]any{"automaticRetryBlock": map[string]any{"code": runtimeErrorCode(e), "status": fault.Status(e), "rejectedAt": h.now().Unix()}, "state": "business-rejected"})
		}
		return nil, e
	}
	result, e := workerUseReceipt(ctx, l, op.Values())
	if e != nil {
		return nil, e
	}
	if result["state"] != "acknowledged" {
		return nil, a2aError("PackUse has no exact acknowledgement; query original receipt")
	}
	if e = workerClearUse(ctx, l, op); e != nil {
		return nil, e
	}
	return result, nil
}
func (h *NativeWorkerHost) resumeUse(ctx context.Context, l *nativeIdentityLease, op *protocol.OrderedObject) (map[string]any, error) {
	value := op.Values()
	expires, e := workerOriginalUse(l, value)
	if e != nil {
		return nil, e
	}
	result, e := workerUseReceipt(ctx, l, value)
	if e != nil {
		return nil, e
	}
	if result["state"] == "acknowledged" {
		if e = workerClearUse(ctx, l, op); e != nil {
			return nil, e
		}
		return result, nil
	}
	reason := func(s string) (map[string]any, error) { out := a2aClone(result); out["reason"] = s; return out, nil }
	now := h.now().Unix()
	if expires == 0 || expires <= now {
		return reason("authorization-expired")
	}
	if expires > now+2592000 {
		return reason("authorization-deadline-invalid")
	}
	next := workerOrdered(workerClone(op))
	next.Set("authorizationExpiresAt", expires)
	if prepared := uploadObject(value["prepared"]); prepared != nil {
		accepted, e := workerConsentReceipt(ctx, l, prepared)
		if e != nil {
			if runtimeErrorCode(e) == "consent_receipt_not_active_or_mismatched" {
				return reason("original-authorization-unavailable")
			}
			return nil, e
		}
		if accepted["state"] == "acknowledged" {
			next.Set("submission", map[string]any{"consentId": accepted["consentId"], "payloadJson": accepted["payloadJson"]})
		} else {
			intent := a2aObject(prepared["intent"])
			if intent["bindingId"] != l.connection.bindingID {
				return reason("original-binding-changed")
			}
			next.Set("submission", nil)
			if a2aInteger(intent["issuedAt"]) < now-300 {
				history := append([]any{}, uploadRows(value["authorizationHistory"])...)
				history = append(history, map[string]any{"prepared": value["prepared"], "submission": value["submission"], "reason": "same-binding-signature-renewal"})
				next.Set("authorizationHistory", history)
				next.Set("authorizationBindingId", intent["bindingId"])
				delete(next.Values(), "prepared")
				delete(next.Values(), "authorizationAttempted")
			}
		}
	}
	if next.Values()["prepared"] == nil && next.Values()["authorizationBindingId"] != l.connection.bindingID {
		if next.Values()["authorizationBindingId"] != nil {
			return reason("original-binding-changed")
		}
		return reason("original-binding-unavailable")
	}
	op, e = workerReplaceUse(ctx, l, op, next)
	if e != nil {
		return nil, e
	}
	return h.sendUse(ctx, l, op, true)
}
func (h *NativeWorkerHost) reconcileUse(ctx context.Context, l *nativeIdentityLease, row map[string]any) (map[string]any, error) {
	op := a2aObject(row["packUse"])
	if op == nil {
		return nil, a2aError("no original PackUse prepared")
	}
	result, e := workerUseReceipt(ctx, l, op)
	if e != nil {
		return nil, e
	}
	if result["state"] == "acknowledged" {
		state, e := workerUseLoad(ctx, l)
		if e != nil {
			return nil, e
		}
		for _, candidate := range append([]any{state.Values()["active"]}, uploadRows(state.Values()["stopped"])...) {
			if a2aObject(candidate)["operationId"] == op["operationId"] {
				if e = workerClearUse(ctx, l, candidate); e != nil {
					return nil, e
				}
				break
			}
		}
	}
	return result, nil
}
func (h *NativeWorkerHost) prepareUse(ctx context.Context, l *nativeIdentityLease, input map[string]any) (*WorkerPreview, error) {
	row, e := workerSelected(ctx, l, text(input["associationId"]))
	if e != nil {
		return nil, e
	}
	if original := a2aObject(row["packUse"]); original != nil {
		receipt, e := h.reconcileUse(ctx, l, row)
		if e != nil {
			return nil, e
		}
		if receipt["state"] == "acknowledged" {
			return &WorkerPreview{host: h, lease: l, row: row, value: map[string]any{"state": "acknowledged", "originalOperationRetained": true, "receipt": receipt}, used: true}, nil
		}
		state, e := workerUseLoad(ctx, l)
		if e != nil {
			return nil, e
		}
		for _, pending := range append([]any{state.Values()["active"]}, uploadRows(state.Values()["stopped"])...) {
			op := a2aObject(pending)
			if op["operationId"] == original["operationId"] {
				if op["state"] == "stopped-local" {
					return nil, a2aError("local PackUse retry stopped; only query original receipt")
				}
				p := h.prepareInner(l, "pack-use-retry", row, nil)
				p.value["operationId"] = original["operationId"]
				p.operation = op
				return p, nil
			}
		}
	}
	if _, e = h.manifest(ctx, l, h.worker(text(row["workerId"]))); e != nil {
		return nil, e
	}
	linkAny, e := h.a2a.Read(ctx, map[string]any{"peerId": row["peerId"], "action": "get", "associationId": row["associationId"]})
	if e != nil {
		return nil, e
	}
	link := a2aObject(linkAny)
	saved := uploadObject(link["resultImportV2"])
	if saved["state"] != "acknowledged" {
		return nil, a2aError("reconcile separately accepted original Worker Result first")
	}
	query := map[string]any{}
	if row["taskId"] != nil {
		query["taskId"] = row["taskId"]
	}
	facts, e := l.call(ctx, "/v2/cases/"+text(row["caseId"])+"/read", query, false)
	if e != nil {
		return nil, e
	}
	attemptRef := a2aObject(row["attempt"])
	var attempt, result map[string]any
	for _, v := range uploadRows(facts["attempts"]) {
		p := uploadObject(v)
		if p["id"] == attemptRef["id"] && a2aInteger(p["version"]) == a2aInteger(attemptRef["version"]) {
			attempt = p
		}
	}
	eventID := uploadObject(uploadObject(saved["draft"])["event"])["eventId"]
	for _, v := range uploadRows(facts["results"]) {
		p := uploadObject(v)
		if p["id"] == eventID && a2aInteger(p["version"]) == 1 {
			result = p
		}
	}
	origin := uploadObject(result["origin"])
	if result == nil || attempt == nil || origin["kind"] != "attempt" || origin["id"] != attemptRef["id"] || a2aInteger(origin["version"]) != a2aInteger(attemptRef["version"]) || !connectionEqual(attempt["configurationRef"], row["configuration"]) {
		return nil, a2aError("exact Worker Attempt, Result or Configuration no longer readable")
	}
	old := a2aObject(row["packUse"])
	payload := a2aObject(old["payload"])
	if payload == nil {
		payload = map[string]any{"schemaVersion": 2, "kind": "record", "operationId": uuid.NewString(), "id": uuid.NewString(), "expectedVersion": 0, "pack": row["pack"], "caseId": row["caseId"], "attempt": row["attempt"], "configuration": row["configuration"], "result": map[string]any{"id": result["id"], "version": result["version"]}, "evidenceRefs": []any{}, "verificationRefs": []any{}, "follows": nil}
	}
	wire, e := builders.PackUseWire(payload)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(wire)
	if old != nil && old["payloadHash"] != hash {
		return nil, a2aError("original Worker PackUse bytes changed")
	}
	disclosure := a2aObject(old["disclosure"])
	if disclosure == nil {
		disclosure = input
	}
	visibility := text(disclosure["visibility"])
	viewers := []string{}
	for _, id := range mustUploadStrings(disclosure["viewers"]) {
		if id != l.scope.Owner && !isOne(id, viewers...) {
			viewers = append(viewers, id)
		}
	}
	if !isOne(visibility, "Private", "Public") || visibility == "Public" && len(viewers) > 0 {
		return nil, a2aError("explicit public or selected private PackUse viewers required")
	}
	normalized, _ := protocol.DecodeOrdered(wire)
	payload = uploadObject(normalized)
	op := map[string]any{"type": "worker-pack", "operationId": payload["operationId"], "grantKind": nil, "payload": normalized, "payloadJson": string(wire), "payloadHash": hash, "visibility": visibility, "viewers": viewers, "path": "/v2/builders/pack-uses/events"}
	next := a2aClone(row)
	next["packUse"] = map[string]any{"operationId": payload["operationId"], "payloadHash": hash, "id": payload["id"], "payload": normalized, "disclosure": map[string]any{"visibility": visibility, "viewers": viewers}}
	if e = workerPutRow(ctx, l, next, row, false); e != nil {
		return nil, e
	}
	preview := h.prepareInner(l, "pack-use", next, nil)
	preview.value["operationId"] = payload["operationId"]
	preview.value["preview"] = op
	preview.operation = op
	return preview, nil
}
func (h *NativeWorkerHost) executeUse(ctx context.Context, l *nativeIdentityLease, p *WorkerPreview) (map[string]any, error) {
	if p.kind == "pack-use-retry" {
		state, e := workerUseLoad(ctx, l)
		if e != nil {
			return nil, e
		}
		op := workerOrdered(state.Values()["active"])
		selected := a2aObject(p.row["packUse"])
		disclosure := a2aObject(selected["disclosure"])
		if op == nil || op.Values()["operationId"] != selected["operationId"] || op.Values()["payloadHash"] != selected["payloadHash"] || op.Values()["visibility"] != disclosure["visibility"] || !connectionEqual(op.Values()["viewers"], disclosure["viewers"]) {
			return nil, a2aError("review original active PackUse retry")
		}
		return h.resumeUse(ctx, l, op)
	}
	value := p.operation
	op := protocol.NewOrderedObject()
	for _, key := range []string{"type", "operationId", "grantKind", "payload", "payloadJson", "payloadHash", "visibility", "viewers", "path"} {
		op.Set(key, value[key])
	}
	op.Set("authorizationExpiresAt", h.now().Unix()+2591900)
	op.Set("authorizationBindingId", l.connection.bindingID)
	if _, e := workerUpdate(ctx, l, workerOperationsKey(l), func(v any) (any, error) {
		state, e := workerUseState(v)
		if e != nil {
			return nil, e
		}
		if state.Values()["active"] != nil {
			return nil, a2aError("inspect or stop previous original PackUse before another")
		}
		state.Set("active", op)
		return state, nil
	}); e != nil {
		return nil, e
	}
	return h.sendUse(ctx, l, op, false)
}
