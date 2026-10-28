package native

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

// NativeWatch preserves the existing foreground watch journal. Its pending
// records contain source locators and hashes, never a cached message body.
type NativeWatch struct {
	runtime    *Runtime
	instanceID string
}

func NewNativeWatch(r *Runtime) *NativeWatch {
	return &NativeWatch{runtime: r, instanceID: uuid.NewString()}
}
func nativeWatchKey(l *nativeIdentityLease) string {
	return "native-watch:" + l.scope.Endpoint + ":" + l.scope.Owner
}
func nativeWatchBinding(l *nativeIdentityLease) map[string]any {
	return map[string]any{"subjectId": l.scope.Owner, "endpoint": l.scope.Endpoint, "bindingId": l.connection.bindingID, "generation": l.connection.generation}
}
func (h *NativeWatch) now() int64 { return h.runtime.connection.now().Unix() }
func (h *NativeWatch) state(ctx context.Context, l *nativeIdentityLease, change func(map[string]any) error) (map[string]any, []string, error) {
	if e := l.check(ctx); e != nil {
		return nil, nil, e
	}
	var out map[string]any
	order := []string{}
	e := h.runtime.store.With(ctx, change != nil, func(dir string) error {
		if e := h.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		var raw json.RawMessage
		exists, e := readJSON(connectionRecordPath(dir, nativeWatchKey(l)), &raw)
		if e != nil {
			return e
		}
		out = map[string]any{"version": 1, "watches": map[string]any{}}
		if exists && string(raw) != "null" {
			if out, e = connectionObject(raw); e != nil {
				return e
			}
			ordered, e := protocol.DecodeOrdered(raw)
			if e != nil {
				return e
			}
			if root, ok := ordered.(*protocol.OrderedObject); ok {
				if watches, ok := root.Values()["watches"].(*protocol.OrderedObject); ok {
					order = watches.Keys()
				}
			}
		}
		watches := uploadObject(out["watches"])
		if watches == nil {
			return watchFailure("native_record_invalid")
		}
		if change == nil {
			return nil
		}
		if e = change(out); e != nil {
			return e
		}
		watches = uploadObject(out["watches"])
		if watches == nil {
			return watchFailure("native_record_invalid")
		}
		wire := protocol.NewOrderedObject()
		known := map[string]bool{}
		for _, id := range order {
			if row, ok := watches[id]; ok {
				wire.Set(id, row)
				known[id] = true
			}
		}
		added := []string{}
		for id := range watches {
			if !known[id] {
				added = append(added, id)
			}
		}
		sort.Strings(added)
		for _, id := range added {
			wire.Set(id, watches[id])
			order = append(order, id)
		}
		copy := identityClone(out)
		copy["watches"] = wire
		return uploadNativeRecordWithin(dir, nativeWatchKey(l), copy)
	})
	if e != nil {
		return nil, nil, e
	}
	return out, order, l.check(ctx)
}
func (h *NativeWatch) row(ctx context.Context, l *nativeIdentityLease, id string) (map[string]any, error) {
	state, _, e := h.state(ctx, l, nil)
	if e != nil {
		return nil, e
	}
	return uploadObject(uploadObject(state["watches"])[id]), nil
}
func (h *NativeWatch) Status(ctx context.Context, l *nativeIdentityLease, id string) (map[string]any, error) {
	state, order, e := h.state(ctx, l, nil)
	if e != nil {
		return nil, e
	}
	return h.projectStatus(state, order, id), nil
}
func (h *NativeWatch) projectStatus(state map[string]any, order []string, id string) map[string]any {
	rows := uploadObject(state["watches"])
	if id != "" {
		order = []string{id}
	}
	items := []any{}
	for _, id := range order {
		w := uploadObject(rows[id])
		if w == nil {
			continue
		}
		out := identityClone(w)
		delete(out, "lease")
		if out["state"] == "active" && integer(out["expiresAt"]) <= h.now() {
			out["state"] = "expired"
		}
		out["hostRuntimeState"] = "awaiting-host-check"
		lease := uploadObject(w["lease"])
		if lease["owner"] == h.instanceID && integer(lease["until"]) > h.now() {
			out["hostRuntimeState"] = "checking"
		}
		out["modelRunning"] = false
		items = append(items, out)
	}
	return map[string]any{"items": items, "scheduledBy": "user-host", "cloudModel": false, "continuesAfterHostExit": false}
}
func (h *NativeWatch) grant(ctx context.Context, l *nativeIdentityLease, room, id string) (map[string]any, error) {
	result, e := l.call(ctx, "/v2/chat/rooms/"+room+"/agent-grants", map[string]any{"grantId": id}, false)
	if e != nil {
		return nil, e
	}
	for _, v := range uploadRows(result["items"]) {
		g := uploadObject(v)
		if g["grantId"] == id && g["state"] == "active" {
			return g, nil
		}
	}
	return nil, nil
}
func (h *NativeWatch) StartReviewed(ctx context.Context, l *nativeIdentityLease, x map[string]any, scope *ChoiceScope) (map[string]any, error) {
	if scope == nil || *scope != l.scope {
		return nil, watchFailure("watch_choice_required")
	}
	expires, present := x["expiresAt"]
	if present && integer(expires) <= h.now() {
		return nil, watchFailure("watch_expired")
	}
	grant, e := h.grant(ctx, l, text(x["roomId"]), text(x["agentGrantId"]))
	if e != nil {
		return nil, e
	}
	if grant == nil {
		return nil, watchFailure("active_room_agent_grant_required")
	}
	if grant["bindingId"] != l.connection.bindingID {
		return nil, watchFailure("watch_current_binding_grant_required")
	}
	if !present {
		at := h.now() + 86400
		if at > integer(grant["expiresAt"]) {
			at = integer(grant["expiresAt"])
		}
		expires = at
	}
	if integer(expires) <= h.now() {
		return nil, watchFailure("watch_expired")
	}
	if integer(expires) > integer(grant["expiresAt"]) {
		return nil, watchFailure("watch_exceeds_agent_grant")
	}
	id := uuid.NewString()
	_, _, e = h.state(ctx, l, func(state map[string]any) error {
		watches := uploadObject(state["watches"])
		for _, v := range watches {
			w := uploadObject(v)
			if w["roomId"] == x["roomId"] && w["state"] == "active" && integer(w["expiresAt"]) > h.now() {
				return watchFailure("watch_already_active")
			}
		}
		row := identityClone(x)
		row["id"] = id
		row["expiresAt"] = expires
		row["bindingLease"] = nativeWatchBinding(l)
		row["state"] = "active"
		row["revision"] = 1
		row["after"] = "0"
		row["pending"] = nil
		row["failures"] = 0
		row["nextCheckAt"] = h.now()
		row["lease"] = nil
		watches[id] = row
		return nil
	})
	if e != nil {
		return nil, e
	}
	return h.Status(ctx, l, id)
}
func (h *NativeWatch) Halt(ctx context.Context, l *nativeIdentityLease, id, final, expectedGrant string) (map[string]any, error) {
	var target map[string]any
	_, _, e := h.state(ctx, l, func(state map[string]any) error {
		w := uploadObject(uploadObject(state["watches"])[id])
		if w == nil {
			return watchFailure("watch_missing")
		}
		if expectedGrant != "" && w["agentGrantId"] != expectedGrant {
			return watchFailure("watch_grant_changed")
		}
		pending := uploadObject(w["pending"])
		execution := uploadObject(pending["hostExecution"])
		if execution != nil {
			last := identityClone(execution)
			last["workId"] = pending["workId"]
			last["localRetryStopped"] = true
			w["lastHostExecution"] = last
			receipts := uploadObject(w["hostStopReceipts"])
			if receipts == nil {
				receipts = map[string]any{}
				w["hostStopReceipts"] = receipts
			}
			receipt := identityClone(last)
			receipt["agentGrantId"] = w["agentGrantId"]
			receipt["cancellation"] = map[string]any{"state": "unknown", "cancellationConfirmed": false, "executionEnded": false, "requestedAt": h.now()}
			receipts[text(pending["workId"])] = receipt
		}
		if w["state"] != final {
			w["state"] = final
			w["revision"] = integer(w["revision"]) + 1
		}
		w["lease"] = nil
		w["pending"] = nil
		target = uploadObject(w["stopAuthorization"])
		if target == nil {
			target = map[string]any{"state": "pending", "grantId": w["agentGrantId"], "roomId": w["roomId"]}
			w["stopAuthorization"] = target
		}
		target = identityClone(target)
		return nil
	})
	if e != nil {
		return nil, e
	}
	if target["state"] != "revoked" {
		receipt, requestError := l.call(ctx, "/v2/chat/rooms/"+text(target["roomId"])+"/agent-revoke", map[string]any{"grantId": target["grantId"]}, false)
		if requestError == nil && receipt["revoked"] == true {
			target["state"] = "revoked"
			target["confirmedAt"] = h.now()
		} else {
			target["state"] = "unconfirmed"
			target["lastAttemptAt"] = h.now()
		}
		_, _, e = h.state(ctx, l, func(state map[string]any) error {
			w := uploadObject(uploadObject(state["watches"])[id])
			if w != nil && isOne(text(w["state"]), "paused", "stopped", "expired") && w["agentGrantId"] == target["grantId"] && w["roomId"] == target["roomId"] {
				old := uploadObject(w["stopAuthorization"])
				if old["state"] != "revoked" {
					w["stopAuthorization"] = target
				}
				target = identityClone(w["stopAuthorization"])
			}
			return nil
		})
		if e != nil {
			return nil, e
		}
	}
	return map[string]any{"id": id, "state": final, "furtherGalaxyChecks": false, "externalModelCancellation": "host-must-confirm", "remoteGrantRevoked": target["state"] == "revoked", "authorizationState": target["state"], "retryStopRequired": target["state"] != "revoked"}, nil
}
func (h *NativeWatch) ResumeReviewed(ctx context.Context, l *nativeIdentityLease, x map[string]any, scope *ChoiceScope) (map[string]any, error) {
	if scope == nil || *scope != l.scope {
		return nil, watchFailure("watch_choice_required")
	}
	id := text(x["id"])
	previous, e := h.row(ctx, l, id)
	if e != nil {
		return nil, e
	}
	if previous == nil || previous["state"] != "paused" {
		return nil, watchFailure("watch_not_paused")
	}
	if uploadObject(previous["stopAuthorization"])["state"] != "revoked" {
		return nil, watchFailure("watch_revocation_unconfirmed")
	}
	if x["agentGrantId"] == previous["agentGrantId"] {
		return nil, watchFailure("watch_new_agent_grant_required")
	}
	if integer(x["expiresAt"]) <= h.now() {
		return nil, watchFailure("watch_expired")
	}
	grant, e := h.grant(ctx, l, text(previous["roomId"]), text(x["agentGrantId"]))
	if e != nil {
		return nil, e
	}
	if grant == nil || grant["bindingId"] != l.connection.bindingID || integer(x["expiresAt"]) > integer(grant["expiresAt"]) {
		return nil, watchFailure("watch_current_binding_grant_required")
	}
	_, _, e = h.state(ctx, l, func(state map[string]any) error {
		current := uploadObject(uploadObject(state["watches"])[id])
		if current == nil || current["state"] != "paused" || integer(current["revision"]) != integer(previous["revision"]) || current["agentGrantId"] != previous["agentGrantId"] || uploadObject(current["stopAuthorization"])["state"] != "revoked" {
			return watchFailure("watch_resume_changed")
		}
		current["agentGrantId"] = x["agentGrantId"]
		current["bindingLease"] = nativeWatchBinding(l)
		current["expiresAt"] = x["expiresAt"]
		current["state"] = "active"
		current["revision"] = integer(current["revision"]) + 1
		current["pending"] = nil
		current["failures"] = 0
		current["nextCheckAt"] = h.now()
		current["lease"] = nil
		delete(current, "stopAuthorization")
		return nil
	})
	if e != nil {
		return nil, e
	}
	return h.Status(ctx, l, id)
}
