package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/watchcontrol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// NativeWatchControl carries the original local handoff journal. Registering
// metadata neither starts a host scheduler nor proves an external process stop.
type NativeWatchControl struct{ runtime *Runtime }

func NewNativeWatchControl(runtime *Runtime) *NativeWatchControl { return &NativeWatchControl{runtime} }

type nativeWatchHandoff struct {
	lease           *nativeIdentityLease
	key, pendingKey string
}

func watchObject(v any) map[string]any {
	if o, ok := v.(*protocol.OrderedObject); ok {
		return o.Values()
	}
	return psObject(v)
}
func watchFailure(code string) error     { return fault.New(code, 409) }
func (h *nativeWatchHandoff) now() int64 { return h.lease.runtime.connection.now().Unix() }
func (h *nativeWatchHandoff) read(ctx context.Context) (map[string]any, error) {
	state, e := h.lease.read(ctx, h.key)
	if e != nil {
		return nil, e
	}
	if state == nil {
		state = map[string]any{"version": 1, "watches": map[string]any{}}
	}
	return state, nil
}

// Keep Object.values' persisted operation order, including original Node
// records. Request inputs also retain the original schema order for hashing.
func (h *nativeWatchHandoff) journal(ctx context.Context, change func(*protocol.OrderedObject) error) (*protocol.OrderedObject, error) {
	l := h.lease
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var out *protocol.OrderedObject
	e := l.runtime.store.With(ctx, change != nil, func(dir string) error {
		if e := l.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		var raw json.RawMessage
		exists, e := readJSON(connectionRecordPath(dir, h.pendingKey), &raw)
		if e != nil {
			return e
		}
		out = protocol.NewOrderedObject()
		if exists && string(raw) != "null" {
			value, e := protocol.DecodeOrdered(raw)
			if e != nil {
				return e
			}
			var ok bool
			out, ok = value.(*protocol.OrderedObject)
			if !ok {
				return watchFailure("native_record_invalid")
			}
		}
		if change != nil {
			if e := change(out); e != nil {
				return e
			}
			return uploadNativeRecordWithin(dir, h.pendingKey, out)
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	return out, l.check(ctx)
}
func (h *nativeWatchHandoff) conflict(state map[string]any, id, room string) bool {
	for _, v := range watchObject(state["watches"]) {
		other := watchObject(v)
		if text(other["id"]) != id && text(other["roomId"]) == room && other["state"] == "active" && psInt(other["expiresAt"]) > h.now() {
			return true
		}
	}
	return false
}
func (h *nativeWatchHandoff) adopt(ctx context.Context, response map[string]any, kind string) error {
	w := watchObject(response["watch"])
	if w == nil || text(w["subjectId"]) != h.lease.scope.Owner {
		return watchFailure("watch_control_receipt_invalid")
	}
	return h.lease.update(ctx, h.key, func(state map[string]any) (map[string]any, error) {
		if state == nil {
			state = map[string]any{"version": 1, "watches": map[string]any{}}
		}
		watches := watchObject(state["watches"])
		if watches == nil {
			return nil, watchFailure("native_record_invalid")
		}
		id := text(w["watchId"])
		local := watchObject(watches[id])
		if kind == "stop" {
			receipt := watchObject(response["receipt"])
			if local != nil && local["agentGrantId"] == receipt["agentGrantId"] {
				local["state"] = "stopped"
				local["pending"] = nil
				local["lease"] = nil
				local["revision"] = psInt(local["revision"]) + 1
				local["stopAuthorization"] = map[string]any{"state": "revoked", "roomId": local["roomId"], "grantId": local["agentGrantId"], "confirmedAt": h.now()}
			}
			return state, nil
		}
		if w["state"] != "active" || text(w["bindingId"]) != h.lease.connection.bindingID {
			if local != nil {
				local["state"] = w["state"]
				if text(w["bindingId"]) != h.lease.connection.bindingID {
					local["state"] = "superseded"
				}
				local["lease"] = nil
				local["pending"] = nil
			}
			return state, nil
		}
		if local != nil && local["agentGrantId"] == w["agentGrantId"] && (kind == "register" || local["state"] == "stopped") {
			local["cloudControl"] = map[string]any{"revision": w["revision"]}
			return state, nil
		}
		if h.conflict(state, id, text(w["roomId"])) {
			return nil, watchFailure("watch_local_room_conflict")
		}
		next := map[string]any{"id": w["watchId"], "roomId": w["roomId"], "agentGrantId": w["agentGrantId"], "purpose": w["purpose"], "expiresAt": w["expiresAt"], "state": "active", "revision": psInt(local["revision"]) + 1, "after": w["lastCursor"], "pending": nil, "failures": 0, "nextCheckAt": h.now(), "lease": nil, "cloudControl": map[string]any{"revision": w["revision"]}}
		if text(w["taskId"]) != "" {
			next["taskId"] = w["taskId"]
		}
		watches[id] = next
		return state, nil
	})
}
func (h *nativeWatchHandoff) recorded(ctx context.Context, id string) error {
	_, e := h.journal(ctx, func(j *protocol.OrderedObject) error {
		p := watchObject(j.Values()[id])
		if p == nil {
			return watchFailure("watch_operation_missing")
		}
		p["state"] = "recorded"
		j.Set(id, p)
		return nil
	})
	return e
}
func (h *nativeWatchHandoff) send(ctx context.Context, kind string, input any, confirmed bool) (map[string]any, error) {
	raw, e := jstext.EncodeJSON(input)
	if e != nil {
		return nil, e
	}
	ordered, e := watchcontrol.ParseRequest(raw, kind)
	if e != nil {
		return nil, remoteFactsInvalid()
	}
	x := ordered.Values()
	raw, e = protocol.EncodeJS(ordered)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(raw)
	id := text(x["operationId"])
	journal, e := h.journal(ctx, nil)
	if e != nil {
		return nil, e
	}
	existing := watchObject(journal.Values()[id])
	if existing != nil && (existing["kind"] != kind || existing["requestHash"] != hash) {
		return nil, watchFailure("watch_operation_changed")
	}
	if existing == nil && !confirmed && kind != "stop" {
		return nil, watchFailure("watch_choice_required")
	}
	if kind == "register" && existing == nil {
		state, e := h.read(ctx)
		if e != nil {
			return nil, e
		}
		local := watchObject(watchObject(state["watches"])[text(x["watchId"])])
		if local == nil || local["state"] != "active" || local["roomId"] != x["roomId"] || local["agentGrantId"] != x["agentGrantId"] || local["purpose"] != x["purpose"] || psInt(local["expiresAt"]) != psInt(x["expiresAt"]) || text(local["taskId"]) != text(x["taskId"]) {
			return nil, watchFailure("watch_local_scope_changed")
		}
	}
	if kind == "takeover" && existing == nil {
		if text(x["targetBindingId"]) != h.lease.connection.bindingID {
			return nil, watchFailure("watch_target_device_required")
		}
		response, e := h.lease.call(ctx, "/v2/watch-controls/read", map[string]any{"watchId": x["watchId"]}, false)
		if e != nil {
			return nil, e
		}
		state, e := h.read(ctx)
		if e != nil {
			return nil, e
		}
		if h.conflict(state, text(x["watchId"]), text(watchObject(response["watch"])["roomId"])) {
			return nil, watchFailure("watch_local_room_conflict")
		}
	}
	_, e = h.journal(ctx, func(j *protocol.OrderedObject) error {
		current := watchObject(j.Values()[id])
		if current != nil {
			if current["kind"] != kind || current["requestHash"] != hash {
				return watchFailure("watch_operation_changed")
			}
			return nil
		}
		j.Set(id, map[string]any{"kind": kind, "input": ordered, "requestHash": hash, "state": "pending"})
		return nil
	})
	if e != nil {
		return nil, e
	}
	response, e := h.lease.call(ctx, "/v2/watch-controls/"+kind, ordered, false)
	if e != nil {
		return nil, e
	}
	if response["operationId"] != id || response["requestHash"] != hash || response["state"] != "recorded" {
		return nil, watchFailure("watch_control_receipt_invalid")
	}
	if e = h.adopt(ctx, response, kind); e != nil {
		return nil, e
	}
	return response, h.recorded(ctx, id)
}
func (h *nativeWatchHandoff) reconcile(ctx context.Context, id string, retry bool) (map[string]any, error) {
	j, e := h.journal(ctx, nil)
	if e != nil {
		return nil, e
	}
	p := watchObject(j.Values()[id])
	if p == nil {
		return nil, watchFailure("watch_operation_missing")
	}
	response, e := h.lease.call(ctx, "/v2/watch-controls/receipt", map[string]any{"operationId": id, "requestHash": p["requestHash"]}, false)
	if e != nil {
		return nil, e
	}
	if response["state"] == "absent" {
		if retry {
			return h.send(ctx, text(p["kind"]), p["input"], true)
		}
		return map[string]any{"operationId": id, "state": "unconfirmed", "retryOriginalOperation": true}, nil
	}
	if response["operationId"] != id || response["requestHash"] != p["requestHash"] || response["state"] != "recorded" {
		return nil, watchFailure("watch_control_receipt_invalid")
	}
	if e = h.adopt(ctx, response, text(p["kind"])); e != nil {
		return nil, e
	}
	return response, h.recorded(ctx, id)
}
func (c *NativeWatchControl) Call(ctx context.Context, name string, input any, expected *ChoiceScope) (any, error) {
	if c == nil || c.runtime == nil {
		return nil, fault.New("native_runtime_unavailable", 503)
	}
	value, e := remoteSelectedInput(remoteSelectedContracts(remoteWatchContractsJSON), name, input)
	if e != nil {
		return nil, e
	}
	ctx, cancel, l, e := c.runtime.identityLease(ctx, name != "galaxy_watch_control_pending")
	if e != nil {
		return nil, e
	}
	defer cancel()
	if expected != nil && l.scope != *expected {
		return nil, watchFailure("native_choice_binding_changed")
	}
	prefix := c.runtime.store.Endpoint + ":" + l.scope.Owner
	h := &nativeWatchHandoff{l, "native-watch:" + prefix, "native-watch-handoffs:" + prefix}
	switch name {
	case "galaxy_watch_control_enable":
		return h.send(ctx, "register", value, expected != nil)
	case "galaxy_watch_control_takeover":
		return h.send(ctx, "takeover", value, expected != nil)
	case "galaxy_watch_control_stop":
		return h.send(ctx, "stop", value, false)
	case "galaxy_watch_control_read":
		return l.call(ctx, "/v2/watch-controls/read", value, false)
	case "galaxy_watch_control_query":
		return l.call(ctx, "/v2/watch-controls/query", value, false)
	case "galaxy_watch_control_reconcile":
		return h.reconcile(ctx, text(value["operationId"]), value["retry"] == true)
	case "galaxy_watch_control_pending":
		j, e := h.journal(ctx, nil)
		if e != nil {
			return nil, e
		}
		out := []any{}
		for _, id := range j.Keys() {
			p := watchObject(j.Values()[id])
			if p["state"] == "pending" {
				x := watchObject(p["input"])
				out = append(out, map[string]any{"operationId": x["operationId"], "watchId": x["watchId"], "kind": p["kind"], "requestHash": p["requestHash"]})
			}
		}
		return out, nil
	}
	return nil, remoteFactsInvalid()
}
func registerRemoteWatchTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeWatchControl(runtime)
	registerSelectedRemoteTools(server, tools, remoteSelectedContracts(remoteWatchContractsJSON), func(ctx context.Context, name string, input any, expected *ChoiceScope) (any, error) {
		return client.Call(ctx, name, input, expected)
	})
}
