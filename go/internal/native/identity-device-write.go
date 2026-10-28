package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

func (d *NativeDeviceManagement) Preview(ctx context.Context, id string) (any, error) {
	d.mu.Lock()
	p := d.previews[id]
	if p == nil || p.expiresAt <= d.runtime.connection.now().UnixMilli() {
		d.mu.Unlock()
		return nil, connectionFailure("device_management_native_preview_expired_or_unavailable")
	}
	original := identityClone(p.original)
	lease := p.lease
	d.mu.Unlock()
	if e := lease.check(ctx); e != nil {
		return nil, e
	}
	return original, nil
}
func (d *NativeDeviceManagement) ConfirmReviewed(ctx context.Context, id string, scope *ChoiceScope) (result any, err error) {
	if !controlUUID(id) || scope == nil {
		return nil, connectionFailure("device_management_confirmation_required")
	}
	ctx, cancel, l, e := d.runtime.identityLease(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	d.mu.Lock()
	p := d.previews[id]
	if p == nil || p.expiresAt <= d.runtime.connection.now().UnixMilli() {
		d.mu.Unlock()
		return nil, connectionFailure("device_management_native_preview_expired_or_unavailable")
	}
	if p.lease.scope != *scope || l.scope != *scope {
		d.mu.Unlock()
		return nil, connectionFailure("native_choice_binding_changed")
	}
	original := identityClone(p.original)
	if p.state != "prepared" {
		result = map[string]any{"operationId": original["operationId"], "state": p.state, "originalOperationRetained": true, "remoteResent": false, "currentAccessGranted": false, "recoverWith": "galaxy_identity_device_native_read"}
		d.mu.Unlock()
		return result, nil
	}
	p.state = "running"
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		if err != nil {
			p.state = "original-operation-needs-reconciliation"
		} else {
			p.state = "completed"
			delete(d.previews, id)
		}
		d.mu.Unlock()
	}()
	if e = p.lease.check(ctx); e != nil {
		return nil, e
	}
	journal, e := l.read(ctx, d.journalKey(l.scope.Owner))
	if e != nil {
		return nil, e
	}
	row := uploadObject(journal["active"])
	if row["operationId"] != original["operationId"] || row["stopped"] == true {
		return nil, connectionFailure("device_management_pending_changed")
	}
	prior, e := d.receipt(ctx, l, row)
	if e != nil {
		return nil, e
	}
	if identityTerminal(text(uploadObject(uploadObject(prior)["receipt"])["state"])) {
		return prior, nil
	}
	state, e := l.control(ctx)
	if e != nil {
		return nil, e
	}
	own := deviceManager(state, l.scope.DeviceID)
	control := uploadObject(original["control"])
	if !deviceCanManage(own) || own["key_id"] != control["signerKeyId"] || !connectionEqual(state["epoch"], control["epoch"]) || state["chainHead"] != control["chainHead"] {
		return nil, connectionFailure("device_management_control_changed")
	}
	if integer(original["expiresAt"]) <= d.runtime.connection.now().Unix() {
		return nil, connectionFailure("device_approval_expired")
	}
	operationKey := identityOperationKey(d.runtime.config.Endpoint, text(row["operationId"]))
	saved, e := l.read(ctx, operationKey)
	if e != nil {
		return nil, e
	}
	if saved == nil || identity.Digest([]byte(text(saved["challenge"]))) != original["challengeHash"] || !connectionEqual(saved["request"], row["request"]) {
		return nil, connectionFailure("device_management_pending_changed")
	}
	_, public, e := d.runtime.connection.deviceKey(ctx, l.connection)
	if e != nil {
		return nil, e
	}
	if own["public_key"] != public {
		return nil, connectionFailure("device_key_unavailable")
	}
	e = l.update(ctx, d.journalKey(l.scope.Owner), func(j map[string]any) (map[string]any, error) {
		active := uploadObject(j["active"])
		if active["operationId"] != row["operationId"] || active["stopped"] == true {
			return nil, connectionFailure("device_management_pending_changed")
		}
		active["state"] = "submitting"
		j["active"] = active
		return j, nil
	})
	if e != nil {
		return nil, e
	}
	commit := uploadObject(saved["commit"])
	if commit == nil {
		signature, e := l.sign(ctx, text(saved["challenge"]), "galaxy-identity-control-v2+jws")
		if e != nil {
			return nil, e
		}
		commit = map[string]any{"operationId": row["operationId"], "controllerSignature": signature}
		e = l.update(ctx, operationKey, func(current map[string]any) (map[string]any, error) {
			if current == nil || current["challenge"] != saved["challenge"] || !connectionEqual(current["request"], saved["request"]) {
				return nil, connectionFailure("device_management_pending_changed")
			}
			if current["commit"] != nil && !connectionEqual(current["commit"], commit) {
				return nil, connectionFailure("device_management_pending_changed")
			}
			current["commit"], current["state"] = commit, "signed-awaiting-result"
			return current, nil
		})
		if e != nil {
			return nil, e
		}
	} else if uploadObject(uploadObject(prior)["receipt"])["state"] != "requested" {
		return nil, connectionFailure("device_management_original_operation_requires_reconciliation")
	}
	receipt, e := l.call(ctx, "/v2/identity/control/commit", commit, true)
	if e != nil {
		_ = l.update(ctx, operationKey, func(current map[string]any) (map[string]any, error) {
			if current == nil || !connectionEqual(current["commit"], commit) {
				return nil, connectionFailure("device_management_pending_changed")
			}
			if !identityTerminal(text(current["state"])) {
				current["state"] = "result-unknown"
			}
			return current, nil
		})
		_ = l.update(ctx, d.journalKey(l.scope.Owner), func(j map[string]any) (map[string]any, error) {
			active := uploadObject(j["active"])
			if active["operationId"] == row["operationId"] {
				active["state"] = "result-unknown"
				j["active"] = active
			}
			return j, nil
		})
		return nil, e
	}
	return d.recordReceipt(ctx, l, row, receipt)
}
func (d *NativeDeviceManagement) StopRetryReviewed(ctx context.Context, operationID string, scope *ChoiceScope) (any, error) {
	if !controlUUID(operationID) || scope == nil {
		return nil, connectionFailure("device_management_confirmation_required")
	}
	ctx, cancel, l, e := d.runtime.identityLease(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if l.scope != *scope {
		return nil, connectionFailure("native_choice_binding_changed")
	}
	journal, e := l.read(ctx, d.journalKey(l.scope.Owner))
	if e != nil {
		return nil, e
	}
	row := uploadObject(journal["active"])
	if row["operationId"] != operationID {
		return nil, connectionFailure("device_management_operation_unavailable")
	}
	result, e := d.receipt(ctx, l, row)
	if e != nil {
		if check := l.check(ctx); check != nil {
			return nil, check
		}
		result = uploadObject(deviceReference(row))
		uploadObject(result)["receipt"], uploadObject(result)["state"], uploadObject(result)["receiptUnavailable"] = nil, "result-unknown", true
	}
	if identityTerminal(text(uploadObject(uploadObject(result)["receipt"])["state"])) {
		return result, nil
	}
	saved, e := l.read(ctx, identityOperationKey(d.runtime.config.Endpoint, operationID))
	if e != nil {
		return nil, e
	}
	e = l.update(ctx, d.journalKey(l.scope.Owner), func(j map[string]any) (map[string]any, error) {
		active := uploadObject(j["active"])
		if active["operationId"] != operationID {
			return nil, connectionFailure("device_management_pending_changed")
		}
		active["stopped"] = true
		if saved["commit"] != nil {
			j["active"] = active
		} else {
			stopped := uploadObject(deviceReference(active))
			stopped["state"], stopped["stopped"] = "stopped-local", true
			history := append([]any{stopped}, uploadRows(j["history"])...)
			j["active"], j["history"] = nil, history[:min(len(history), 50)]
		}
		return j, nil
	})
	if e != nil {
		return nil, e
	}
	out := uploadObject(result)
	out["localRetryStopped"], out["serverCancellationConfirmed"], out["currentAccessGranted"] = true, false, false
	return out, nil
}
