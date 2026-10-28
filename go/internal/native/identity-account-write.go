package native

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
)

func (a *NativeIdentityAccounts) ExecuteReviewed(ctx context.Context, previewID string, scope *ChoiceScope) (result any, err error) {
	if scope == nil || !controlUUID(previewID) {
		return nil, connectionFailure("native_account_preview_unavailable")
	}
	ctx, cancel, l, e := a.lease(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	a.mu.Lock()
	p := a.previews[previewID]
	if p == nil {
		a.mu.Unlock()
		return nil, connectionFailure("native_account_preview_unavailable")
	}
	if p.lease.scope != *scope || l.scope != *scope || p.lease.connection.bindingID != l.connection.bindingID {
		a.mu.Unlock()
		return nil, connectionFailure("native_account_identity_changed")
	}
	if p.state != "prepared" {
		state := p.state
		receipt := p.receipt
		a.mu.Unlock()
		if e = p.lease.check(ctx); e != nil {
			return nil, e
		}
		if state == "completed" {
			return receipt, nil
		}
		if state == "unknown" {
			return a.recover(ctx, l, p.id)
		}
		return map[string]any{"id": p.id, "state": state, "originalOperationRetained": true}, nil
	}
	if p.expiresAt <= a.runtime.connection.now().UnixMilli() {
		a.mu.Unlock()
		return nil, connectionFailure("native_account_preview_expired_or_changed")
	}
	p.state = "running"
	a.mu.Unlock()
	directReceipt := false
	defer func() {
		a.mu.Lock()
		defer a.mu.Unlock()
		if err == nil && directReceipt {
			p.state, p.receipt = "completed", result
		} else {
			p.state = "unknown"
			var rejected *ConnectionHTTPError
			if errors.As(err, &rejected) && rejected.Outcome == "rejected" {
				p.state = "rejected"
			}
		}
	}()
	if e = p.lease.check(ctx); e != nil {
		return nil, e
	}
	request := map[string]any{"id": p.id}
	if p.action == "link" {
		intent, e := connectionObject([]byte(p.payload))
		if e != nil || !nativeAccountIntent(intent, l, a.runtime.connection.now().Unix()) {
			return nil, connectionFailure("native_account_identity_changed")
		}
		control, e := l.control(ctx)
		if e != nil {
			return nil, e
		}
		snapshot, e := a.runtime.connection.Snapshot(ctx)
		if e != nil {
			return nil, e
		}
		device := deviceManager(control, l.scope.DeviceID)
		if snapshot == nil || integer(control["epoch"]) != integer(snapshot.Control["epoch"]) || device["key_id"] != snapshot.Control["keyId"] || !connectionIncludes(mustUploadStrings(device["scopes"]), "binding") && !connectionIncludes(mustUploadStrings(device["scopes"]), "*") {
			return nil, connectionFailure("native_account_current_control_required")
		}
		signature, e := l.sign(ctx, p.payload, "galaxy-identity-link+jws")
		if e != nil {
			return nil, e
		}
		request["signed"] = signature
	}
	receipt, e := a.send(ctx, l, p.id, p.action, request)
	if e == nil {
		directReceipt = true
		return receipt, nil
	}
	var rejected *ConnectionHTTPError
	if errors.As(e, &rejected) && rejected.Outcome == "rejected" {
		return nil, e
	}
	if check := l.check(ctx); check != nil {
		return nil, check
	}
	recovered, recoveryError := a.recover(ctx, l, p.id)
	if recoveryError == nil {
		return recovered, nil
	}
	return nil, e
}

// ResumePreview implements the original completed/unknown branches before a
// new user-choice request. It never turns an opaque preview into fresh consent.
func (a *NativeIdentityAccounts) ResumePreview(ctx context.Context, id string) (any, bool, error) {
	a.mu.Lock()
	p := a.previews[id]
	if p == nil {
		a.mu.Unlock()
		return nil, false, connectionFailure("native_account_preview_unavailable")
	}
	state, receipt, lease, operationID := p.state, p.receipt, p.lease, p.id
	a.mu.Unlock()
	if e := lease.check(ctx); e != nil {
		return nil, false, e
	}
	if state == "prepared" {
		return nil, false, nil
	}
	if state == "completed" {
		return receipt, true, nil
	}
	if state == "unknown" {
		operation, cancel, generation, e := a.runtime.operation(ctx, true)
		if e != nil {
			return nil, true, e
		}
		defer cancel()
		if generation != lease.generation {
			return nil, true, connectionFailure("native_account_identity_changed")
		}
		value, e := a.recover(operation, lease, operationID)
		return value, true, e
	}
	return map[string]any{"id": operationID, "state": state, "originalOperationRetained": true}, true, nil
}
func (a *NativeIdentityAccounts) recover(ctx context.Context, l *nativeIdentityLease, id string) (any, error) {
	key := l.scope.Owner + ":" + id
	a.mu.Lock()
	existing := a.recovering[key]
	if existing != nil {
		a.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-existing.done:
		}
		if e := l.check(ctx); e != nil {
			return nil, e
		}
		return existing.result, existing.err
	}
	pending := &nativeAccountRecovery{done: make(chan struct{})}
	a.recovering[key] = pending
	a.mu.Unlock()
	result, e := a.recoverOne(ctx, l, id)
	a.mu.Lock()
	pending.result, pending.err = result, e
	close(pending.done)
	delete(a.recovering, key)
	a.mu.Unlock()
	return result, e
}
func (a *NativeIdentityAccounts) recoverOne(ctx context.Context, l *nativeIdentityLease, id string) (any, error) {
	saved, e := l.read(ctx, a.key(l.scope.Owner, id, "unlink"))
	if e != nil {
		return nil, e
	}
	action := "unlink"
	if saved == nil {
		action = "link"
		saved, e = l.read(ctx, a.key(l.scope.Owner, id, action))
		if e != nil {
			return nil, e
		}
	}
	if saved == nil || saved["subjectId"] != l.scope.Owner || saved["endpoint"] != l.scope.Endpoint || saved["id"] != id || saved["action"] != action {
		return nil, connectionFailure("native_account_original_operation_unavailable")
	}
	public := func(state string, extra map[string]any) map[string]any {
		value := map[string]any{"id": id, "action": action, "subjectId": l.scope.Owner, "state": state, "originalOperationRetained": true}
		for key, valueExtra := range extra {
			value[key] = valueExtra
		}
		return value
	}
	page, e := a.read(ctx, l, NativeIdentityAccountRead{Action: "query", ID: id, Limit: 1})
	if e != nil {
		return nil, e
	}
	var found map[string]any
	for _, value := range uploadRows(page["items"]) {
		row := uploadObject(value)
		if row["id"] == id {
			found = row
		}
	}
	if found != nil && isOne(text(found["state"]), "linked", "revoked", "binding-inactive", "provider-unavailable") && !(action == "unlink" && found["state"] != "revoked") {
		receipt := map[string]any{"id": id, "state": found["state"], "galaxyAuthorization": false}
		e = l.update(ctx, a.key(l.scope.Owner, id, action), func(row map[string]any) (map[string]any, error) {
			if row == nil || !connectionEqual(row["request"], saved["request"]) {
				return nil, connectionFailure("native_account_original_operation_changed")
			}
			row["state"], row["receipt"] = found["state"], receipt
			return row, nil
		})
		return public(text(found["state"]), map[string]any{"remoteResent": false, "receipt": receipt}), e
	}
	if saved["state"] == "rejected" {
		return public("rejected", map[string]any{"remoteResent": false, "reason": saved["error"]}), nil
	}
	if saved["bindingId"] != l.connection.bindingID || saved["deviceId"] != l.scope.DeviceID {
		return public("unknown", map[string]any{"remoteResent": false, "reason": "native_account_original_binding_changed"}), nil
	}
	if action == "link" {
		status, e := a.read(ctx, l, NativeIdentityAccountRead{Action: "status", ID: id})
		if e != nil {
			if check := l.check(ctx); check != nil {
				return nil, check
			}
			return public("unknown", map[string]any{"remoteResent": false, "reason": runtimeErrorCode(e)}), nil
		}
		if status["state"] != "awaiting-local-signature" || integer(status["expiresAt"]) <= a.runtime.connection.now().Unix() {
			return public(text(status["state"]), map[string]any{"remoteResent": false}), nil
		}
		request := uploadObject(saved["request"])
		packet := text(request["signed"])
		parts := strings.Split(packet, ".")
		if len(parts) != 3 {
			return nil, connectionFailure("native_account_original_intent_changed")
		}
		raw, e := base64.RawURLEncoding.Strict().DecodeString(parts[1])
		if e != nil {
			return nil, connectionFailure("native_account_original_intent_changed")
		}
		intent, e := connectionObject(raw)
		if e != nil || status["payloadJson"] != string(raw) || !nativeAccountIntent(intent, l, a.runtime.connection.now().Unix()) || intent["id"] != id {
			return public("unknown", map[string]any{"remoteResent": false, "reason": "native_account_original_intent_changed"}), nil
		}
	}
	receipt, e := a.send(ctx, l, id, action, uploadObject(saved["request"]))
	if e != nil {
		return nil, e
	}
	return public(text(receipt["state"]), map[string]any{"remoteResent": true, "originalSignedBytes": true, "receipt": receipt}), nil
}
func (a *NativeIdentityAccounts) Recover(ctx context.Context, id string) (any, error) {
	if id != "" && !controlUUID(id) {
		return nil, connectionFailure("native_account_link_input_invalid")
	}
	ctx, cancel, l, e := a.lease(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if id != "" {
		return a.recover(ctx, l, id)
	}
	rows, e := l.readAny(ctx, a.index(l.scope.Owner))
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, value := range uploadRows(rows) {
		entry := uploadObject(value)
		operationID, action := text(entry["id"]), text(entry["action"])
		if !controlUUID(operationID) || !isOne(action, "link", "unlink") {
			return nil, connectionFailure("native_account_original_operation_changed")
		}
		row, e := l.read(ctx, a.key(l.scope.Owner, operationID, action))
		if e != nil {
			return nil, e
		}
		if row != nil && !isOne(text(row["state"]), "linked", "revoked", "binding-inactive", "provider-unavailable") {
			items = append(items, map[string]any{"id": operationID, "action": row["action"], "state": row["state"], "subjectId": row["subjectId"]})
		}
	}
	return map[string]any{"items": items, "originalOperationRetained": true}, nil
}
