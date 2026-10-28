package native

import (
	"context"
	"encoding/json"
	"math/big"
	"regexp"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

var nativeWatchCursor = regexp.MustCompile(`^[0-9]+$`)

func watchSequenceWithin(value any, upper string) bool {
	raw := text(value)
	if !nativeWatchCursor.MatchString(raw) || !nativeWatchCursor.MatchString(upper) {
		return false
	}
	n, ok := new(big.Int).SetString(raw, 10)
	if !ok {
		return false
	}
	limit, ok := new(big.Int).SetString(upper, 10)
	return ok && n.Cmp(limit) <= 0
}
func nativeWatchHash(items []any) string {
	raw, _ := protocol.EncodeJS(items)
	return identity.Digest(raw)
}
func (h *NativeWatch) messages(ctx context.Context, l *nativeIdentityLease, w map[string]any, after string) (map[string]any, []any, error) {
	var raw json.RawMessage
	if e := l.check(ctx); e != nil {
		return nil, nil, e
	}
	page, e := h.runtime.Call(ctx, "/v2/chat/rooms/"+text(w["roomId"])+"/history", map[string]any{"after": after, "limit": 50, "agentGrantId": w["agentGrantId"]}, ConnectionCallOptions{ExpectedScope: &l.scope, ResponseJSON: &raw})
	if e != nil {
		return nil, nil, e
	}
	if e = l.check(ctx); e != nil {
		return nil, nil, e
	}
	ordered, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, nil, e
	}
	wire, ok := ordered.(*protocol.OrderedObject)
	if !ok {
		return nil, nil, watchFailure("chat_history_response_invalid")
	}
	messages, ok := wire.Values()["messages"].([]any)
	if !ok || !nativeWatchCursor.MatchString(text(page["scannedThrough"])) {
		return nil, nil, watchFailure("chat_history_response_invalid")
	}
	return page, messages, nil
}
func nativeWatchItems(messages []any, owner string, w, pending map[string]any) []any {
	items := []any{}
	for _, v := range messages {
		m := watchObject(v)
		_, hasText := m["text"].(string)
		if m["subjectId"] != owner && m["agentGrantId"] != w["agentGrantId"] && m["state"] == "accepted" && hasText && (pending == nil || watchSequenceWithin(m["sequence"], text(pending["next"]))) {
			items = append(items, v)
		}
	}
	return items
}
func (h *NativeWatch) Check(ctx context.Context, l *nativeIdentityLease, id string, force, host bool) (out map[string]any, err error) {
	var captured map[string]any
	_, _, err = h.state(ctx, l, func(state map[string]any) error {
		w := uploadObject(uploadObject(state["watches"])[id])
		if w == nil {
			return watchFailure("watch_missing")
		}
		capture := func(v string) { captured = map[string]any{"state": v} }
		if w["state"] != "active" || integer(w["expiresAt"]) <= h.now() {
			capture("inactive")
			return nil
		}
		lease := uploadObject(w["lease"])
		if lease != nil && integer(lease["until"]) > h.now() {
			capture("leased-elsewhere")
			if lease["owner"] == h.instanceID {
				capture("already-checking")
			}
			return nil
		}
		pending := uploadObject(w["pending"])
		if execution := uploadObject(pending["hostExecution"]); execution != nil {
			capture("host-result-pending")
			if execution["state"] == "completed" {
				capture("work-completed-pending-ack")
			}
			captured["workId"] = pending["workId"]
			captured["hostExecution"] = execution
			captured["nextCheckAt"] = w["nextCheckAt"]
			return nil
		}
		if pending != nil && pending["owner"] == h.instanceID && !host {
			capture("work-pending")
			captured["workId"] = pending["workId"]
			captured["nextCheckAt"] = w["nextCheckAt"]
			return nil
		}
		if !force && integer(w["nextCheckAt"]) > h.now() && pending == nil {
			capture("not-due")
			captured["nextCheckAt"] = w["nextCheckAt"]
			return nil
		}
		w["lease"] = map[string]any{"owner": h.instanceID, "until": h.now() + 120}
		captured = map[string]any{"state": "fetch", "watch": identityClone(w)}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if captured["state"] != "fetch" {
		captured["modelCalls"] = 0
		return captured, nil
	}
	w := uploadObject(captured["watch"])
	defer func() {
		if err != nil {
			_, _, _ = h.state(ctx, l, func(state map[string]any) error {
				current := uploadObject(uploadObject(state["watches"])[id])
				if current != nil && current["state"] == "active" && integer(current["revision"]) == integer(w["revision"]) {
					current["lease"] = nil
					failures := integer(current["failures"]) + 1
					current["failures"] = failures
					exponent := failures - 1
					if exponent > 5 {
						exponent = 5
					}
					delay := int64(60) << exponent
					if delay > 1800 {
						delay = 1800
					}
					current["nextCheckAt"] = h.now() + delay
				}
				return nil
			})
		}
	}()
	grant, e := h.grant(ctx, l, text(w["roomId"]), text(w["agentGrantId"]))
	if e != nil {
		return nil, e
	}
	if grant == nil {
		if _, e = h.Halt(ctx, l, id, "stopped", text(w["agentGrantId"])); e != nil {
			return nil, e
		}
		return map[string]any{"state": "grant-unavailable", "modelCalls": 0}, nil
	}
	binding := uploadObject(w["bindingLease"])
	if grant["bindingId"] != l.connection.bindingID || binding != nil && !connectionEqual(binding, nativeWatchBinding(l)) {
		if _, e = h.Halt(ctx, l, id, "stopped", text(w["agentGrantId"])); e != nil {
			return nil, e
		}
		return map[string]any{"state": "binding-changed", "modelCalls": 0, "newGrantRequiresUserChoice": true}, nil
	}
	if task := text(w["taskId"]); task != "" {
		value, e := l.call(ctx, "/v2/tasks/"+task, nil, false)
		if e != nil {
			return nil, e
		}
		if isOne(text(value["state"]), "closed", "canceled") {
			if _, e = h.Halt(ctx, l, id, "stopped", text(w["agentGrantId"])); e != nil {
				return nil, e
			}
			return map[string]any{"state": "task-ended", "modelCalls": 0}, nil
		}
	}
	page, messages, e := h.messages(ctx, l, w, text(w["after"]))
	if e != nil {
		return nil, e
	}
	pending := uploadObject(w["pending"])
	items := nativeWatchItems(messages, l.scope.Owner, w, pending)
	hash := nativeWatchHash(items)
	if host && pending != nil && (text(pending["sourceHash"]) == "" || pending["sourceHash"] != hash) {
		return nil, watchFailure("watch_source_changed")
	}
	workID := text(pending["workId"])
	if workID == "" {
		workID = uuid.NewString()
	}
	next := page["scannedThrough"]
	if pending != nil {
		next = pending["next"]
	}
	work := map[string]any{"workId": workID, "roomId": w["roomId"], "items": items, "next": next, "complete": page["complete"]}
	accepted := false
	_, _, e = h.state(ctx, l, func(state map[string]any) error {
		current := uploadObject(uploadObject(state["watches"])[id])
		if current == nil || current["state"] != "active" || integer(current["revision"]) != integer(w["revision"]) || uploadObject(current["lease"])["owner"] != h.instanceID {
			return nil
		}
		current["failures"] = 0
		current["nextCheckAt"] = h.now() + 900
		if page["next"] != nil {
			current["nextCheckAt"] = h.now()
		}
		current["lease"] = nil
		if len(items) > 0 {
			current["pending"] = map[string]any{"workId": workID, "next": next, "owner": h.instanceID, "sourceHash": hash, "after": w["after"]}
		} else {
			current["after"] = page["scannedThrough"]
			current["pending"] = nil
		}
		accepted = true
		return nil
	})
	if e != nil {
		return nil, e
	}
	if !accepted {
		return map[string]any{"state": "stopped-during-check", "modelCalls": 0}, nil
	}
	out = map[string]any{"state": "unchanged", "modelCalls": 0, "invokeUserAgent": false}
	if len(items) > 0 {
		out["state"] = "work-ready"
		out["work"] = work
		out["invokeUserAgent"] = true
	}
	return out, nil
}
func (h *NativeWatch) VerifyHostWork(ctx context.Context, l *nativeIdentityLease, id, workID string) (map[string]any, error) {
	w, e := h.row(ctx, l, id)
	if e != nil {
		return nil, e
	}
	pending := uploadObject(w["pending"])
	if w == nil || w["state"] != "active" || integer(w["expiresAt"]) <= h.now() || pending["workId"] != workID || text(pending["sourceHash"]) == "" {
		return nil, watchFailure("watch_work_changed")
	}
	grant, e := h.grant(ctx, l, text(w["roomId"]), text(w["agentGrantId"]))
	if e != nil {
		return nil, e
	}
	if grant == nil || grant["bindingId"] != l.connection.bindingID {
		return nil, watchFailure("watch_current_binding_grant_required")
	}
	if task := text(w["taskId"]); task != "" {
		value, e := l.call(ctx, "/v2/tasks/"+task, nil, false)
		if e != nil {
			return nil, e
		}
		if isOne(text(value["state"]), "closed", "canceled") {
			return nil, watchFailure("watch_task_ended")
		}
	}
	_, messages, e := h.messages(ctx, l, w, text(pending["after"]))
	if e != nil {
		return nil, e
	}
	items := nativeWatchItems(messages, l.scope.Owner, w, pending)
	current, e := h.row(ctx, l, id)
	if e != nil {
		return nil, e
	}
	if current == nil || current["state"] != "active" || integer(current["revision"]) != integer(w["revision"]) || uploadObject(current["pending"])["workId"] != workID || nativeWatchHash(items) != pending["sourceHash"] {
		return nil, watchFailure("watch_source_changed")
	}
	return map[string]any{"roomId": w["roomId"], "purpose": w["purpose"], "agentGrantId": w["agentGrantId"], "lease": nativeWatchBinding(l)}, nil
}
func (h *NativeWatch) Ack(ctx context.Context, l *nativeIdentityLease, id, workID string) (map[string]any, error) {
	var ack map[string]any
	_, _, e := h.state(ctx, l, func(state map[string]any) error {
		w := uploadObject(uploadObject(state["watches"])[id])
		pending := uploadObject(w["pending"])
		if w == nil || w["state"] != "active" || integer(w["expiresAt"]) <= h.now() || pending["workId"] != workID {
			return watchFailure("watch_work_changed")
		}
		if execution := uploadObject(pending["hostExecution"]); execution != nil && (execution["state"] != "completed" || !connectionEqual(execution["lease"], nativeWatchBinding(l))) {
			return watchFailure("watch_host_completion_required")
		}
		ack = map[string]any{"roomId": w["roomId"], "agentGrantId": w["agentGrantId"], "sequence": pending["next"], "revision": w["revision"]}
		return nil
	})
	if e != nil {
		return nil, e
	}
	receipt, e := l.call(ctx, "/v2/chat/rooms/"+text(ack["roomId"])+"/cursor", map[string]any{"kind": "agent", "agentGrantId": ack["agentGrantId"], "sequence": ack["sequence"]}, false)
	if e != nil {
		return nil, e
	}
	if receipt["kind"] != "agent" || receipt["agentGrantId"] != ack["agentGrantId"] || !watchSequenceWithin(ack["sequence"], text(receipt["sequence"])) {
		return nil, watchFailure("watch_cursor_receipt_unconfirmed")
	}
	_, _, e = h.state(ctx, l, func(state map[string]any) error {
		w := uploadObject(uploadObject(state["watches"])[id])
		if w != nil && w["state"] == "active" && integer(w["revision"]) == integer(ack["revision"]) && uploadObject(w["pending"])["workId"] == workID {
			w["after"] = ack["sequence"]
			w["pending"] = nil
			w["revision"] = integer(w["revision"]) + 1
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"state": "processed", "humanRead": false, "receipt": receipt}, nil
}
