package native

import (
	"context"
	"crypto/ed25519"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

func (h *NativeDeviceHandoff) PreviewOffer(ctx context.Context, raw string) (any, *ChoiceScope, error) {
	value, e := handoffObject(raw)
	if e != nil {
		return nil, nil, e
	}
	offer, e := h.offer(value)
	if e != nil {
		return nil, nil, e
	}
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, nil, e
	}
	defer cancel()
	result := identityClone(offer)
	result["fingerprint"] = identity.Digest([]byte(text(offer["publicKeyPem"])))
	return result, &l.scope, l.check(ctx)
}
func (h *NativeDeviceHandoff) ApproveReviewed(ctx context.Context, raw string, scope *ChoiceScope) (any, error) {
	value, e := handoffObject(raw)
	if e != nil {
		return nil, e
	}
	offer, e := h.offer(value)
	if e != nil {
		return nil, e
	}
	if scope == nil {
		return nil, connectionFailure("device_approval_confirmation_required")
	}
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if l.scope != *scope {
		return nil, connectionFailure("device_handoff_owner_changed")
	}
	active := l.connection.selection.Active
	if active == nil || active.SubjectID != offer["subjectId"] {
		return nil, connectionFailure("device_controller_identity_mismatch")
	}
	state, e := l.handoffControl(ctx, active.SubjectID)
	if e != nil {
		return nil, e
	}
	signer := deviceManager(state, active.DeviceID)
	_, public, e := h.runtime.connection.deviceKey(ctx, l.connection)
	if e != nil {
		return nil, e
	}
	if !deviceCanManage(signer) || signer["public_key"] != public {
		return nil, connectionFailure("device_controller_not_authorized")
	}
	scopes := mustUploadStrings(offer["scopes"])
	for _, scope := range scopes {
		if !connectionIncludes(mustUploadStrings(signer["scopes"]), "*") && !connectionIncludes(mustUploadStrings(signer["scopes"]), scope) {
			return nil, connectionFailure("device_scopes_expanded")
		}
	}
	request := map[string]any{"version": 2, "kind": "authorize-device", "operationId": offer["operationId"], "subjectId": offer["subjectId"], "expectedEpoch": state["epoch"], "previousEventHash": state["chainHead"], "signerKeyId": identity.Digest([]byte(public)), "newDevice": map[string]any{"deviceId": offer["deviceId"], "publicKeyPem": offer["publicKeyPem"], "scopes": scopes}}
	saved, e := h.prepareControl(ctx, l, request)
	if e != nil {
		return nil, e
	}
	signature := text(saved["controllerApproval"])
	if signature == "" {
		signature, e = l.sign(ctx, text(saved["challenge"]), "galaxy-identity-control-v2+jws")
		if e != nil {
			return nil, e
		}
	}
	e = l.update(ctx, identityOperationKey(h.runtime.config.Endpoint, text(offer["operationId"])), func(current map[string]any) (map[string]any, error) {
		if current == nil || current["challenge"] != saved["challenge"] || !connectionEqual(current["request"], request) || current["controllerApproval"] != nil && current["controllerApproval"] != signature {
			return nil, connectionFailure("device_handoff_original_changed")
		}
		current["controllerApproval"] = signature
		return current, nil
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"version": 1, "type": "galaxy-device-approval", "endpoint": h.runtime.config.Endpoint, "offer": offer, "request": request, "challenge": saved["challenge"], "controllerSignature": signature}, nil
}
func (h *NativeDeviceHandoff) local(ctx context.Context, l *nativeIdentityLease, value map[string]any) (map[string]any, ed25519.PrivateKey, error) {
	value, e := h.approval(value)
	if e != nil {
		return nil, nil, e
	}
	offer := uploadObject(value["offer"])
	record, e := l.read(ctx, h.key(text(offer["operationId"])))
	if e != nil {
		return nil, nil, e
	}
	if record == nil || !connectionEqual(record["offer"], offer) {
		return nil, nil, connectionFailure("device_request_not_owned")
	}
	active := l.connection.selection.Active
	if active != nil && active.SubjectID != offer["subjectId"] {
		return nil, nil, connectionFailure("device_identity_switch_required")
	}
	key, public, e := l.handoffKey(ctx, text(offer["subjectId"]), text(offer["deviceId"]))
	if e != nil {
		return nil, nil, e
	}
	if public != offer["publicKeyPem"] {
		return nil, nil, connectionFailure("device_key_unavailable")
	}
	return record, key, nil
}
func (h *NativeDeviceHandoff) inspect(ctx context.Context, l *nativeIdentityLease, value map[string]any) (map[string]any, error) {
	if _, _, e := h.local(ctx, l, value); e != nil {
		return nil, e
	}
	request := uploadObject(value["request"])
	offer := uploadObject(value["offer"])
	state, e := l.handoffControl(ctx, text(offer["subjectId"]))
	if e != nil {
		return nil, e
	}
	var signer map[string]any
	for _, candidate := range uploadRows(state["devices"]) {
		row := uploadObject(candidate)
		if row["key_id"] == request["signerKeyId"] && row["status"] == "active" && integer(row["epoch"]) == integer(state["epoch"]) {
			signer = row
		}
	}
	if !connectionEqual(state["epoch"], request["expectedEpoch"]) || state["chainHead"] != request["previousEventHash"] || !deviceCanManage(signer) {
		return nil, connectionFailure("device_approval_control_changed")
	}
	if e = handoffVerify(text(value["controllerSignature"]), text(value["challenge"]), text(signer["public_key"])); e != nil {
		return nil, e
	}
	challenge, _ := connectionObject([]byte(text(value["challenge"])))
	expires := integer(challenge["expiresAt"])
	if expires <= h.runtime.connection.now().Unix() || expires > h.runtime.connection.now().Unix()+180 {
		return nil, connectionFailure("device_approval_expired")
	}
	return map[string]any{"subjectId": request["subjectId"], "deviceId": offer["deviceId"], "endpoint": h.runtime.config.Endpoint, "scopes": uploadObject(request["newDevice"])["scopes"], "fingerprint": identity.Digest([]byte(text(offer["publicKeyPem"]))), "expiresAt": expires, "operationId": offer["operationId"]}, nil
}
func (h *NativeDeviceHandoff) PreviewApproval(ctx context.Context, raw string) (any, *ChoiceScope, error) {
	value, e := handoffObject(raw)
	if e != nil {
		return nil, nil, e
	}
	value, e = h.approval(value)
	if e != nil {
		return nil, nil, e
	}
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, nil, e
	}
	defer cancel()
	offer := uploadObject(value["offer"])
	if _, _, e = h.local(ctx, l, value); e != nil {
		return nil, nil, e
	}
	saved, e := l.read(ctx, identityOperationKey(h.runtime.config.Endpoint, text(offer["operationId"])))
	if e != nil {
		return nil, nil, e
	}
	if saved["commit"] != nil {
		if e = handoffOriginal(value, saved); e != nil {
			return nil, nil, e
		}
		receipt, e := l.call(ctx, "/v2/identity/control/status", saved["commit"], true)
		if e != nil {
			return nil, nil, e
		}
		if e = identityCheckControlReceipt(receipt, uploadObject(value["request"])); e != nil {
			return nil, nil, e
		}
		return map[string]any{"subjectId": offer["subjectId"], "deviceId": offer["deviceId"], "endpoint": h.runtime.config.Endpoint, "operationId": offer["operationId"], "scopes": uploadObject(uploadObject(value["request"])["newDevice"])["scopes"], "receipt": receipt, "hasOriginalCommit": true}, &l.scope, nil
	}
	preview, e := h.inspect(ctx, l, value)
	return preview, &l.scope, e
}
func handoffOriginal(value, saved map[string]any) error {
	request := uploadObject(value["request"])
	commit := uploadObject(saved["commit"])
	if !connectionEqual(saved["request"], request) || saved["challenge"] != value["challenge"] || commit != nil && (commit["operationId"] != request["operationId"] || commit["controllerSignature"] != value["controllerSignature"] || text(commit["newDeviceProof"]) == "") {
		return connectionFailure("device_handoff_original_changed")
	}
	return nil
}
