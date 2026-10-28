package native

import "context"

func (h *NativeDeviceHandoff) Cancel(parent context.Context, operationID string) (any, error) {
	if !handoffUUID(operationID) {
		return nil, connectionFailure("device_request_not_owned")
	}
	ctx, cancel, l, e := h.begin(parent)
	if e != nil {
		return nil, e
	}
	defer cancel()
	record, e := l.read(ctx, h.key(operationID))
	if e != nil {
		return nil, e
	}
	if record == nil {
		return nil, connectionFailure("device_request_not_owned")
	}
	offer := uploadObject(record["offer"])
	if active := l.connection.selection.Active; active != nil && active.SubjectID != offer["subjectId"] {
		return nil, connectionFailure("device_identity_switch_required")
	}
	saved, e := l.read(ctx, identityOperationKey(h.runtime.config.Endpoint, operationID))
	if e != nil {
		return nil, e
	}
	if saved["commit"] != nil {
		request := uploadObject(saved["request"])
		device := uploadObject(request["newDevice"])
		commit := uploadObject(saved["commit"])
		if commit["operationId"] != operationID || request["operationId"] != operationID || request["subjectId"] != offer["subjectId"] || device["deviceId"] != offer["deviceId"] || device["publicKeyPem"] != offer["publicKeyPem"] {
			return nil, connectionFailure("device_handoff_original_changed")
		}
		if record["approval"] != nil {
			if e = handoffOriginal(uploadObject(record["approval"]), saved); e != nil {
				return nil, e
			}
		}
		receipt, e := l.call(ctx, "/v2/identity/control/cancel", commit, true)
		if e != nil {
			return nil, e
		}
		if e = identityCheckControlReceipt(receipt, request); e != nil || !isOne(text(receipt["state"]), "canceled", "expired", "committed") {
			return nil, connectionFailure("device_cancel_receipt_invalid")
		}
		if receipt["state"] == "committed" {
			return h.finish(parent, ctx, l, receipt, record)
		}
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
		return map[string]any{"receipt": receipt, "activated": false}, nil
	}
	e = l.update(ctx, h.key(operationID), func(current map[string]any) (map[string]any, error) {
		if current == nil || !connectionEqual(current, record) {
			return nil, connectionFailure("device_handoff_original_changed")
		}
		current["state"] = "canceled"
		return current, nil
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"receipt": map[string]any{"operationId": operationID, "state": "canceled", "localOnly": true}, "activated": false}, nil
}
