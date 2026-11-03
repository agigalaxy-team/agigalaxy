package native

import (
	"context"
	"crypto/ed25519"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

// execute retains exact challenge and signed commit before sending. Once signed,
// this path only queries the original receipt; it never blindly resends.
func (h *NativeDeviceHandoff) executeControl(ctx context.Context, l *nativeIdentityLease, request map[string]any, controller, newDevice ed25519.PrivateKey) (map[string]any, error) {
	id := text(request["operationId"])
	key := identityOperationKey(h.runtime.config.Endpoint, id)
	saved, e := l.read(ctx, key)
	if e != nil {
		return nil, e
	}
	if saved != nil && saved["commit"] != nil {
		receipt, e := l.call(ctx, "/v2/identity/control/status", saved["commit"], true)
		if e != nil {
			return nil, e
		}
		if e = identityCheckControlReceipt(receipt, request); e != nil {
			return nil, e
		}
		return receipt, nil
	}
	if saved == nil {
		saved, e = h.prepareControl(ctx, l, request)
		if e != nil {
			return nil, e
		}
	} else if !connectionEqual(saved["request"], request) {
		return nil, connectionFailure("identity_control_original_changed")
	}
	raw := text(saved["challenge"])
	sig, e := identity.SignIdentityPayload(controller, raw, "galaxy-identity-control-v2+jws")
	if e != nil {
		return nil, e
	}
	commit := map[string]any{"operationId": id, "controllerSignature": sig}
	if newDevice != nil {
		proof, e := identity.SignIdentityPayload(newDevice, raw, "galaxy-identity-control-v2+jws")
		if e != nil {
			return nil, e
		}
		commit["newDeviceProof"] = proof
	}
	if e = l.update(ctx, key, func(current map[string]any) (map[string]any, error) {
		if current == nil || current["challenge"] != raw || !connectionEqual(current["request"], request) || current["commit"] != nil {
			return nil, connectionFailure("identity_control_original_changed")
		}
		current["commit"], current["state"] = commit, "signed-awaiting-result"
		return current, nil
	}); e != nil {
		return nil, e
	}
	receipt, e := l.call(ctx, "/v2/identity/control/commit", commit, true)
	if e != nil {
		return nil, e
	}
	if e = identityCheckControlReceipt(receipt, request); e != nil {
		return nil, e
	}
	return receipt, nil
}
