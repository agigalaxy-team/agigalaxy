package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

func (h *NativeDeviceHandoff) finish(parent, ctx context.Context, l *nativeIdentityLease, receipt, record map[string]any) (any, error) {
	if receipt["state"] != "committed" {
		return map[string]any{"receipt": receipt, "activated": false}, nil
	}
	if isOne(text(record["state"]), "canceled", "expired") {
		return map[string]any{"receipt": receipt, "activated": false, "localState": record["state"]}, nil
	}
	offer := uploadObject(record["offer"])
	approval := uploadObject(record["approval"])
	state, e := l.handoffControl(ctx, text(offer["subjectId"]))
	if e != nil {
		return nil, e
	}
	device := deviceManager(state, text(offer["deviceId"]))
	deviceScopes := mustUploadStrings(device["scopes"])
	if device == nil || device["public_key"] != offer["publicKeyPem"] || !connectionEqual(uploadObject(approval["request"])["expectedEpoch"], state["epoch"]) || !connectionEqual(receipt["epoch"], state["epoch"]) || !connectionIncludes(deviceScopes, "binding") && !connectionIncludes(deviceScopes, "*") {
		return nil, connectionFailure("device_authorization_no_longer_current")
	}
	active := l.connection.selection.Active
	if active != nil && active.SubjectID != offer["subjectId"] {
		return nil, connectionFailure("device_identity_switch_required")
	}
	publicIdentity := map[string]any{"subjectId": offer["subjectId"], "deviceId": offer["deviceId"]}
	if active != nil && active.DeviceID != offer["deviceId"] {
		if record["state"] != "committed" {
			e = l.update(ctx, h.key(text(offer["operationId"])), func(current map[string]any) (map[string]any, error) {
				if current == nil || !connectionEqual(current, record) {
					return nil, connectionFailure("device_handoff_original_changed")
				}
				current["state"], current["receipt"] = "awaiting-result", receipt
				return current, nil
			})
			if e != nil {
				return nil, e
			}
		}
		return map[string]any{"receipt": receipt, "identity": publicIdentity, "activated": false, "needsLocalDeviceSelection": true, "connectionRequired": false, "dataRecovery": "separate/not-performed"}, nil
	}
	if record["state"] == "committed" {
		return map[string]any{"receipt": receipt, "identity": publicIdentity, "activated": false, "alreadyActivated": active != nil, "needsLocalActivation": active == nil, "connectionRequired": false, "dataRecovery": "separate/not-performed"}, nil
	}
	if active != nil && active.SubjectID == offer["subjectId"] && active.DeviceID == offer["deviceId"] {
		e = l.update(ctx, h.key(text(offer["operationId"])), func(current map[string]any) (map[string]any, error) {
			if current == nil || !connectionEqual(current, record) {
				return nil, connectionFailure("device_handoff_original_changed")
			}
			current["state"], current["receipt"] = "committed", receipt
			return current, nil
		})
		if e != nil {
			return nil, e
		}
		return map[string]any{"receipt": receipt, "identity": publicIdentity, "activated": false, "alreadyActivated": true, "connectionRequired": false, "dataRecovery": "separate/not-performed"}, nil
	}
	if !handoffUUID(record["installationId"]) {
		return nil, connectionFailure("device_handoff_original_changed")
	}
	selected := map[string]any{"subjectId": offer["subjectId"], "genesisProof": state["genesisProof"], "deviceId": offer["deviceId"], "installationId": record["installationId"]}
	// Recheck all retained public operation bytes in the same lock as selection.
	// The private activation helper also CAS-checks owner/device/revision.
	current, e := l.read(ctx, h.key(text(offer["operationId"])))
	if e != nil {
		return nil, e
	}
	if !connectionEqual(current, record) {
		return nil, connectionFailure("device_handoff_original_changed")
	}
	operationKey := identityOperationKey(h.runtime.config.Endpoint, text(offer["operationId"]))
	originalOperation, e := l.read(ctx, operationKey)
	if e != nil {
		return nil, e
	}
	if e = handoffOriginal(approval, originalOperation); e != nil {
		return nil, e
	}
	commit := uploadObject(originalOperation["commit"])
	if commit == nil {
		return nil, connectionFailure("device_handoff_original_changed")
	}
	if e = handoffVerify(text(commit["newDeviceProof"]), text(originalOperation["challenge"]), text(offer["publicKeyPem"])); e != nil {
		return nil, e
	}
	next, e := h.runtime.activateHandoff(ctx, l, selected, func(dir string) error {
		var current, operation, material map[string]any
		if _, e := readJSON(connectionRecordPath(dir, h.key(text(offer["operationId"]))), &current); e != nil {
			return e
		}
		if _, e := readJSON(connectionRecordPath(dir, operationKey), &operation); e != nil {
			return e
		}
		if _, e := readJSON(connectionRecordPath(dir, "device:"+text(offer["subjectId"])+":"+text(offer["deviceId"])), &material); e != nil {
			return e
		}
		if !connectionEqual(current, record) || !connectionEqual(operation, originalOperation) || material["deviceId"] != offer["deviceId"] || material["publicKeyPem"] != offer["publicKeyPem"] || material["nativeDeviceKey"] != offer["deviceId"] {
			return connectionFailure("device_handoff_original_changed")
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	completedContext, done, completed, e := h.runtime.handoffLease(parent)
	if e != nil {
		return nil, e
	}
	defer done()
	if completed.scope != next {
		return nil, connectionFailure("device_handoff_owner_changed")
	}
	e = completed.update(completedContext, h.key(text(offer["operationId"])), func(current map[string]any) (map[string]any, error) {
		if current == nil || !connectionEqual(current, record) {
			return nil, connectionFailure("device_handoff_original_changed")
		}
		current["state"], current["receipt"] = "committed", receipt
		return current, nil
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"receipt": receipt, "identity": publicIdentity, "activated": true, "connectionRequired": true, "dataRecovery": "separate/not-performed"}, nil
}
func (h *NativeDeviceHandoff) AcceptReviewed(parent context.Context, raw string, scope *ChoiceScope) (any, error) {
	value, e := handoffObject(raw)
	if e != nil {
		return nil, e
	}
	value, e = h.approval(value)
	if e != nil {
		return nil, e
	}
	if scope == nil {
		return nil, connectionFailure("device_join_confirmation_required")
	}
	ctx, cancel, l, e := h.begin(parent)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if l.scope != *scope {
		return nil, connectionFailure("device_handoff_owner_changed")
	}
	record, key, e := h.local(ctx, l, value)
	if e != nil {
		return nil, e
	}
	if isOne(text(record["state"]), "canceled", "expired") {
		return nil, connectionFailure("device_request_canceled")
	}
	offer := uploadObject(value["offer"])
	operationID := text(offer["operationId"])
	saved, e := l.read(ctx, identityOperationKey(h.runtime.config.Endpoint, operationID))
	if e != nil {
		return nil, e
	}
	if saved["commit"] != nil {
		return h.reconcile(parent, ctx, l, operationID, true)
	}
	if _, e = h.inspect(ctx, l, value); e != nil {
		return nil, e
	}
	saved, e = h.prepareControl(ctx, l, uploadObject(value["request"]))
	if e != nil {
		return nil, e
	}
	if saved["challenge"] != value["challenge"] {
		return nil, connectionFailure("device_challenge_changed")
	}
	e = l.update(ctx, h.key(operationID), func(current map[string]any) (map[string]any, error) {
		if current == nil || !connectionEqual(current, record) {
			return nil, connectionFailure("device_handoff_original_changed")
		}
		current["approval"], current["state"] = value, "awaiting-result"
		return current, nil
	})
	if e != nil {
		return nil, e
	}
	record["approval"], record["state"] = value, "awaiting-result"
	proof, e := identity.SignIdentityPayload(key, text(value["challenge"]), "galaxy-identity-control-v2+jws")
	if e != nil {
		return nil, e
	}
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	commit := map[string]any{"operationId": operationID, "controllerSignature": value["controllerSignature"], "newDeviceProof": proof}
	e = l.update(ctx, identityOperationKey(h.runtime.config.Endpoint, operationID), func(current map[string]any) (map[string]any, error) {
		if current == nil || current["challenge"] != saved["challenge"] || !connectionEqual(current["request"], saved["request"]) || current["commit"] != nil && !connectionEqual(current["commit"], commit) {
			return nil, connectionFailure("device_handoff_original_changed")
		}
		current["commit"], current["state"] = commit, "signed-awaiting-result"
		return current, nil
	})
	if e != nil {
		return nil, e
	}
	receipt, e := l.call(ctx, "/v2/identity/control/commit", commit, true)
	if e != nil {
		_ = l.update(ctx, identityOperationKey(h.runtime.config.Endpoint, operationID), func(current map[string]any) (map[string]any, error) {
			if current == nil || !connectionEqual(current["commit"], commit) {
				return nil, connectionFailure("device_handoff_original_changed")
			}
			if !identityTerminal(text(current["state"])) {
				current["state"] = "result-unknown"
			}
			return current, nil
		})
		return nil, e
	}
	if e = identityCheckControlReceipt(receipt, uploadObject(value["request"])); e != nil {
		return nil, e
	}
	e = l.update(ctx, identityOperationKey(h.runtime.config.Endpoint, operationID), func(current map[string]any) (map[string]any, error) {
		if current == nil || !connectionEqual(current["commit"], commit) {
			return nil, connectionFailure("device_handoff_original_changed")
		}
		current["state"], current["receipt"] = receipt["state"], receipt
		return current, nil
	})
	if e != nil {
		return nil, e
	}
	return h.finish(parent, ctx, l, receipt, record)
}
func (h *NativeDeviceHandoff) reconcile(parent, ctx context.Context, l *nativeIdentityLease, operationID string, retry bool) (any, error) {
	record, e := l.read(ctx, h.key(operationID))
	if e != nil {
		return nil, e
	}
	if record == nil || record["approval"] == nil {
		return nil, connectionFailure("device_handoff_not_submitted")
	}
	value, e := h.approval(uploadObject(record["approval"]))
	if e != nil {
		return nil, e
	}
	if _, _, e = h.local(ctx, l, value); e != nil {
		return nil, e
	}
	saved, e := l.read(ctx, identityOperationKey(h.runtime.config.Endpoint, operationID))
	if e != nil {
		return nil, e
	}
	if saved != nil {
		if e = handoffOriginal(value, saved); e != nil {
			return nil, e
		}
	}
	offer := uploadObject(record["offer"])
	challenge, _ := connectionObject([]byte(text(value["challenge"])))
	var receipt map[string]any
	if saved["commit"] == nil && integer(challenge["expiresAt"]) <= h.runtime.connection.now().Unix() && record["state"] != "canceled" {
		receipt = map[string]any{"operationId": operationID, "subjectId": offer["subjectId"], "state": "expired", "registered": false, "localOnly": true}
		e = l.update(ctx, h.key(operationID), func(current map[string]any) (map[string]any, error) {
			if current == nil || !connectionEqual(current, record) {
				return nil, connectionFailure("device_handoff_original_changed")
			}
			current["state"], current["receipt"] = "expired", receipt
			return current, nil
		})
		if e != nil {
			return nil, e
		}
		record["state"] = "expired"
		result := map[string]any{"receipt": receipt, "activated": false}
		for key, value := range handoffMetadata(record, saved, receipt) {
			result[key] = value
		}
		return result, nil
	}
	if saved == nil {
		receipt = map[string]any{"operationId": operationID, "subjectId": offer["subjectId"], "state": record["state"], "registered": false}
	} else if saved["commit"] == nil {
		receipt = map[string]any{"operationId": operationID, "subjectId": offer["subjectId"], "state": saved["state"], "registered": false}
	} else {
		receipt, e = l.call(ctx, "/v2/identity/control/status", saved["commit"], true)
		if e != nil {
			return nil, e
		}
		if e = identityCheckControlReceipt(receipt, uploadObject(value["request"])); e != nil {
			return nil, e
		}
		if receipt["state"] == "requested" && retry && !isOne(text(record["state"]), "canceled", "expired", "committed") {
			receipt, e = l.call(ctx, "/v2/identity/control/commit", saved["commit"], true)
			if e != nil {
				return nil, e
			}
			if e = identityCheckControlReceipt(receipt, uploadObject(value["request"])); e != nil {
				return nil, e
			}
		}
		e = l.update(ctx, identityOperationKey(h.runtime.config.Endpoint, operationID), func(current map[string]any) (map[string]any, error) {
			if current == nil || !connectionEqual(current["request"], saved["request"]) || current["challenge"] != saved["challenge"] || !connectionEqual(current["commit"], saved["commit"]) {
				return nil, connectionFailure("device_handoff_original_changed")
			}
			current["state"], current["receipt"] = receipt["state"], receipt
			return current, nil
		})
		if e != nil {
			return nil, e
		}
	}
	if isOne(text(receipt["state"]), "expired", "canceled") {
		e = l.update(ctx, h.key(operationID), func(current map[string]any) (map[string]any, error) {
			if current == nil || !connectionEqual(current, record) {
				return nil, connectionFailure("device_handoff_original_changed")
			}
			current["state"], current["receipt"] = receipt["state"], receipt
			return current, nil
		})
		if e != nil {
			return nil, e
		}
		record["state"], record["receipt"] = receipt["state"], receipt
	}
	valueResult, e := h.finish(parent, ctx, l, receipt, record)
	if e != nil {
		return nil, e
	}
	result := uploadObject(valueResult)
	for key, value := range handoffMetadata(record, saved, receipt) {
		result[key] = value
	}
	return result, nil
}
func (h *NativeDeviceHandoff) Reconcile(parent context.Context, operationID string) (any, error) {
	if !handoffUUID(operationID) {
		return nil, connectionFailure("device_request_not_owned")
	}
	ctx, cancel, l, e := h.begin(parent)
	if e != nil {
		return nil, e
	}
	defer cancel()
	return h.reconcile(parent, ctx, l, operationID, false)
}
