package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func workerContracts() map[string]any {
	var c map[string]any
	_ = protocol.Decode([]byte(workerPackToolsJSON), &c)
	return c
}
func workerInput(name string, input any) (map[string]any, error) {
	contract := uploadObject(workerContracts()[name])
	if contract == nil {
		return nil, a2aError("unknown Worker action")
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, a2aError("invalid Worker input")
	}
	schema := uploadObject(contract["schema"])
	branch := schema
	for _, raw := range uploadRows(schema["oneOf"]) {
		v := uploadObject(raw)
		if uploadObject(uploadObject(v["properties"])["action"])["const"] == value["action"] {
			branch = v
			break
		}
	}
	remoteDefaults(branch, value)
	if value["action"] == "start" {
		value["purpose"] = uploadTrim(text(value["purpose"]))
	}
	if remoteChatValidate(schema, value) != nil {
		return nil, a2aError("invalid Worker input")
	}
	return value, nil
}
func (h *NativeWorkerHost) prepareInner(l *nativeIdentityLease, kind string, row map[string]any, inner *A2aPreview) *WorkerPreview {
	value := map[string]any{"kind": kind, "associationId": row["associationId"], "workerId": row["workerId"], "pack": row["pack"], "purpose": row["purpose"], "caseId": row["caseId"], "attempt": row["attempt"]}
	if inner != nil {
		value["preview"] = inner.Value()
	}
	return &WorkerPreview{host: h, lease: l, kind: kind, row: row, inner: inner, value: value}
}
func (h *NativeWorkerHost) Prepare(ctx context.Context, input any) (*WorkerPreview, error) {
	value, e := workerInput("galaxy_worker_host_prepare", input)
	if e != nil {
		return nil, e
	}
	ctx, l, done, e := h.enter(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	action := text(value["action"])
	if action == "use" {
		return h.prepareUse(ctx, l, value)
	}
	if action == "start" {
		worker := h.worker(text(value["workerId"]))
		if _, e = h.manifest(ctx, l, worker); e != nil {
			return nil, e
		}
		query := map[string]any{}
		if value["taskId"] != nil {
			query["taskId"] = value["taskId"]
		}
		facts, e := l.call(ctx, "/v2/cases/"+text(value["caseId"])+"/read", query, false)
		if e != nil {
			return nil, e
		}
		var attempt map[string]any
		for _, raw := range uploadRows(facts["attempts"]) {
			v := uploadObject(raw)
			if v["id"] == value["attemptId"] && a2aInteger(v["version"]) == a2aInteger(value["attemptVersion"]) {
				attempt = v
				break
			}
		}
		if facts["caseId"] != value["caseId"] || attempt["actorId"] != l.scope.Owner || attempt["configurationRef"] == nil {
			return nil, a2aError("actual current owned Attempt and exact Configuration required")
		}
		selected := map[string]any{"peerId": worker["peerId"], "action": "send", "caseId": value["caseId"], "attemptId": value["attemptId"], "attemptVersion": value["attemptVersion"], "text": value["text"]}
		if value["taskId"] != nil {
			selected["taskId"] = value["taskId"]
		}
		inner, e := h.a2a.Prepare(ctx, selected)
		if e != nil {
			return nil, e
		}
		if e = l.check(ctx); e != nil {
			return nil, e
		}
		row := map[string]any{"associationId": inner.value["associationId"], "workerId": worker["id"], "peerId": worker["peerId"], "pack": worker["pack"], "purpose": value["purpose"], "caseId": value["caseId"], "attempt": map[string]any{"id": attempt["id"], "version": attempt["version"]}, "configuration": attempt["configurationRef"], "owner": map[string]any{"subjectId": l.scope.Owner, "endpoint": h.runtime.config.Endpoint}, "state": "prepared"}
		if value["taskId"] != nil {
			row["taskId"] = value["taskId"]
		}
		return h.prepareInner(l, "send", row, inner), nil
	}
	row, e := workerSelected(ctx, l, text(value["associationId"]))
	if e != nil {
		return nil, e
	}
	selected := map[string]any{"peerId": row["peerId"], "action": action, "associationId": row["associationId"]}
	if action == "result" {
		for _, key := range []string{"summary", "reportedOutcome", "limitations", "visibility", "viewers", "expiresAt"} {
			if v, ok := value[key]; ok {
				selected[key] = v
			}
		}
	}
	inner, e := h.a2a.Prepare(ctx, selected)
	if e != nil {
		return nil, e
	}
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	if inner.value["state"] == "acknowledged" {
		return &WorkerPreview{host: h, lease: l, row: row, value: inner.Value(), used: true}, nil
	}
	return h.prepareInner(l, action, row, inner), nil
}
func (h *NativeWorkerHost) Read(ctx context.Context, input any) (map[string]any, error) {
	value, e := workerInput("galaxy_worker_host_read", input)
	if e != nil {
		return nil, e
	}
	ctx, l, done, e := h.enter(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	if value["action"] == "list" {
		stored, e := workerRead(ctx, l, workerStateKey(l))
		if e != nil {
			return nil, e
		}
		_, rows, e := workerState(stored)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, id := range rows.Keys() {
			row := a2aObject(rows.Values()[id])
			owner := a2aObject(row["owner"])
			if owner["subjectId"] != l.scope.Owner || owner["endpoint"] != h.runtime.config.Endpoint {
				return nil, a2aError("original Worker association owner changed")
			}
			item := map[string]any{"associationId": row["associationId"], "workerId": row["workerId"], "pack": row["pack"], "caseId": row["caseId"], "attempt": row["attempt"], "owner": row["owner"]}
			if op := a2aObject(row["packUse"]); op != nil {
				item["packUse"] = map[string]any{"operationId": op["operationId"], "payloadHash": op["payloadHash"]}
			}
			items = append(items, item)
		}
		return map[string]any{"associations": items}, l.check(ctx)
	}
	id := text(value["associationId"])
	if id == "" {
		return nil, a2aError("Worker association required")
	}
	row, e := workerSelected(ctx, l, id)
	if e != nil {
		return nil, e
	}
	if value["action"] == "reconcile-use" {
		return h.reconcileUse(ctx, l, row)
	}
	action := "get"
	if value["action"] == "poll" {
		action = "poll"
	}
	if value["action"] == "reconcile-result" {
		result, e := h.a2a.Read(ctx, map[string]any{"peerId": row["peerId"], "action": "reconcile-result", "associationId": id})
		if e != nil {
			return nil, e
		}
		return a2aObject(result), l.check(ctx)
	}
	peer, e := h.a2a.Read(ctx, map[string]any{"peerId": row["peerId"], "action": action, "associationId": id})
	if e != nil {
		return nil, e
	}
	return map[string]any{"association": row, "peer": peer, "executionAuthority": "peer-reported", "capabilityVerified": false}, l.check(ctx)
}
func (h *NativeWorkerHost) ExecuteReviewed(ctx context.Context, p *WorkerPreview, expected *ChoiceScope) (map[string]any, error) {
	ctx, l, done, e := h.enter(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	h.mu.Lock()
	invalid := p == nil || p.host != h || p.used || expected == nil || p.lease.scope != *expected || l.scope != p.lease.scope
	if !invalid {
		p.used = true
	}
	h.mu.Unlock()
	if invalid {
		return nil, a2aError("reviewed exact Worker action required")
	}
	if e = p.lease.check(ctx); e != nil {
		return nil, e
	}
	if p.kind == "send" {
		if _, e = h.manifest(ctx, l, h.worker(text(p.row["workerId"]))); e != nil {
			return nil, e
		}
		row := a2aClone(p.row)
		row["state"] = "dispatching"
		if e = workerPutRow(ctx, l, row, nil, true); e != nil {
			return nil, e
		}
	}
	if p.kind == "pack-use" || p.kind == "pack-use-retry" {
		return h.executeUse(ctx, l, p)
	}
	if p.kind == "result" {
		return h.executeResult(ctx, l, p)
	}
	value, e := h.a2a.ExecuteReviewed(ctx, p.inner, expected)
	if check := l.check(ctx); check != nil {
		return nil, check
	}
	return value, e
}
func (h *NativeWorkerHost) Abort(p *WorkerPreview) (map[string]any, error) {
	h.mu.Lock()
	if p == nil || p.host != h || h.closed {
		h.mu.Unlock()
		return nil, a2aError("unknown Worker preview")
	}
	p.used = true
	h.mu.Unlock()
	if e := p.lease.check(context.Background()); e != nil {
		return nil, e
	}
	if p.kind == "pack-use" || p.kind == "pack-use-retry" {
		return map[string]any{"previewDiscarded": true, "remoteCanceled": false, "originalOperationRetained": true}, nil
	}
	return h.a2a.Abort(p.inner)
}
