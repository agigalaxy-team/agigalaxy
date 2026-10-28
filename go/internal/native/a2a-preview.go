package native

import (
	"context"
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

func a2aToolContracts() map[string]any {
	var v map[string]any
	_ = protocol.Decode([]byte(a2aToolsContractsJSON), &v)
	return v
}
func a2aNormalize(name string, input any) (map[string]any, error) {
	c := uploadObject(a2aToolContracts()[name])
	if c == nil {
		return nil, a2aError("unknown tool")
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, a2aError("invalid input")
	}
	schema := uploadObject(c["schema"])
	defaults := schema
	for _, raw := range uploadRows(schema["oneOf"]) {
		branch := uploadObject(raw)
		if uploadObject(uploadObject(branch["properties"])["action"])["const"] == value["action"] {
			defaults = branch
			break
		}
	}
	remoteDefaults(defaults, value)
	if remoteChatValidate(schema, value) != nil {
		return nil, a2aError("invalid input")
	}
	if text(value["action"]) == "reconcile-task" && !a2aIdentifier(text(value["candidateTaskId"])) {
		return nil, a2aError("invalid peer Task ID")
	}
	return value, nil
}
func (p *A2aPreview) Value() map[string]any { return a2aClone(p.value) }
func (p *A2aPreview) Scope() ChoiceScope    { return p.lease.scope }
func (h *NativeA2a) Prepare(ctx context.Context, input any) (*A2aPreview, error) {
	value, e := a2aNormalize("galaxy_a2a_prepare", input)
	if e != nil {
		return nil, e
	}
	ctx, cancel, peer, lease, j, e := h.adapter(ctx, text(value["peerId"]))
	if e != nil {
		return nil, e
	}
	defer cancel()
	action := text(value["action"])
	if action == "result" {
		return h.prepareResult(ctx, peer, lease, j, value)
	}
	var link map[string]any
	if action == "send" {
		link = map[string]any{"id": uuid.NewString(), "caseId": value["caseId"], "attemptId": value["attemptId"], "revision": 0}
		_, _, facts, e := h.access(ctx, peer, lease, link, value)
		if e != nil {
			return nil, e
		}
		link["factContext"] = facts
		rows, e := j.list(ctx)
		if e != nil {
			return nil, e
		}
		for _, row := range rows {
			v := uploadObject(row)
			if v["caseId"] == link["caseId"] && v["attemptId"] == link["attemptId"] {
				return nil, a2aError("Attempt already dispatched; inspect association")
			}
		}
	} else {
		link, e = j.get(ctx, text(value["associationId"]))
		if e != nil {
			return nil, e
		}
		if _, _, _, e = h.access(ctx, peer, lease, link, nil); e != nil {
			return nil, e
		}
		observed := uploadObject(link["peer"])
		if link["status"] != "observed" {
			return nil, a2aError("refresh observed peer task")
		}
		if action == "reply" && observed["state"] != "input-required" && observed["state"] != "auth-required" {
			return nil, a2aError("peer task not waiting for input/authentication")
		}
		if action == "cancel" && (text(observed["taskId"]) == "" || a2aTerminal(text(observed["state"]))) {
			return nil, a2aError("refresh active peer task before cancellation")
		}
	}
	if action != "cancel" {
		raw, _ := protocol.EncodeJS(value["text"])
		if len(raw) > 24000 {
			return nil, a2aError("selected text encoded request limit exceeded")
		}
	}
	scope := peer.scope(lease.scope.Owner, h.runtime.config.Endpoint)
	payload := protocol.NewOrderedObject()
	for _, field := range []struct {
		key   string
		value any
	}{{"subjectId", scope.SubjectID}, {"officialEndpoint", scope.OfficialEndpoint}, {"endpoint", scope.Endpoint}, {"tenant", scope.Tenant}, {"peerPrincipal", scope.PeerPrincipal}, {"kind", action}, {"associationId", link["id"]}, {"caseId", link["caseId"]}, {"attemptId", link["attemptId"]}, {"revision", link["revision"]}} {
		payload.Set(field.key, field.value)
	}
	observed := uploadObject(link["peer"])
	var taskID, contextID, messageID any
	if observed["taskId"] != nil {
		taskID = observed["taskId"]
	}
	if observed["contextId"] != nil {
		contextID = observed["contextId"]
	}
	if action != "cancel" {
		messageID = uuid.NewString()
	}
	payload.Set("taskId", taskID)
	payload.Set("contextId", contextID)
	payload.Set("messageId", messageID)
	if action != "cancel" {
		payload.Set("text", value["text"])
	}
	if link["factContext"] != nil {
		payload.Set("factContext", a2aFactWire(uploadObject(link["factContext"])))
	}
	raw, e := protocol.EncodeJS(payload)
	if e != nil {
		return nil, e
	}
	operationID := uuid.NewString()
	previewValue := a2aClone(payload.Values())
	previewValue["operationId"] = operationID
	previewValue["payloadJson"] = string(raw)
	previewValue["confirmation"] = "CONFIRM A2A " + operationID + " " + a2aHash(raw)
	if e = lease.check(ctx); e != nil {
		return nil, e
	}
	preview := &A2aPreview{host: h, peer: peer, lease: lease, journal: j, link: link, value: previewValue, action: action, operationID: operationID, state: "prepared", expires: h.options.Now().UnixMilli() + 300000}
	return h.keepPreview(preview)
}
func (h *NativeA2a) keepPreview(preview *A2aPreview) (*A2aPreview, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, a2aError("host closed")
	}
	for id, p := range h.previews {
		if p.expires <= h.options.Now().UnixMilli() && p.state != "running" {
			delete(h.previews, id)
		}
	}
	if len(h.previews) >= 128 {
		return nil, a2aError("inspect or cancel pending previews first")
	}
	h.previews[preview.operationID] = preview
	return preview, nil
}
func (h *NativeA2a) ExecuteReviewed(ctx context.Context, p *A2aPreview, expected *ChoiceScope) (map[string]any, error) {
	ctx, operationCancel, _, e := h.runtime.operation(ctx, true)
	if e != nil {
		return nil, e
	}
	defer operationCancel()
	h.mu.Lock()
	if p == nil || p.host != h || h.closed || h.previews[p.operationID] != p || p.state != "prepared" || p.expires <= h.options.Now().UnixMilli() {
		h.mu.Unlock()
		return nil, a2aError("unknown or finished preview")
	}
	if expected == nil || *expected != p.lease.scope {
		h.mu.Unlock()
		return nil, a2aError("review scope changed")
	}
	p.state = "running"
	ctx, cancel := context.WithCancel(ctx)
	p.cancel = cancel
	h.mu.Unlock()
	defer cancel()
	defer func() {
		h.mu.Lock()
		if p.state == "running" {
			p.state = "original-operation-needs-reconciliation"
		}
		p.cancel = nil
		h.mu.Unlock()
	}()
	if e := p.lease.check(ctx); e != nil {
		return nil, e
	}
	if p.action == "result" {
		value, e := h.executeResult(ctx, p)
		if e == nil {
			h.mu.Lock()
			p.state = "completed"
			h.mu.Unlock()
		}
		return value, e
	}
	credential, _, _, e := h.access(ctx, p.peer, p.lease, p.link, nil)
	if e != nil {
		return nil, e
	}
	params := a2aTaskParams(p.peer.tenant, text(uploadObject(p.link["peer"])["taskId"]), nil)
	if p.action != "cancel" {
		params = a2aMessageParams(p.peer.tenant, text(p.value["text"]), text(p.value["messageId"]), uploadObject(p.link["peer"]))
	}
	result, e := h.perform(ctx, p.peer, p.lease, p.journal, p.link, p.action, p.operationID, a2aHash([]byte(text(p.value["payloadJson"]))), credential, params)
	if e == nil {
		h.mu.Lock()
		p.state = "completed"
		h.mu.Unlock()
	}
	return result, e
}
func (h *NativeA2a) Abort(p *A2aPreview) (map[string]any, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p == nil || p.host != h || h.previews[p.operationID] != p {
		return nil, a2aError("unknown preview; durable association remains")
	}
	if p.cancel != nil {
		p.cancel()
	}
	p.state = "locally-stopped"
	return map[string]any{"localStopped": true, "remoteCanceled": false, "originalOperationRetained": true}, nil
}
