package native

import (
	"context"
	"encoding/json"
)

type RuntimeStatusOptions struct{ RestoreSelected bool }

// Status preserves the original Native projection. Restoration is optional and
// reports its actual failure without manufacturing an initialized/connected state.
func (r *Runtime) Status(ctx context.Context, options RuntimeStatusOptions) (map[string]any, error) {
	selected, e := r.connection.selection(ctx)
	if e != nil {
		return nil, e
	}
	r.syncStopped(selected)
	connectionError := ""
	if options.RestoreSelected && selected.Permission != nil && selected.Permission.Enabled {
		if _, e = r.Restore(ctx); e != nil {
			connectionError = runtimeErrorCode(e)
		}
	}
	selected, e = r.connection.selection(ctx)
	if e != nil {
		return nil, e
	}
	snapshot, e := r.connection.Snapshot(ctx)
	if e != nil {
		return nil, e
	}
	var out map[string]any
	var fingerprint string
	e = r.store.With(ctx, false, func(dir string) error {
		current, e := r.connection.selectionWithin(dir)
		if e != nil {
			return e
		}
		fingerprint = current.fingerprint
		if current.fingerprint != selected.fingerprint || snapshot != nil && (current.Active == nil || snapshot.SubjectID != current.Active.SubjectID) {
			return connectionFailure("native_connection_selection_changed")
		}
		var local, state map[string]any
		if e = readFallback(dir, "galaxy-id.json", "node.json", &local); e != nil {
			return e
		}
		if e = readFallback(dir, "galaxy-local-state.json", "local-state.json", &state); e != nil {
			return e
		}
		var owner, device, subjectType, clientKind any
		owner = local["id"]
		subjectType = local["subjectType"]
		clientKind = local["clientKind"]
		initialized := false
		integration, _ := state["integration"].(map[string]any)
		if integration != nil {
			_, initialized = integration["modules"].([]any)
		}
		if current.Active != nil {
			owner = current.Active.SubjectID
			device = current.Active.DeviceID
			if current.Active.SubjectID != text(local["id"]) {
				subjectType = nil
				clientKind = nil
				var modules any
				ok, e := readJSON(connectionRecordPath(dir, "native-modules:"+r.config.Endpoint+":"+current.Active.SubjectID), &modules)
				if e != nil {
					return e
				}
				initialized = ok && runtimeTruthy(modules)
			}
		}
		var selectedOwner any
		if current.Active != nil {
			selectedOwner = current.Active.SubjectID
		}
		enabled := current.Permission != nil && current.Permission.Enabled
		out = map[string]any{"version": 2, "endpoint": r.config.Endpoint, "website": r.config.Website, "identity": owner, "subjectType": subjectType, "clientKind": clientKind, "connected": snapshot != nil, "connection": snapshot, "connectionChoice": map[string]any{"revision": current.Revision, "enabled": enabled, "subjectId": selectedOwner, "deviceId": device}, "localInitialized": initialized, "modelService": "user-host", "backgroundModel": "not-started", "embeddedUi": "unverified", "activeEntries": []string{"match", "publish", "participate"}, "helpPaths": []string{"continue-current-ai", "capsule-or-history", "open-assistance", "bounty-or-expert"}}
		if connectionError != "" {
			out["connectionError"] = connectionError
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	latest, e := r.connection.selection(ctx)
	if e != nil {
		return nil, e
	}
	if latest.fingerprint != fingerprint {
		return nil, connectionFailure("native_connection_selection_changed")
	}
	finalSnapshot, e := r.connection.Snapshot(ctx)
	if e != nil {
		return nil, e
	}
	if (snapshot == nil) != (finalSnapshot == nil) || snapshot != nil && snapshot.Generation != finalSnapshot.Generation {
		return nil, connectionFailure("native_connection_selection_changed")
	}
	r.mu.Lock()
	closed, stopped, connecting := r.closed, r.stopped, r.connecting
	r.mu.Unlock()
	if closed {
		return nil, connectionFailure("native_runtime_closed")
	}
	if stopped || connecting {
		out["connected"] = false
		out["connection"] = nil
	}
	return out, nil
}
func runtimeTruthy(v any) bool {
	switch value := v.(type) {
	case nil:
		return false
	case bool:
		return value
	case string:
		return value != ""
	case json.Number:
		n, e := value.Float64()
		return e == nil && n != 0
	}
	return true
}
