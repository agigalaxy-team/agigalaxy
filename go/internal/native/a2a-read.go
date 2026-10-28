package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func (h *NativeA2a) guard(l *nativeIdentityLease, dir string) error {
	if e := h.runtime.checkOperation(l.generation); e != nil {
		return e
	}
	return h.runtime.store.verifyChoiceWithin(dir, &l.scope)
}
func (h *NativeA2a) Read(ctx context.Context, input any) (any, error) {
	value, e := a2aNormalize("galaxy_a2a_read", input)
	if e != nil {
		return nil, e
	}
	peerID := text(value["peerId"])
	action := text(value["action"])
	id := text(value["associationId"])
	if action == "poll" {
		return h.Poll(ctx, peerID, id)
	}
	ctx, cancel, p, l, j, e := h.adapter(ctx, peerID)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if action == "list" {
		rows, e := j.list(ctx)
		if e == nil {
			e = l.check(ctx)
		}
		return rows, e
	}
	link, e := j.get(ctx, id)
	if e != nil {
		return nil, e
	}
	if action == "get" {
		return link, l.check(ctx)
	}
	if action == "reconcile-result" {
		return h.reconcileResult(ctx, l, j, id)
	}
	if action != "reconcile-task" {
		return nil, a2aError("unsupported read")
	}
	operations := uploadRows(link["operations"])
	var original map[string]any
	for _, item := range operations {
		op := uploadObject(item)
		if op["id"] == value["operationId"] {
			original = op
		}
	}
	if original == nil || original["requestHash"] != value["requestHash"] || original["kind"] != "send" || len(operations) != 1 || text(uploadObject(link["peer"])["taskId"]) != "" || link["status"] != "unknown" && link["status"] != "dispatching" || original["outcome"] != "unknown" && original["outcome"] != "dispatching" {
		return nil, a2aError("exact unknown original operation required")
	}
	unknown := func(reason string) (any, error) {
		return map[string]any{"state": "unknown", "reason": reason, "associationId": id, "operationId": original["id"], "requestHash": original["requestHash"], "originalOperationRetained": true, "remoteResent": false}, nil
	}
	credential, _, _, e := h.access(ctx, p, l, link, nil)
	if e != nil {
		return nil, e
	}
	saved := uploadObject(original["originalMessage"])
	if !controlUUID(text(saved["messageId"])) || len(text(saved["contentHash"])) != 64 || saved["taskId"] != nil || saved["contextId"] != nil {
		return unknown("original-message-unavailable")
	}
	history := 128
	result, e := a2aRPC(ctx, h.options.Post, p.scope(l.scope.Owner, h.runtime.config.Endpoint).Endpoint, credential, "GetTask", a2aTaskParams(p.tenant, text(value["candidateTaskId"]), &history))
	if check := l.check(ctx); check != nil {
		return nil, check
	}
	if e != nil {
		return unknown("peer-observation-unavailable")
	}
	if _, _, _, e = h.access(ctx, p, l, link, nil); e != nil {
		return nil, e
	}
	task := a2aObject(result)
	messages := uploadRows(task["history"])
	if task["id"] != value["candidateTaskId"] || len(messages) > 128 {
		return unknown("original-message-unproven")
	}
	var message any
	matches := 0
	for _, item := range messages {
		if a2aObject(item)["messageId"] == saved["messageId"] {
			message = item
			matches++
		}
	}
	if matches != 1 {
		return unknown("original-message-unproven")
	}
	m := a2aObject(message)
	if m["role"] != "ROLE_USER" || text(m["taskId"]) != "" && m["taskId"] != task["id"] || text(m["contextId"]) != "" && m["contextId"] != task["contextId"] {
		return unknown("original-message-unproven")
	}
	wire := a2aProjection("message", message)
	clean := protocol.NewOrderedObject()
	for _, key := range wire.Keys() {
		if key != "taskId" && key != "contextId" {
			clean.Set(key, wire.Values()[key])
		}
	}
	raw, _ := protocol.EncodeJS(clean)
	if a2aHash(raw) != saved["contentHash"] {
		return unknown("original-message-unproven")
	}
	peer, e := a2aSnapshot(result, nil)
	if e != nil {
		return unknown("original-message-unproven")
	}
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	association, e := j.change(ctx, id, a2aInteger(link["revision"]), func(dir string) error { return h.guard(l, dir) }, func(previous map[string]any) (map[string]any, error) {
		next := a2aClone(previous)
		next["peer"] = peer
		next["status"] = "observed"
		return a2aFinish(next, map[string]any{"outcome": "observed", "state": peer["state"], "responseHash": peer["responseHash"], "correlation": "original-message-history", "reconciledAt": h.options.Now().UnixMilli()}), nil
	})
	if e != nil {
		return nil, e
	}
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	return map[string]any{"state": "observed", "association": association, "originalOperationRetained": true, "remoteResent": false}, nil
}
