package native

import (
	"context"
	"os"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type ConnectionSettingsPlan struct {
	GalaxyID            string   `json:"galaxyId"`
	Endpoint            string   `json:"endpoint"`
	DeviceID            string   `json:"deviceId"`
	Revision            int64    `json:"revision"`
	SelectionDigest     string   `json:"selectionDigest"`
	DeviceKeyID         string   `json:"deviceKeyId"`
	ControlEpoch        *int64   `json:"controlEpoch"`
	ControlVerification string   `json:"controlVerification"`
	Scopes              []string `json:"scopes"`
}

func runtimeRecordWithin(dir, endpoint string) (map[string]any, error) {
	var record map[string]any
	ok, e := readJSON(connectionRecordPath(dir, "native-selection:"+endpoint), &record)
	if e != nil || ok {
		return record, e
	}
	record = map[string]any{"version": 1, "revision": int64(0), "active": nil, "permission": nil}
	for part, prefix := range map[string]string{"active": "native-active:", "permission": "native-connection:"} {
		var value any
		if _, e = readJSON(connectionRecordPath(dir, prefix+endpoint), &value); e != nil {
			return nil, e
		}
		record[part] = value
	}
	return record, nil
}

// PrepareConnect reads existing local material only. Current remote control is
// verified during the subsequent reviewed handshake, never inferred from cache.
func (r *Runtime) PrepareConnect(ctx context.Context) (ConnectionSettingsPlan, error) {
	var plan ConnectionSettingsPlan
	lease, e := r.connection.lease(ctx, false)
	if e != nil {
		return plan, e
	}
	active := lease.selection.Active
	if active == nil {
		return plan, connectionFailure("native_identity_selection_required")
	}
	if !connectionSubject.MatchString(active.SubjectID) || !controlUUID(active.DeviceID) || !controlUUID(active.InstallationID) || !connectionGenesis(active.SubjectID, active.GenesisProof) {
		return plan, connectionFailure("native_identity_selection_invalid")
	}
	_, public, e := r.connection.deviceKey(ctx, lease)
	if e != nil {
		return plan, e
	}
	key := identity.Digest([]byte(public))
	plan = ConnectionSettingsPlan{GalaxyID: active.SubjectID, Endpoint: r.config.Endpoint, DeviceID: active.DeviceID, Revision: lease.selection.Revision, SelectionDigest: lease.selection.fingerprint, DeviceKeyID: key, ControlVerification: "checked-during-connect", Scopes: append([]string{}, connectionBrowserScopes...)}
	var state map[string]any
	hasCache := false
	e = r.store.With(ctx, false, func(dir string) error {
		selected, e := r.connection.selectionWithin(dir)
		if e != nil {
			return e
		}
		if selected.fingerprint != lease.selection.fingerprint {
			return connectionFailure("native_connection_selection_changed")
		}
		ok, e := readJSON(connectionRecordPath(dir, "native-trust-identity:"+r.config.Endpoint+":"+active.SubjectID), &state)
		if e != nil {
			return e
		}
		if !ok {
			return nil
		}
		hasCache = true
		return nil
	})
	if e != nil {
		return plan, e
	}
	if !hasCache {
		return plan, nil
	}
	if state["subjectId"] != active.SubjectID || state["authority"] != r.config.Endpoint {
		return plan, connectionFailure("trust_identity_authority_changed")
	}
	control, e := verifyConnectionControl(state)
	if e != nil {
		return plan, e
	}
	if control.Epoch == 0 {
		return plan, connectionFailure("native_identity_bootstrap_not_migrated")
	}
	device, ok := control.Devices[key]
	if !ok || device.DeviceID != active.DeviceID || device.Epoch != control.Epoch {
		return plan, connectionFailure("current_device_control_required")
	}
	scopes := []string{}
	for _, scope := range connectionBrowserScopes {
		if connectionIncludes(device.Scopes, scope) || connectionIncludes(device.Scopes, "*") {
			scopes = append(scopes, scope)
		}
	}
	if !connectionIncludes(scopes, "binding") {
		return plan, connectionFailure("native_connection_choice_required")
	}
	plan.ControlEpoch = &control.Epoch
	plan.ControlVerification = "cached-history-only"
	plan.Scopes = scopes
	return plan, nil
}
func (r *Runtime) ConnectReviewed(ctx context.Context, plan ConnectionSettingsPlan, scope *ChoiceScope) (*ConnectionSnapshot, error) {
	r.connectMu.Lock()
	defer r.connectMu.Unlock()
	if scope == nil || scope.Owner != plan.GalaxyID || scope.Endpoint != plan.Endpoint || scope.DeviceID != plan.DeviceID || scope.Revision != plan.Revision || plan.Endpoint != r.config.Endpoint || !connectionIncludes(plan.Scopes, "binding") {
		return nil, connectionFailure("native_connection_choice_required")
	}
	seen := map[string]bool{}
	for _, value := range plan.Scopes {
		if !connectionIncludes(connectionBrowserScopes, value) || seen[value] {
			return nil, connectionFailure("native_connection_choice_required")
		}
		seen[value] = true
	}
	selected, e := r.connection.selection(ctx)
	if e != nil {
		return nil, e
	}
	if selected.fingerprint != plan.SelectionDigest || selected.Active == nil || selected.Active.SubjectID != plan.GalaxyID || selected.Active.DeviceID != plan.DeviceID {
		return nil, connectionFailure("native_connection_selection_changed")
	}
	r.mu.Lock()
	r.connecting = true
	r.mu.Unlock()
	if r.privateSync != nil {
		r.privateSync.Pause()
	}
	connected := false
	defer func() {
		r.mu.Lock()
		r.connecting = false
		r.mu.Unlock()
		if connected {
			r.ResumePrivateSync(0)
		}
	}()
	operation, cancel, generation, e := r.operation(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	approved := &connectionPermission{Enabled: true, SubjectID: plan.GalaxyID, DeviceID: plan.DeviceID, Scopes: append([]string{}, plan.Scopes...)}
	snapshot, e := r.connection.connectWithPermission(operation, approved)
	if e != nil {
		return nil, e
	}
	r.connection.mu.Lock()
	session := r.connection.session
	r.connection.mu.Unlock()
	discard := func() {
		r.connection.mu.Lock()
		if r.connection.session == session {
			r.connection.session = nil
			r.connection.generation++
		}
		r.connection.mu.Unlock()
	}
	if e = r.checkOperation(generation); e != nil {
		discard()
		return nil, e
	}
	e = r.store.With(operation, true, func(dir string) error {
		if e := r.store.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		current, e := r.connection.selectionWithin(dir)
		if e != nil {
			return e
		}
		if current.fingerprint != plan.SelectionDigest {
			return connectionFailure("native_connection_selection_changed")
		}
		record, e := runtimeRecordWithin(dir, r.config.Endpoint)
		if e != nil {
			return e
		}
		if current.Revision >= 9007199254740991 {
			return connectionFailure("native_selection_invalid")
		}
		if e = r.checkOperation(generation); e != nil {
			return e
		}
		r.connection.mu.Lock()
		defer r.connection.mu.Unlock()
		if r.connection.closed || r.connection.session != session || session == nil || snapshot == nil || session.snapshot.Generation != snapshot.Generation {
			return connectionFailure("native_connection_selection_changed")
		}
		permission := map[string]any{"enabled": true, "subjectId": plan.GalaxyID, "deviceId": plan.DeviceID, "scopes": snapshot.Scopes, "selectedAt": r.connection.now().Unix()}
		next := map[string]any{"version": 1, "revision": current.Revision + 1, "active": record["active"], "permission": permission}
		raw, e := protocol.Encode(next)
		if e != nil {
			return e
		}
		path := connectionRecordPath(dir, "native-selection:"+r.config.Endpoint)
		if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
			return e
		}
		if e = writeJSON(path, next); e != nil {
			return e
		}
		r.connection.fingerprint = identity.Digest(raw)
		return nil
	})
	if e != nil {
		discard()
		return nil, e
	}
	r.mu.Lock()
	if r.generation != generation || r.closed {
		r.mu.Unlock()
		discard()
		return nil, connectionFailure("native_connection_selection_changed")
	}
	r.stopped = false
	r.stopFingerprint = ""
	r.mu.Unlock()
	connected = true
	return r.connection.Snapshot(ctx)
}

// Disconnect is local connection withdrawal, not remote binding/device revocation.
// Existing active fields and legacy files are preserved; selection is CAS-written.
func (r *Runtime) Disconnect(ctx context.Context) (map[string]any, error) {
	if e := r.disableNotifications(ctx); e != nil {
		return nil, e
	}
	selected, e := r.connection.selection(ctx)
	if e != nil {
		return nil, e
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, connectionFailure("native_runtime_closed")
	}
	r.stopped = true
	r.stopFingerprint = selected.fingerprint
	r.rotateLocked()
	generation := r.generation
	r.mu.Unlock()
	if r.privateSync != nil {
		r.privateSync.Pause()
	}
	r.connection.Disconnect()
	var fingerprint string
	e = r.store.With(ctx, true, func(dir string) error {
		current, e := r.connection.selectionWithin(dir)
		if e != nil {
			return e
		}
		if current.fingerprint != selected.fingerprint {
			return connectionFailure("native_connection_selection_changed")
		}
		if current.Revision >= 9007199254740991 {
			return connectionFailure("native_selection_invalid")
		}
		record, e := runtimeRecordWithin(dir, r.config.Endpoint)
		if e != nil {
			return e
		}
		if e = r.checkOperation(generation); e != nil {
			return e
		}
		next := map[string]any{"version": 1, "revision": current.Revision + 1, "active": record["active"], "permission": map[string]any{"enabled": false}}
		raw, e := protocol.Encode(next)
		if e != nil {
			return e
		}
		path := connectionRecordPath(dir, "native-selection:"+r.config.Endpoint)
		if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
			return e
		}
		if e = writeJSON(path, next); e != nil {
			return e
		}
		fingerprint = identity.Digest(raw)
		return nil
	})
	if e != nil {
		return nil, e
	}
	r.mu.Lock()
	if r.generation == generation {
		r.stopFingerprint = fingerprint
	}
	r.mu.Unlock()
	return map[string]any{"connected": false, "remoteBindingRevoked": false}, nil
}
