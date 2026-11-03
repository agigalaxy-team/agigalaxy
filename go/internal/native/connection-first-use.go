package native

import (
	"context"
	"crypto/ed25519"
	"os"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
)

// First-use selection is an explicit connect operation, never a side effect of
// status/restore. It uses the same signed control protocol as device handoff.
func (r *Runtime) firstConnectMaterial(ctx context.Context, selected connectionSelection) (map[string]any, ed25519.PrivateKey, error) {
	var local map[string]any
	var key ed25519.PrivateKey
	e := r.store.With(ctx, false, func(dir string) error {
		current, e := r.connection.selectionWithin(dir)
		if e != nil {
			return e
		}
		if current.Active != nil || current.fingerprint != selected.fingerprint {
			return connectionFailure("native_connection_selection_changed")
		}
		if e = readFallback(dir, "galaxy-id.json", "node.json", &local); e != nil {
			return e
		}
		proof := uploadObject(local["genesisProof"])
		if !connectionGenesis(text(local["id"]), proof) {
			return connectionFailure("native_identity_selection_invalid")
		}
		raw, e := os.ReadFile(filepath.Join(dir, "galaxy-id-private-key.pem"))
		if e != nil {
			return connectionFailure("device_key_unavailable")
		}
		defer clear(raw)
		key, e = identity.PrivatePEM(raw)
		if e != nil {
			return e
		}
		public, e := identity.PublicPEM(key.Public().(ed25519.PublicKey))
		if e != nil || public != proof["publicKeyPem"] {
			clear(key)
			return connectionFailure("native_device_key_mismatch")
		}
		return nil
	})
	return local, key, e
}

func (r *Runtime) prepareFirstConnect(ctx context.Context, lease connectionLease) (ConnectionSettingsPlan, error) {
	local, key, e := r.firstConnectMaterial(ctx, lease.selection)
	if e != nil {
		return ConnectionSettingsPlan{}, e
	}
	clear(key)
	proof := uploadObject(local["genesisProof"])
	return ConnectionSettingsPlan{GalaxyID: text(local["id"]), Endpoint: r.config.Endpoint, Revision: lease.selection.Revision,
		SelectionDigest: lease.selection.fingerprint, DeviceKeyID: identity.Digest([]byte(text(proof["publicKeyPem"]))),
		FirstUse: true, ControlVerification: "first-device-registration", Scopes: append([]string{}, connectionBrowserScopes...)}, nil
}

func (r *Runtime) firstConnectReviewed(ctx context.Context, plan ConnectionSettingsPlan, scope *ChoiceScope) (ChoiceScope, error) {
	ctx, done, l, e := r.deviceHandoff.begin(ctx)
	if e != nil {
		return ChoiceScope{}, e
	}
	defer done()
	if scope == nil || *scope != l.scope || scope.DeviceID != "" || l.connection.selection.Active != nil {
		return ChoiceScope{}, connectionFailure("native_connection_choice_required")
	}
	current, e := r.prepareFirstConnect(ctx, l.connection)
	if e != nil {
		return ChoiceScope{}, e
	}
	if !connectionEqual(current, plan) {
		return ChoiceScope{}, connectionFailure("native_connection_selection_changed")
	}
	local, key, e := r.firstConnectMaterial(ctx, l.connection.selection)
	if e != nil {
		return ChoiceScope{}, e
	}
	defer clear(key)
	proof := uploadObject(local["genesisProof"])
	// Persist the original identifiers before any remote write. Subsequent
	// connects reconcile this operation, including after a process restart.
	pendingKey := "native-first-connect:" + plan.Endpoint + ":" + plan.GalaxyID
	e = l.update(ctx, pendingKey, func(row map[string]any) (map[string]any, error) {
		if row != nil {
			if row["selectionDigest"] != plan.SelectionDigest || !connectionEqual(row["scope"], identityClone(scope)) {
				return nil, connectionFailure("native_connection_selection_changed")
			}
			return row, nil
		}
		device := uuid.NewString()
		request := map[string]any{"version": 2, "operationId": uuid.NewString(), "subjectId": plan.GalaxyID, "kind": "bootstrap",
			"expectedEpoch": 0, "previousEventHash": nil, "signerKeyId": plan.DeviceKeyID, "genesisProof": proof,
			"newDevice": map[string]any{"deviceId": device, "publicKeyPem": proof["publicKeyPem"], "scopes": append([]string{"manage-identity"}, plan.Scopes...)}}
		return map[string]any{"selectionDigest": plan.SelectionDigest, "scope": scope, "request": request, "installationId": uuid.NewString()}, nil
	})
	if e != nil {
		return ChoiceScope{}, e
	}
	row, e := l.read(ctx, pendingKey)
	if e != nil {
		return ChoiceScope{}, e
	}
	request := uploadObject(row["request"])
	device := uploadObject(request["newDevice"])
	if request["subjectId"] != plan.GalaxyID || request["kind"] != "bootstrap" || request["signerKeyId"] != plan.DeviceKeyID || !connectionEqual(request["genesisProof"], proof) || device["publicKeyPem"] != proof["publicKeyPem"] || !handoffUUID(device["deviceId"]) || !handoffUUID(row["installationId"]) {
		return ChoiceScope{}, connectionFailure("native_connection_selection_changed")
	}
	receipt, e := r.deviceHandoff.executeControl(ctx, l, request, key, key)
	if e != nil {
		return ChoiceScope{}, e
	}
	if receipt["state"] != "committed" {
		return ChoiceScope{}, connectionFailure("native_first_connection_pending")
	}
	state, e := l.handoffControl(ctx, plan.GalaxyID)
	if e != nil {
		return ChoiceScope{}, e
	}
	verified, e := verifyConnectionControl(state)
	if e != nil {
		return ChoiceScope{}, e
	}
	controlled, ok := verified.Devices[plan.DeviceKeyID]
	if !ok || controlled.DeviceID != device["deviceId"] || controlled.Epoch != verified.Epoch || verified.Head != receipt["chainHead"] || !connectionEqual(state["genesisProof"], proof) {
		return ChoiceScope{}, connectionFailure("native_device_key_mismatch")
	}
	active := map[string]any{"subjectId": plan.GalaxyID, "deviceId": device["deviceId"], "installationId": row["installationId"], "genesisProof": proof}
	return r.activateHandoff(ctx, l, active, func(dir string) error {
		material := map[string]any{"deviceId": device["deviceId"], "nativeDeviceKey": device["deviceId"], "nativeGenesis": true, "publicKeyPem": proof["publicKeyPem"]}
		return uploadNativeRecordWithin(dir, "device:"+plan.GalaxyID+":"+text(device["deviceId"]), material)
	})
}
