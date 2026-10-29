package native

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

// NativeRecovery owns only identity-control recovery. It never imports local
// work or sends recovery seeds to the authority. Callers must obtain the
// person's confirmation on a local surface before invoking the reviewed steps.
type NativeRecovery struct {
	runtime *Runtime
	handoff *NativeDeviceHandoff
}

func NewNativeRecovery(r *Runtime) *NativeRecovery {
	return &NativeRecovery{runtime: r, handoff: NewNativeDeviceHandoff(r)}
}

const recoveryCodePrefix = "galaxy-recovery-v1:"

func recoveryCodeKey(code string) (string, ed25519.PrivateKey, error) {
	if !strings.HasPrefix(code, recoveryCodePrefix) {
		return "", nil, connectionFailure("identity_recovery_code_invalid")
	}
	parts := strings.Split(strings.TrimPrefix(code, recoveryCodePrefix), ":")
	if len(parts) != 2 || !connectionSubject.MatchString(parts[0]) {
		return "", nil, connectionFailure("identity_recovery_code_invalid")
	}
	seed, e := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if e != nil || len(seed) != ed25519.SeedSize || base64.RawURLEncoding.EncodeToString(seed) != parts[1] {
		return "", nil, connectionFailure("identity_recovery_code_invalid")
	}
	key := ed25519.NewKeyFromSeed(seed)
	clear(seed)
	return parts[0], key, nil
}
func recoveryKeyPath(dir, id string) string {
	return filepath.Join(dir, "native-v2", "keys", "recovery-"+id+".pem")
}
func recoveryRecordKey(endpoint, id string) string { return "identity-recovery:" + endpoint + ":" + id }
func recoveryCreateKey(dir, id string) (string, error) {
	if !handoffUUID(id) {
		return "", connectionFailure("identity_recovery_operation_invalid")
	}
	public, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		return "", e
	}
	defer clear(private)
	der, e := x509.MarshalPKCS8PrivateKey(private)
	if e != nil {
		return "", e
	}
	defer clear(der)
	path := recoveryKeyPath(dir, id)
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return "", e
	}
	file, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return "", e
	}
	_, we := file.Write(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	ce := file.Close()
	if we != nil {
		return "", we
	}
	if ce != nil {
		return "", ce
	}
	return identity.PublicPEM(public)
}
func recoveryReadKey(dir, id string) (ed25519.PrivateKey, error) {
	if !handoffUUID(id) {
		return nil, connectionFailure("identity_recovery_operation_invalid")
	}
	raw, e := os.ReadFile(recoveryKeyPath(dir, id))
	if e != nil || len(raw) > 4096 {
		return nil, connectionFailure("identity_recovery_material_unavailable")
	}
	defer clear(raw)
	return identity.PrivatePEM(raw)
}

// codeForLocalDisplay is intentionally private: its result is only for the
// dedicated temporary local page and never belongs in MCP or journal records.
func (n *NativeRecovery) codeForLocalDisplay(ctx context.Context, id string) (string, error) {
	var result string
	e := n.runtime.store.With(ctx, false, func(dir string) error {
		var row map[string]any
		if _, e := readJSON(connectionRecordPath(dir, recoveryRecordKey(n.runtime.config.Endpoint, id)), &row); e != nil {
			return e
		}
		if row == nil || !connectionSubject.MatchString(text(row["subjectId"])) {
			return connectionFailure("identity_recovery_material_unavailable")
		}
		key, e := recoveryReadKey(dir, id)
		if e != nil {
			return e
		}
		defer clear(key)
		public, err := identity.PublicPEM(key.Public().(ed25519.PublicKey))
		if err != nil {
			return err
		}
		expected := text(row["publicKeyPem"])
		if row["kind"] == "recover" {
			expected = text(row["nextRecoveryPublicKey"])
		}
		if public != expected {
			return connectionFailure("identity_recovery_material_unavailable")
		}
		seed := key.Seed()
		defer clear(seed)
		result = recoveryCodePrefix + text(row["subjectId"]) + ":" + base64.RawURLEncoding.EncodeToString(seed)
		return nil
	})
	return result, e
}
func (n *NativeRecovery) forgetPendingSecret(ctx context.Context, id string) error {
	if !handoffUUID(id) {
		return connectionFailure("identity_recovery_operation_invalid")
	}
	return n.runtime.store.With(ctx, true, func(dir string) error {
		e := os.Remove(recoveryKeyPath(dir, id))
		if os.IsNotExist(e) {
			return nil
		}
		return e
	})
}
func (n *NativeRecovery) PrepareSet(ctx context.Context, scope *ChoiceScope) (map[string]any, error) {
	if scope == nil {
		return nil, connectionFailure("identity_recovery_confirmation_required")
	}
	ctx, done, l, e := n.handoff.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	if l.scope != *scope || l.scope.Owner == "" {
		return nil, connectionFailure("native_choice_binding_changed")
	}
	state, e := l.control(ctx)
	if e != nil {
		return nil, e
	}
	if !deviceCanManage(deviceManager(state, l.scope.DeviceID)) {
		return nil, connectionFailure("identity_control_permission_required")
	}
	id := uuid.NewString()
	var public string
	e = n.runtime.store.With(ctx, true, func(dir string) error {
		if e := n.runtime.store.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		var err error
		public, err = recoveryCreateKey(dir, id)
		if err != nil {
			return err
		}
		return uploadNativeRecordWithin(dir, recoveryRecordKey(n.runtime.config.Endpoint, id), map[string]any{"operationId": id, "subjectId": scope.Owner, "kind": "set-recovery", "publicKeyPem": public, "state": "awaiting-person-save", "scope": scope})
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"operationId": id, "subjectId": scope.Owner, "state": "awaiting-person-save"}, nil
}
func recoveryRequest(state map[string]any, kind, id, subject, signer string) map[string]any {
	return map[string]any{"version": 2, "kind": kind, "operationId": id, "subjectId": subject, "expectedEpoch": state["epoch"], "previousEventHash": state["chainHead"], "signerKeyId": signer}
}

// execute retains exact challenge and signed commit before sending. Once signed,
// this path only queries the original receipt; it never blindly resends.
func (n *NativeRecovery) execute(ctx context.Context, l *nativeIdentityLease, request map[string]any, controller, newDevice ed25519.PrivateKey) (map[string]any, error) {
	id := text(request["operationId"])
	key := identityOperationKey(n.runtime.config.Endpoint, id)
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
		saved, e = n.handoff.prepareControl(ctx, l, request)
		if e != nil {
			return nil, e
		}
	} else if !connectionEqual(saved["request"], request) {
		return nil, connectionFailure("identity_recovery_original_changed")
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
			return nil, connectionFailure("identity_recovery_original_changed")
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
func (n *NativeRecovery) ConfirmSet(ctx context.Context, id string, scope *ChoiceScope) (map[string]any, error) {
	if scope == nil || !handoffUUID(id) {
		return nil, connectionFailure("identity_recovery_confirmation_required")
	}
	ctx, done, l, e := n.handoff.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	if l.scope != *scope {
		return nil, connectionFailure("native_choice_binding_changed")
	}
	row, e := l.read(ctx, recoveryRecordKey(n.runtime.config.Endpoint, id))
	if e != nil || row == nil {
		return nil, connectionFailure("identity_recovery_material_unavailable")
	}
	if row["subjectId"] != l.scope.Owner || row["kind"] != "set-recovery" || !connectionEqual(row["scope"], identityClone(l.scope)) {
		return nil, connectionFailure("identity_recovery_original_changed")
	}
	saved, e := l.read(ctx, identityOperationKey(n.runtime.config.Endpoint, id))
	if e != nil {
		return nil, e
	}
	var request map[string]any
	if saved != nil {
		request = uploadObject(saved["request"])
	} else {
		state, e := l.control(ctx)
		if e != nil {
			return nil, e
		}
		device := deviceManager(state, l.scope.DeviceID)
		if !deviceCanManage(device) {
			return nil, connectionFailure("identity_control_permission_required")
		}
		generation := int64(0)
		if recovery := uploadObject(state["recovery"]); recovery != nil {
			generation = integer(recovery["generation"])
		}
		request = recoveryRequest(state, "set-recovery", id, l.scope.Owner, text(device["key_id"]))
		request["recoveryGeneration"], request["nextRecoveryPublicKey"], request["saveDeclaration"] = generation, row["publicKeyPem"], true
	}
	private, _, e := n.runtime.connection.deviceKey(ctx, l.connection)
	if e != nil {
		return nil, e
	}
	defer clear(private)
	receipt, e := n.execute(ctx, l, request, private, nil)
	if e != nil {
		return nil, e
	}
	if receipt["state"] == "committed" {
		if e = l.update(ctx, recoveryRecordKey(n.runtime.config.Endpoint, id), func(current map[string]any) (map[string]any, error) {
			if current == nil || current["publicKeyPem"] != row["publicKeyPem"] {
				return nil, connectionFailure("identity_recovery_original_changed")
			}
			current["state"], current["receipt"] = "registered", receipt
			return current, nil
		}); e != nil {
			return nil, e
		}
	}
	if receipt["state"] == "committed" {
		if e = n.forgetPendingSecret(ctx, id); e != nil {
			return nil, e
		}
	}
	return map[string]any{"operationId": id, "subjectId": row["subjectId"], "receipt": receipt, "recoveryCodeReturned": false}, nil
}

// RecoverReviewed is called only after the person enters the original code on
// the local surface and confirms its irreversible device replacement effects.
func (n *NativeRecovery) RecoverReviewed(ctx context.Context, code string, scope *ChoiceScope) (map[string]any, error) {
	return n.recoverReviewedID(ctx, uuid.NewString(), code, scope)
}
func (n *NativeRecovery) recoverReviewedID(ctx context.Context, id, code string, scope *ChoiceScope) (map[string]any, error) {
	if scope == nil || !handoffUUID(id) {
		return nil, connectionFailure("identity_recovery_confirmation_required")
	}
	subject, oldKey, e := recoveryCodeKey(code)
	if e != nil {
		return nil, e
	}
	defer clear(oldKey)
	ctx, done, l, e := n.handoff.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	if l.scope != *scope {
		return nil, connectionFailure("native_choice_binding_changed")
	}
	state, e := l.handoffControl(ctx, subject)
	if e != nil {
		return nil, e
	}
	public, e := identity.PublicPEM(oldKey.Public().(ed25519.PublicKey))
	if e != nil {
		return nil, e
	}
	verifiedRaw, e := protocol.Encode(state)
	if e != nil {
		return nil, e
	}
	verified, e := identity.VerifyControlChain(verifiedRaw)
	if e != nil || verified.Recovery == nil || verified.Recovery.PublicKey != public {
		return nil, connectionFailure("identity_recovery_code_not_current")
	}
	current := uploadObject(state["recovery"])
	if current == nil || current["publicKeyPem"] != public || integer(current["generation"]) != verified.Recovery.Generation {
		return nil, connectionFailure("identity_recovery_code_not_current")
	}
	var nextPublic string
	var device map[string]any
	e = n.runtime.store.With(ctx, true, func(dir string) error {
		if e := n.runtime.store.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		var err error
		nextPublic, err = recoveryCreateKey(dir, id)
		if err != nil {
			return err
		}
		device, err = l.newHandoffDeviceWithin(dir, subject)
		if err != nil {
			return err
		}
		record := map[string]any{"operationId": id, "kind": "recover", "subjectId": subject, "deviceId": device["deviceId"], "devicePublicKey": device["publicKeyPem"], "installationId": uuid.NewString(), "nextRecoveryPublicKey": nextPublic, "genesisProof": state["genesisProof"], "state": "prepared", "originalScope": scope}
		return uploadNativeRecordWithin(dir, recoveryRecordKey(n.runtime.config.Endpoint, id), record)
	})
	if e != nil {
		return nil, e
	}
	request := recoveryRequest(state, "recover", id, subject, identity.Digest([]byte(public)))
	request["recoveryGeneration"], request["nextRecoveryPublicKey"] = verified.Recovery.Generation, nextPublic
	request["newDevice"] = map[string]any{"deviceId": device["deviceId"], "publicKeyPem": device["publicKeyPem"], "scopes": append([]string{"manage-identity"}, connectionBrowserScopes...)}
	newKey, _, e := l.handoffKey(ctx, subject, text(device["deviceId"]))
	if e != nil {
		return nil, e
	}
	defer clear(newKey)
	receipt, e := n.execute(ctx, l, request, oldKey, newKey)
	if e != nil {
		return map[string]any{"operationId": id, "state": "original-operation-needs-reconciliation", "currentAccessGranted": false, "recoveryCodeReturned": false}, e
	}
	return n.finishRecover(ctx, l, id, receipt)
}
func (n *NativeRecovery) finishRecover(ctx context.Context, l *nativeIdentityLease, id string, receipt map[string]any) (map[string]any, error) {
	row, e := l.read(ctx, recoveryRecordKey(n.runtime.config.Endpoint, id))
	if e != nil || row == nil {
		return nil, connectionFailure("identity_recovery_material_unavailable")
	}
	if !connectionEqual(row["originalScope"], identityClone(l.scope)) {
		return nil, connectionFailure("native_choice_binding_changed")
	}
	if receipt["state"] != "committed" {
		return map[string]any{"operationId": id, "state": receipt["state"], "receipt": receipt, "currentAccessGranted": false}, nil
	}
	if receipt["subjectId"] != row["subjectId"] || receipt["deviceId"] != row["deviceId"] || receipt["kind"] != "recover" {
		return nil, connectionFailure("identity_recovery_receipt_invalid")
	}
	// Confirm the committed chain and recovered device before selecting it.
	controlState, e := l.handoffControl(ctx, text(row["subjectId"]))
	if e != nil {
		return nil, e
	}
	verified, e := verifyConnectionControl(controlState)
	if e != nil {
		return nil, e
	}
	device, ok := verified.Devices[identity.Digest([]byte(text(row["devicePublicKey"])))]
	if !ok || device.DeviceID != row["deviceId"] || device.Epoch != verified.Epoch || verified.Head != receipt["chainHead"] || !connectionEqual(controlState["genesisProof"], row["genesisProof"]) {
		return nil, connectionFailure("identity_recovery_receipt_invalid")
	}
	controlCache := map[string]any{"subjectId": controlState["subjectId"], "genesisProof": controlState["genesisProof"], "events": controlState["events"], "authority": controlState["authority"], "checkedAt": controlState["checkedAt"]}
	if e = l.update(ctx, recoveryRecordKey(n.runtime.config.Endpoint, id), func(current map[string]any) (map[string]any, error) {
		if current == nil || current["deviceId"] != row["deviceId"] {
			return nil, connectionFailure("identity_recovery_original_changed")
		}
		current["state"], current["receipt"] = "committed-awaiting-selection", receipt
		return current, nil
	}); e != nil {
		return nil, e
	}
	active := map[string]any{"subjectId": row["subjectId"], "deviceId": row["deviceId"], "installationId": row["installationId"], "genesisProof": row["genesisProof"]}
	_, e = n.runtime.activateHandoff(ctx, l, active, func(dir string) error {
		var current, operation, material map[string]any
		if _, e := readJSON(connectionRecordPath(dir, recoveryRecordKey(n.runtime.config.Endpoint, id)), &current); e != nil {
			return e
		}
		if _, e := readJSON(connectionRecordPath(dir, identityOperationKey(n.runtime.config.Endpoint, id)), &operation); e != nil {
			return e
		}
		if _, e := readJSON(connectionRecordPath(dir, "device:"+text(row["subjectId"])+":"+text(row["deviceId"])), &material); e != nil {
			return e
		}
		if current["deviceId"] != row["deviceId"] || material["publicKeyPem"] != row["devicePublicKey"] || operation["commit"] == nil {
			return connectionFailure("identity_recovery_original_changed")
		}
		cacheKey := "native-trust-identity:" + n.runtime.config.Endpoint + ":" + text(row["subjectId"])
		var prior map[string]any
		exists, err := readJSON(connectionRecordPath(dir, cacheKey), &prior)
		if err != nil {
			return err
		}
		if exists {
			old, err := verifyConnectionControl(prior)
			if err != nil {
				return err
			}
			if old.Sequence > verified.Sequence || old.Sequence == verified.Sequence && old.Head != verified.Head {
				return connectionFailure("trust_identity_snapshot_rollback")
			}
		}
		if err = uploadNativeRecordWithin(dir, cacheKey, controlCache); err != nil {
			return err
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"operationId": id, "subjectId": row["subjectId"], "state": "registered-awaiting-save-declaration", "receipt": receipt, "connectionRequired": true, "dataRecovery": "separate/not-performed", "recoveryCodeReturned": false}, nil
}
func (n *NativeRecovery) Reconcile(ctx context.Context, id string) (map[string]any, error) {
	if !handoffUUID(id) {
		return nil, connectionFailure("identity_recovery_operation_invalid")
	}
	ctx, done, l, e := n.handoff.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	row, e := l.read(ctx, recoveryRecordKey(n.runtime.config.Endpoint, id))
	if e != nil || row == nil {
		return nil, connectionFailure("identity_recovery_material_unavailable")
	}
	if row["kind"] == "recover" && !(l.scope.Owner == row["subjectId"] && l.scope.DeviceID == row["deviceId"]) && !connectionEqual(row["originalScope"], identityClone(l.scope)) {
		return nil, connectionFailure("native_choice_binding_changed")
	}
	if row["kind"] == "set-recovery" && !connectionEqual(row["scope"], identityClone(l.scope)) {
		return nil, connectionFailure("native_choice_binding_changed")
	}
	saved, e := l.read(ctx, identityOperationKey(n.runtime.config.Endpoint, id))
	if e != nil {
		return nil, e
	}
	if saved == nil || saved["commit"] == nil {
		return map[string]any{"operationId": id, "state": "not-dispatched", "currentAccessGranted": false}, nil
	}
	request := uploadObject(saved["request"])
	receipt, e := n.execute(ctx, l, request, nil, nil)
	if e != nil {
		return nil, e
	}
	if row["kind"] == "recover" && receipt["state"] == "committed" {
		if l.scope.Owner == row["subjectId"] && l.scope.DeviceID == row["deviceId"] {
			state := "registered-awaiting-save-declaration"
			if row["state"] == "registered" {
				state = "registered"
			}
			return map[string]any{"operationId": id, "state": state, "receipt": receipt, "connectionRequired": true, "recoveryCodeReturned": false}, nil
		}
		return n.finishRecover(ctx, l, id, receipt)
	}
	return map[string]any{"operationId": id, "state": receipt["state"], "receipt": receipt, "currentAccessGranted": false}, nil
}
func (n *NativeRecovery) ConfirmNextSaved(ctx context.Context, id string, scope *ChoiceScope) (map[string]any, error) {
	if scope == nil || !handoffUUID(id) {
		return nil, connectionFailure("identity_recovery_confirmation_required")
	}
	ctx, done, l, e := n.handoff.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	if l.scope != *scope {
		return nil, connectionFailure("native_choice_binding_changed")
	}
	row, e := l.read(ctx, recoveryRecordKey(n.runtime.config.Endpoint, id))
	if e != nil || row == nil || row["kind"] != "recover" || row["subjectId"] != scope.Owner || row["deviceId"] != scope.DeviceID {
		return nil, connectionFailure("identity_recovery_original_changed")
	}
	operation := text(row["declarationOperationId"])
	if operation == "" {
		operation = uuid.NewString()
		if e = l.update(ctx, recoveryRecordKey(n.runtime.config.Endpoint, id), func(v map[string]any) (map[string]any, error) {
			if v == nil || v["declarationOperationId"] != nil {
				return nil, connectionFailure("identity_recovery_original_changed")
			}
			v["declarationOperationId"] = operation
			return v, nil
		}); e != nil {
			return nil, e
		}
	}
	saved, e := l.read(ctx, identityOperationKey(n.runtime.config.Endpoint, operation))
	if e != nil {
		return nil, e
	}
	var request map[string]any
	if saved != nil {
		request = uploadObject(saved["request"])
	} else {
		state, e := l.control(ctx)
		if e != nil {
			return nil, e
		}
		recovery := uploadObject(state["recovery"])
		device := deviceManager(state, l.scope.DeviceID)
		if recovery["publicKeyPem"] != row["nextRecoveryPublicKey"] || !deviceCanManage(device) {
			return nil, connectionFailure("identity_recovery_original_changed")
		}
		request = recoveryRequest(state, "declare-recovery-saved", operation, l.scope.Owner, text(device["key_id"]))
		request["recoveryGeneration"], request["saveDeclaration"] = recovery["generation"], true
	}
	key, _, e := n.runtime.connection.deviceKey(ctx, l.connection)
	if e != nil {
		return nil, e
	}
	defer clear(key)
	receipt, e := n.execute(ctx, l, request, key, nil)
	if e != nil {
		return nil, e
	}
	if receipt["state"] == "committed" {
		if e = l.update(ctx, recoveryRecordKey(n.runtime.config.Endpoint, id), func(v map[string]any) (map[string]any, error) {
			if v == nil || v["declarationOperationId"] != operation {
				return nil, connectionFailure("identity_recovery_original_changed")
			}
			v["state"] = "registered"
			return v, nil
		}); e != nil {
			return nil, e
		}
	}
	if receipt["state"] == "committed" {
		if e = n.forgetPendingSecret(ctx, id); e != nil {
			return nil, e
		}
	}
	return map[string]any{"operationId": id, "declarationOperationId": operation, "receipt": receipt, "connectionRequired": true, "recoveryCodeReturned": false}, nil
}

// RetryOriginalReviewed sends only an already signed original commit after a
// fresh read proves that the authority still records it as requested. The
// caller must obtain a separate explicit person confirmation for this retry.
func (n *NativeRecovery) RetryOriginalReviewed(ctx context.Context, id string, scope *ChoiceScope) (map[string]any, error) {
	if scope == nil || !handoffUUID(id) {
		return nil, connectionFailure("identity_recovery_confirmation_required")
	}
	ctx, done, l, e := n.handoff.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	if l.scope != *scope {
		return nil, connectionFailure("native_choice_binding_changed")
	}
	row, e := l.read(ctx, recoveryRecordKey(n.runtime.config.Endpoint, id))
	if e != nil || row == nil {
		return nil, connectionFailure("identity_recovery_material_unavailable")
	}
	if row["kind"] == "recover" && !(l.scope.Owner == row["subjectId"] && l.scope.DeviceID == row["deviceId"]) && !connectionEqual(row["originalScope"], identityClone(l.scope)) {
		return nil, connectionFailure("native_choice_binding_changed")
	}
	if row["kind"] == "set-recovery" && !connectionEqual(row["scope"], identityClone(l.scope)) {
		return nil, connectionFailure("native_choice_binding_changed")
	}
	operation := id
	if row["kind"] == "recover" && l.scope.DeviceID == row["deviceId"] && row["declarationOperationId"] != nil {
		operation = text(row["declarationOperationId"])
	}
	saved, e := l.read(ctx, identityOperationKey(n.runtime.config.Endpoint, operation))
	if e != nil || saved == nil || saved["commit"] == nil {
		return nil, connectionFailure("identity_recovery_original_unavailable")
	}
	request, commit := uploadObject(saved["request"]), uploadObject(saved["commit"])
	prior, e := l.call(ctx, "/v2/identity/control/status", commit, true)
	if e != nil {
		return nil, e
	}
	if e = identityCheckControlReceipt(prior, request); e != nil {
		return nil, e
	}
	if prior["state"] != "requested" {
		if row["kind"] == "recover" && operation == id && prior["state"] == "committed" {
			return n.finishRecover(ctx, l, id, prior)
		}
		return map[string]any{"operationId": id, "receipt": prior, "state": prior["state"]}, nil
	}
	if integer(saved["expiresAt"]) <= n.runtime.connection.now().Unix() {
		return nil, connectionFailure("device_approval_expired")
	}
	receipt, e := l.call(ctx, "/v2/identity/control/commit", commit, true)
	if e != nil {
		return nil, e
	}
	if e = identityCheckControlReceipt(receipt, request); e != nil {
		return nil, e
	}
	if row["kind"] == "recover" && operation == id && receipt["state"] == "committed" {
		return n.finishRecover(ctx, l, id, receipt)
	}
	return map[string]any{"operationId": id, "receipt": receipt, "state": receipt["state"]}, nil
}
