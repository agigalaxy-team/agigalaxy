package native

import (
	"context"
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"sync"
)

type NativeDeviceManagement struct {
	runtime  *Runtime
	mu       sync.Mutex
	previews map[string]*nativeDevicePreview
	reserved int
}
type nativeDevicePreview struct {
	lease     *nativeIdentityLease
	original  map[string]any
	expiresAt int64
	state     string
}

func NewNativeDeviceManagement(runtime *Runtime) *NativeDeviceManagement {
	return &NativeDeviceManagement{runtime: runtime, previews: map[string]*nativeDevicePreview{}}
}
func (d *NativeDeviceManagement) release(operationID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for id, p := range d.previews {
		if p.state != "running" && p.original["operationId"] == operationID {
			delete(d.previews, id)
		}
	}
}
func identityOperationKey(endpoint, id string) string {
	return "identity-operation:" + endpoint + ":" + id
}
func (d *NativeDeviceManagement) journalKey(owner string) string {
	return "identity-device-management:" + d.runtime.config.Endpoint + ":" + owner
}
func identityTerminal(state string) bool { return isOne(state, "committed", "canceled", "expired") }
func deviceJournal(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{"active": nil, "history": []any{}}
	}
	return value
}
func deviceReference(row map[string]any) any {
	if row == nil {
		return nil
	}
	return map[string]any{"operationId": row["operationId"], "subjectId": row["subjectId"], "deviceId": row["deviceId"], "initiatorDeviceId": row["initiatorDeviceId"], "kind": "revoke-device", "requestHash": row["requestHash"], "challengeHash": row["challengeHash"], "state": row["state"], "localRetryStopped": row["stopped"] == true || row["localRetryStopped"] == true, "serverCancellationConfirmed": row["state"] == "canceled", "currentAccessGranted": false}
}
func deviceManager(state map[string]any, deviceID string) map[string]any {
	for _, value := range uploadRows(state["devices"]) {
		device := uploadObject(value)
		if device["device_id"] == deviceID && device["status"] == "active" && integer(device["epoch"]) == integer(state["epoch"]) {
			return device
		}
	}
	return nil
}
func deviceCanManage(device map[string]any) bool {
	scopes := mustUploadStrings(device["scopes"])
	return connectionIncludes(scopes, "manage-identity") || connectionIncludes(scopes, "*")
}
func (d *NativeDeviceManagement) current(ctx context.Context, l *nativeIdentityLease) (any, error) {
	state, e := l.control(ctx)
	if e != nil {
		return nil, e
	}
	canManage := deviceCanManage(deviceManager(state, l.scope.DeviceID))
	devices := []any{}
	for _, value := range uploadRows(state["devices"]) {
		device := uploadObject(value)
		canRevoke := canManage && device["status"] == "active" && integer(device["epoch"]) == integer(state["epoch"])
		if device["device_id"] == l.scope.DeviceID && state["recovery"] == nil {
			other := false
			for _, candidate := range uploadRows(state["devices"]) {
				row := uploadObject(candidate)
				if row["device_id"] != device["device_id"] && row["status"] == "active" && integer(row["epoch"]) == integer(state["epoch"]) && deviceCanManage(row) {
					other = true
				}
			}
			canRevoke = canRevoke && other
		}
		devices = append(devices, map[string]any{"deviceId": device["device_id"], "keyId": device["key_id"], "epoch": device["epoch"], "scopes": device["scopes"], "state": device["status"], "currentDevice": device["device_id"] == l.scope.DeviceID, "canRevoke": canRevoke})
	}
	return map[string]any{"subjectId": state["subjectId"], "endpoint": d.runtime.config.Endpoint, "deviceId": l.scope.DeviceID, "epoch": state["epoch"], "chainHead": state["chainHead"], "canManage": canManage, "devices": devices, "recoveryReadiness": state["recoveryReadiness"], "recoveryConfigured": state["recovery"] != nil, "checkedAt": state["checkedAt"], "identityMeaning": "device-control-only; no-professional-qualification-or-data-recovery"}, nil
}
func identityCheckControlReceipt(receipt, request map[string]any) error {
	if receipt["operationId"] != request["operationId"] || receipt["subjectId"] != request["subjectId"] || !isOne(text(receipt["state"]), "committed", "requested", "expired", "canceled") {
		return connectionFailure("device_management_receipt_invalid")
	}
	if receipt["state"] == "committed" && (!connectionSafeInteger(receipt["epoch"]) || integer(receipt["epoch"]) < 1 || !connectionHash.MatchString(text(receipt["chainHead"]))) {
		return connectionFailure("device_management_receipt_invalid")
	}
	return nil
}
func (d *NativeDeviceManagement) receipt(ctx context.Context, l *nativeIdentityLease, row map[string]any) (any, error) {
	saved, e := l.read(ctx, identityOperationKey(d.runtime.config.Endpoint, text(row["operationId"])))
	if e != nil {
		return nil, e
	}
	if saved == nil || saved["commit"] == nil {
		result := uploadObject(deviceReference(row))
		result["receipt"], result["registered"], result["submission"] = nil, false, "not-dispatched-by-this-client"
		return result, nil
	}
	receipt, e := l.call(ctx, "/v2/identity/control/status", saved["commit"], true)
	if e != nil {
		return nil, e
	}
	return d.recordReceipt(ctx, l, row, receipt)
}
func (d *NativeDeviceManagement) recordReceipt(ctx context.Context, l *nativeIdentityLease, row, receipt map[string]any) (any, error) {
	if e := identityCheckControlReceipt(receipt, uploadObject(row["request"])); e != nil {
		return nil, e
	}
	e := l.update(ctx, identityOperationKey(d.runtime.config.Endpoint, text(row["operationId"])), func(saved map[string]any) (map[string]any, error) {
		if saved == nil || !connectionEqual(saved["request"], row["request"]) {
			return nil, connectionFailure("device_management_pending_changed")
		}
		saved["receipt"], saved["state"] = receipt, receipt["state"]
		return saved, nil
	})
	if e != nil {
		return nil, e
	}
	e = l.update(ctx, d.journalKey(l.scope.Owner), func(journal map[string]any) (map[string]any, error) {
		journal = deviceJournal(journal)
		active := uploadObject(journal["active"])
		if active["operationId"] != row["operationId"] {
			return nil, connectionFailure("device_management_pending_changed")
		}
		active["state"], active["receipt"] = receipt["state"], receipt
		if identityTerminal(text(receipt["state"])) {
			history := []any{deviceReference(active)}
			for _, value := range uploadRows(journal["history"]) {
				if uploadObject(value)["operationId"] != row["operationId"] {
					history = append(history, value)
				}
			}
			journal["active"], journal["history"] = nil, history[:min(len(history), 50)]
		} else {
			journal["active"] = active
		}
		return journal, nil
	})
	if e != nil {
		return nil, e
	}
	result := uploadObject(deviceReference(row))
	result["state"], result["receipt"], result["acceptedOperationOnly"] = receipt["state"], receipt, receipt["state"] == "committed"
	return result, nil
}
func (d *NativeDeviceManagement) Read(ctx context.Context, action, operationID string) (any, error) {
	if !isOne(action, "current", "list", "pending", "reconcile") || action == "reconcile" && !controlUUID(operationID) {
		return nil, connectionFailure("device_management_native_input_invalid")
	}
	ctx, cancel, l, e := d.runtime.identityLease(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if isOne(action, "current", "list") {
		return d.current(ctx, l)
	}
	journal, e := l.read(ctx, d.journalKey(l.scope.Owner))
	if e != nil {
		return nil, e
	}
	journal = deviceJournal(journal)
	active := uploadObject(journal["active"])
	if action == "pending" {
		history := []any{}
		for _, row := range uploadRows(journal["history"]) {
			history = append(history, deviceReference(uploadObject(row)))
		}
		return map[string]any{"active": deviceReference(active), "history": history}, nil
	}
	if active["operationId"] == operationID {
		result, e := d.receipt(ctx, l, active)
		if e == nil && identityTerminal(text(uploadObject(uploadObject(result)["receipt"])["state"])) {
			d.release(operationID)
		}
		return result, e
	}
	for _, value := range uploadRows(journal["history"]) {
		row := uploadObject(value)
		if row["operationId"] == operationID {
			d.release(operationID)
			result := identityClone(row)
			result["acceptedOperationOnly"], result["recordedLocalReceipt"], result["currentAccessGranted"] = row["state"] == "committed", true, false
			return result, nil
		}
	}
	return nil, connectionFailure("device_management_operation_unavailable")
}

type nativeRevokeRequest struct {
	Version           int    `json:"version"`
	OperationID       string `json:"operationId"`
	SubjectID         string `json:"subjectId"`
	Kind              string `json:"kind"`
	ExpectedEpoch     int64  `json:"expectedEpoch"`
	PreviousEventHash string `json:"previousEventHash"`
	SignerKeyID       string `json:"signerKeyId"`
	DeviceID          string `json:"deviceId"`
}

func (d *NativeDeviceManagement) prepare(ctx context.Context, l *nativeIdentityLease, deviceID string) (map[string]any, error) {
	journal, e := l.read(ctx, d.journalKey(l.scope.Owner))
	if e != nil {
		return nil, e
	}
	journal = deviceJournal(journal)
	row := uploadObject(journal["active"])
	if row != nil && row["deviceId"] != deviceID {
		return nil, connectionFailure("device_management_pending_exists")
	}
	if row["stopped"] == true {
		return nil, connectionFailure("device_management_local_retry_stopped")
	}
	if row != nil {
		result, e := d.receipt(ctx, l, row)
		if e != nil {
			return nil, e
		}
		if identityTerminal(text(uploadObject(uploadObject(result)["receipt"])["state"])) {
			return nil, connectionFailure("device_management_operation_closed")
		}
		journal, e = l.read(ctx, d.journalKey(l.scope.Owner))
		if e != nil {
			return nil, e
		}
		row = uploadObject(journal["active"])
	}
	state, e := l.control(ctx)
	if e != nil {
		return nil, e
	}
	own := deviceManager(state, l.scope.DeviceID)
	target := deviceManager(state, deviceID)
	if !deviceCanManage(own) {
		return nil, connectionFailure("device_controller_not_authorized")
	}
	if target == nil {
		return nil, connectionFailure("identity_device_not_active")
	}
	if deviceID == l.scope.DeviceID && state["recovery"] == nil {
		other := false
		for _, value := range uploadRows(state["devices"]) {
			candidate := uploadObject(value)
			if candidate["device_id"] != deviceID && candidate["status"] == "active" && integer(candidate["epoch"]) == integer(state["epoch"]) && deviceCanManage(candidate) {
				other = true
			}
		}
		if !other {
			return nil, connectionFailure("identity_last_controller")
		}
	}
	var request map[string]any
	if row == nil {
		raw, _ := protocol.Encode(nativeRevokeRequest{2, uuid.NewString(), l.scope.Owner, "revoke-device", integer(state["epoch"]), text(state["chainHead"]), text(own["key_id"]), deviceID})
		request, _ = connectionObject(raw)
		row = map[string]any{"operationId": request["operationId"], "subjectId": l.scope.Owner, "deviceId": deviceID, "initiatorDeviceId": l.scope.DeviceID, "request": request, "requestHash": identity.Digest(raw), "state": "preparing", "stopped": false}
		e = l.update(ctx, d.journalKey(l.scope.Owner), func(j map[string]any) (map[string]any, error) {
			j = deviceJournal(j)
			if j["active"] != nil {
				return nil, connectionFailure("device_management_pending_exists")
			}
			j["active"] = row
			return j, nil
		})
		if e != nil {
			return nil, e
		}
	} else {
		request = uploadObject(row["request"])
	}
	if integer(request["expectedEpoch"]) != integer(state["epoch"]) || request["previousEventHash"] != state["chainHead"] || request["signerKeyId"] != own["key_id"] || row["initiatorDeviceId"] != l.scope.DeviceID {
		return nil, connectionFailure("device_management_control_changed")
	}
	operationKey := identityOperationKey(d.runtime.config.Endpoint, text(request["operationId"]))
	previous, e := l.read(ctx, operationKey)
	if e != nil {
		return nil, e
	}
	if previous != nil && !connectionEqual(previous["request"], request) {
		return nil, connectionFailure("device_management_pending_changed")
	}
	response, e := l.call(ctx, "/v2/identity/control/challenges", request, true)
	if e != nil {
		return nil, e
	}
	challengeRaw := text(response["challenge"])
	challenge, e := connectionObject([]byte(challengeRaw))
	if e != nil {
		return nil, e
	}
	nonce, decodeError := base64.RawURLEncoding.Strict().DecodeString(text(challenge["nonce"]))
	if !connectionExact(challenge, "version", "type", "audience", "request", "nonce", "expiresAt") || integer(challenge["version"]) != 2 || challenge["type"] != "identity-control" || challenge["audience"] != d.runtime.config.Endpoint || !connectionEqual(challenge["request"], request) || response["operationId"] != request["operationId"] || decodeError != nil || len(nonce) != 32 || !connectionSafeInteger(challenge["expiresAt"]) || integer(challenge["expiresAt"]) <= d.runtime.connection.now().Unix() || integer(challenge["expiresAt"]) > d.runtime.connection.now().Unix()+180 || !connectionEqual(response["expiresAt"], challenge["expiresAt"]) {
		return nil, connectionFailure("device_management_challenge_invalid")
	}
	if previous == nil {
		previous = map[string]any{"request": request, "challenge": challengeRaw, "expiresAt": challenge["expiresAt"], "state": "prepared"}
	} else if previous["challenge"] != challengeRaw {
		return nil, connectionFailure("device_management_pending_changed")
	}
	e = l.update(ctx, operationKey, func(current map[string]any) (map[string]any, error) {
		if current != nil && !connectionEqual(current, previous) {
			return nil, connectionFailure("device_management_pending_changed")
		}
		return previous, nil
	})
	if e != nil {
		return nil, e
	}
	challengeHash := identity.Digest([]byte(challengeRaw))
	e = l.update(ctx, d.journalKey(l.scope.Owner), func(j map[string]any) (map[string]any, error) {
		active := uploadObject(j["active"])
		if active["operationId"] != request["operationId"] {
			return nil, connectionFailure("device_management_pending_changed")
		}
		active["state"], active["challengeHash"], active["expiresAt"] = "prepared", challengeHash, challenge["expiresAt"]
		if previous["commit"] != nil {
			active["state"] = "requested"
		}
		j["active"] = active
		return j, nil
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"version": 1, "operationId": request["operationId"], "subjectId": l.scope.Owner, "endpoint": d.runtime.config.Endpoint, "kind": "revoke-device", "request": request, "requestHash": row["requestHash"], "challengeHash": challengeHash, "expiresAt": challenge["expiresAt"], "initiatorDeviceId": l.scope.DeviceID, "target": map[string]any{"deviceId": target["device_id"], "keyId": target["key_id"], "scopes": target["scopes"], "currentDevice": deviceID == l.scope.DeviceID}, "control": map[string]any{"deviceId": l.scope.DeviceID, "signerKeyId": own["key_id"], "epoch": state["epoch"], "chainHead": state["chainHead"]}, "effects": map[string]any{"deviceAccess": "revoked-on-this-authority", "existingBindings": "revoked-for-target-device", "existingCredentials": "revoked-for-target-device", "originalGuid": "preserved", "historicalProofs": "preserved", "recoveryCode": "not-consumed", "dataDeletion": "not-performed", "otherAuthorities": "not-asserted"}}, nil
}
func (d *NativeDeviceManagement) PrepareRevoke(ctx context.Context, deviceID string) (any, error) {
	if !controlUUID(deviceID) {
		return nil, connectionFailure("device_management_target_invalid")
	}
	ctx, cancel, l, e := d.runtime.identityLease(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	d.mu.Lock()
	now := d.runtime.connection.now().UnixMilli()
	for id, p := range d.previews {
		if p.state != "running" && (p.expiresAt <= now || p.state == "completed" || p.lease.scope != l.scope || p.lease.generation != l.generation || p.lease.connection.generation != l.connection.generation || p.lease.connection.bindingID != l.connection.bindingID) {
			delete(d.previews, id)
		}
	}
	if len(d.previews)+d.reserved >= 32 {
		d.mu.Unlock()
		return nil, connectionFailure("device_management_native_preview_capacity")
	}
	d.reserved++
	d.mu.Unlock()
	defer func() { d.mu.Lock(); d.reserved--; d.mu.Unlock() }()
	original, e := d.prepare(ctx, l, deviceID)
	if e != nil {
		return nil, e
	}
	expires := min(now+180000, integer(original["expiresAt"])*1000)
	if expires <= now {
		return nil, connectionFailure("device_management_native_preview_expired")
	}
	id := uuid.NewString()
	d.mu.Lock()
	d.previews[id] = &nativeDevicePreview{l, original, expires, "prepared"}
	d.mu.Unlock()
	return map[string]any{"previewId": id, "operationId": original["operationId"], "state": "prepared", "expiresAt": expires, "preview": identityClone(original), "signed": false, "challengeRegistered": true, "controlCommitted": false, "privateKeyExported": false}, nil
}
