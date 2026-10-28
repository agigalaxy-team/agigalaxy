package native

import (
	"context"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type a2aWorkOperation struct {
	original *A2aPreview
	review   map[string]any
	hash     string
	lease    *nativeIdentityLease
	expires  int64
	state    string
}

// NativeA2aWork is the readable purpose layer over the SAME configured host.
// Durable reservations, credential checks and remote uncertainty stay there.
type NativeA2aWork struct {
	host       *NativeA2a
	mu         sync.Mutex
	closed     bool
	preparing  int
	operations map[string]*a2aWorkOperation
}

func NewNativeA2aWork(h *NativeA2a) *NativeA2aWork {
	return &NativeA2aWork{host: h, operations: map[string]*a2aWorkOperation{}}
}
func (h *NativeA2aWork) Close() {
	h.mu.Lock()
	h.closed = true
	pending := []*A2aPreview{}
	for _, op := range h.operations {
		if op.state != "completed" {
			pending = append(pending, op.original)
		}
	}
	h.operations = map[string]*a2aWorkOperation{}
	h.mu.Unlock()
	for _, original := range pending {
		_, _ = h.host.Abort(original)
	}
}
func a2aWorkContracts() map[string]any {
	var out map[string]any
	_ = protocol.Decode([]byte(a2aWorkContractsJSON), &out)
	return out
}
func (h *NativeA2aWork) check(ctx context.Context, l *nativeIdentityLease) error {
	h.mu.Lock()
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return connectionFailure("a2a_host_closed")
	}
	return l.check(ctx)
}
func (h *NativeA2aWork) prune() {
	at := h.host.options.Now().UnixMilli()
	for key, op := range h.operations {
		if op.expires <= at && op.state != "running" {
			delete(h.operations, key)
		}
	}
}
func (h *NativeA2aWork) data(l *nativeIdentityLease, fields map[string]any) map[string]any {
	raw, _ := protocol.EncodeJS([]any{l.scope.Owner, l.scope.Endpoint, l.connection.bindingID, l.connection.generation})
	out := map[string]any{"schemaVersion": 1, "kind": "galaxy-a2a-panel", "viewId": uuid.NewString(), "ownerScope": identity.Digest(raw), "checkedAt": h.host.options.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "availability": "ready", "peers": h.host.Peers(), "associations": []any{}}
	for key, value := range fields {
		out[key] = value
	}
	return out
}
func (h *NativeA2aWork) read(ctx context.Context, l *nativeIdentityLease, peer, action, id string) (any, error) {
	if e := h.check(ctx, l); e != nil {
		return nil, e
	}
	input := map[string]any{"peerId": peer, "action": action}
	if id != "" {
		input["associationId"] = id
	}
	v, e := h.host.Read(ctx, input)
	if changed := h.check(ctx, l); changed != nil {
		return nil, changed
	}
	return v, e
}
func (h *NativeA2aWork) readable(ctx context.Context, l *nativeIdentityLease, peer, id string, poll bool) (map[string]any, error) {
	value, e := h.read(ctx, l, peer, "get", id)
	if e != nil {
		return nil, e
	}
	link := uploadObject(value)
	var receipt map[string]any
	if imp := uploadObject(link["resultImportV2"]); imp != nil && imp["state"] != "acknowledged" {
		value, e = h.read(ctx, l, peer, "reconcile-result", id)
		if e != nil {
			return nil, e
		}
		receipt = uploadObject(value)
		value, e = h.read(ctx, l, peer, "get", id)
		if e != nil {
			return nil, e
		}
		link = uploadObject(value)
	}
	current, _, e := a2aReaders(l).resolve(ctx, text(link["caseId"]), text(link["attemptId"]), l.scope.Owner, nil, uploadObject(link["factContext"]))
	if e != nil {
		if changed := h.check(ctx, l); changed != nil {
			return nil, changed
		}
		out := map[string]any{"association": map[string]any{"associationId": id, "peerId": peer, "purpose": "原来的工作"}, "sourceUnavailable": true, "originalOperationRetained": true}
		if receipt["state"] == "acknowledged" {
			out["resultReceipt"] = receipt
		}
		return out, nil
	}
	observed := uploadObject(link["peer"])
	if poll && text(observed["taskId"]) != "" && !a2aTerminal(text(observed["state"])) {
		value, e = h.read(ctx, l, peer, "poll", id)
		if e != nil {
			return nil, e
		}
		link = uploadObject(value)
	}
	title := "当前工作"
	for _, v := range uploadRows(current["events"]) {
		event := uploadObject(v)
		if event["kind"] == "case-created" {
			title = text(event["title"])
			break
		}
	}
	name := peer
	for _, v := range h.host.Peers() {
		p := uploadObject(v)
		if p["id"] == peer && p["name"] != nil {
			name = text(p["name"])
			break
		}
	}
	facts := uploadObject(link["factContext"])
	out := map[string]any{"association": map[string]any{"associationId": id, "peerId": peer, "purpose": title, "caseId": link["caseId"], "attempt": facts["attemptRef"], "taskId": facts["taskId"]}, "peer": link, "peerName": name}
	if receipt != nil {
		out["resultReceipt"] = receipt
	}
	return out, h.check(ctx, l)
}
func (h *NativeA2aWork) Read(ctx context.Context, l *nativeIdentityLease, input map[string]any) (map[string]any, error) {
	action := text(input["action"])
	if action != "list" {
		if text(input["peerId"]) == "" || text(input["associationId"]) == "" {
			return nil, connectionFailure("a2a_original_work_required")
		}
		view, e := h.readable(ctx, l, text(input["peerId"]), text(input["associationId"]), action == "poll")
		if e != nil {
			return nil, e
		}
		return h.data(l, map[string]any{"selected": view}), nil
	}
	rows := []any{}
	more := false
	for _, v := range h.host.Peers() {
		peer := uploadObject(v)
		id := text(peer["id"])
		if selected := text(input["peerId"]); selected != "" && selected != id {
			continue
		}
		value, e := h.read(ctx, l, id, "list", "")
		if e != nil {
			return nil, e
		}
		journal := uploadRows(value)
		start := len(journal) - 32
		if start < 0 {
			start = 0
		} else if start > 0 {
			more = true
		}
		for i := len(journal) - 1; i >= start; i-- {
			view, e := h.readable(ctx, l, id, text(uploadObject(journal[i])["id"]), false)
			if e != nil {
				return nil, e
			}
			row := identityClone(view["association"])
			p := uploadObject(view["peer"])
			state := uploadObject(p["peer"])["state"]
			if state == nil {
				state = p["status"]
			}
			if state != nil {
				row["state"] = state
			}
			if view["sourceUnavailable"] != nil {
				row["sourceUnavailable"] = view["sourceUnavailable"]
			}
			rows = append(rows, row)
		}
	}
	if len(rows) > 32 {
		rows = rows[:32]
		more = true
	}
	return h.data(l, map[string]any{"associations": rows, "earlierAssociationsAvailable": more}), nil
}
func (h *NativeA2aWork) Prepare(ctx context.Context, l *nativeIdentityLease, input map[string]any) (map[string]any, error) {
	h.mu.Lock()
	h.prune()
	if h.closed || len(h.operations)+h.preparing >= 128 {
		h.mu.Unlock()
		return nil, connectionFailure("a2a_preview_capacity")
	}
	h.preparing++
	h.mu.Unlock()
	defer func() { h.mu.Lock(); h.preparing--; h.mu.Unlock() }()
	original, e := h.host.Prepare(ctx, input)
	if e != nil {
		return nil, e
	}
	if l.connection.bindingID == "" {
		return nil, connectionFailure("a2a_connection_changed")
	}
	if e = h.check(ctx, l); e != nil {
		_, _ = h.host.Abort(original)
		return nil, e
	}
	value := original.Value()
	action := text(input["action"])
	if value["state"] == "acknowledged" {
		result := identityClone(value)
		result["action"] = action
		result["peerId"] = input["peerId"]
		result["associationId"] = input["associationId"]
		result["remoteResent"] = false
		return h.data(l, map[string]any{"actionResult": result}), nil
	}
	draft := uploadObject(value["draft"])
	caseID := text(value["caseId"])
	if caseID == "" {
		caseID = text(uploadObject(draft["event"])["caseId"])
	}
	query := map[string]any{}
	if task, ok := input["taskId"]; ok {
		query["taskId"] = task
	}
	source, e := l.call(ctx, "/v2/cases/"+caseID+"/read", query, false)
	if e != nil {
		return nil, e
	}
	purpose := "当前工作"
	for _, v := range uploadRows(source["events"]) {
		event := uploadObject(v)
		if event["kind"] == "case-created" {
			purpose = text(event["title"])
			break
		}
	}
	authorization := uploadObject(value["authorization"])
	payloadJSON := text(value["payloadJson"])
	if action == "result" {
		payloadJSON = text(authorization["payloadJson"])
	}
	payload, e := connectionObject([]byte(payloadJSON))
	if e != nil {
		return nil, e
	}
	peer := original.peer
	name := peer.id
	if peer.hasName {
		name = peer.name
	}
	var visibility any = "selected-peer"
	var recipients any = []any{payload["peerPrincipal"]}
	if action == "result" {
		visibility = authorization["visibility"]
		recipients = authorization["viewers"]
	}
	exact := map[string]any{"payloadJson": payloadJSON, "payload": payload}
	if action == "result" {
		exact["source"] = draft["source"]
	} else {
		exact["externalEndpoint"] = peer.endpoint
		exact["peerPrincipal"] = payload["peerPrincipal"]
	}
	review := map[string]any{"action": action, "associationId": value["associationId"], "peerId": peer.id, "peerName": name, "purpose": purpose, "caseId": payload["caseId"], "visibility": visibility, "recipients": recipients, "payloadHash": identity.Digest([]byte(payloadJSON)), "exact": exact}
	if attempt := uploadObject(payload["factContext"])["attemptRef"]; attempt != nil {
		review["attempt"] = attempt
	}
	// The hash is over the retained preview bytes, not a reconstructed signed
	// payload. The original host retains its independent signed/dispatch bytes.
	raw, e := protocol.EncodeJS(review)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(raw)
	handle := uuid.NewString()
	expires := h.host.options.Now().UnixMilli() + 300000
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		_, _ = h.host.Abort(original)
		return nil, connectionFailure("a2a_host_closed")
	}
	h.operations[handle] = &a2aWorkOperation{original: original, review: review, hash: hash, lease: l, expires: expires, state: "prepared"}
	h.mu.Unlock()
	preview := identityClone(review)
	preview["handle"] = handle
	preview["previewHash"] = hash
	preview["expiresAt"] = time.UnixMilli(expires).UTC().Format("2006-01-02T15:04:05.000Z")
	return h.data(l, map[string]any{"preview": preview}), nil
}
func (h *NativeA2aWork) retained(l *nativeIdentityLease, op *a2aWorkOperation) map[string]any {
	return h.data(l, map[string]any{"actionResult": map[string]any{"action": op.review["action"], "peerId": op.review["peerId"], "associationId": op.review["associationId"], "state": op.state, "remoteResent": false, "originalOperationRetained": true}})
}
func registerNativeA2aWorkTools(server *mcp.Server, tools *toolRuntime, host *NativeA2a, settings ...WorkerToolOptions) func() {
	h := NewNativeA2aWork(host)
	var options WorkerToolOptions
	if len(settings) > 0 {
		options = settings[0]
	}
	for name, raw := range a2aWorkContracts() {
		c := uploadObject(raw)
		addNativeTool(server, &mcp.Tool{Name: name, Description: text(c["description"]), InputSchema: c["schema"], Meta: options.Meta, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: c["write"] != true}}, "a2a_operation_incomplete", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			render := func(data map[string]any) *mcp.CallToolResult {
				return workerPanelResult(data, options.ComponentOnly != nil && options.ComponentOnly(req))
			}
			input, e := connectionObject(req.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			remoteDefaults(uploadObject(c["schema"]), input)
			ctx, cancel, l, e := host.runtime.identityLease(ctx, false)
			if e != nil {
				return toolError(e)
			}
			defer cancel()
			failure := func(e error) (*mcp.CallToolResult, error) {
				changed := h.check(ctx, l) != nil
				code := runtimeErrorCode(e)
				if changed {
					code = "a2a_connection_changed"
				}
				return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "当前内容暂不可用。原工作和原操作仍保留。"}}, StructuredContent: map[string]any{"error": code, "originalOperationRetained": true, "privateResultWithheld": changed}}, nil
			}
			if l.connection.bindingID == "" {
				return failure(connectionFailure("a2a_connection_changed"))
			}
			if e = h.check(ctx, l); e != nil {
				return failure(e)
			}
			switch name {
			case "galaxy_a2a_work_read":
				out, e := h.Read(ctx, l, input)
				if e != nil {
					return failure(e)
				}
				return render(out), nil
			case "galaxy_a2a_work_prepare":
				out, e := h.Prepare(ctx, l, input)
				if e != nil {
					return failure(e)
				}
				return render(out), nil
			case "galaxy_a2a_work_execute":
				h.mu.Lock()
				h.prune()
				op := h.operations[text(input["handle"])]
				h.mu.Unlock()
				if op == nil || op.hash != input["previewHash"] {
					return failure(connectionFailure("a2a_preview_changed_or_expired"))
				}
				if e = h.check(ctx, op.lease); e != nil {
					return failure(e)
				}
				h.mu.Lock()
				state := op.state
				retained := h.retained(l, op)
				h.mu.Unlock()
				if state != "prepared" {
					return render(retained), nil
				}
				review := map[string]any{"handle": input["handle"], "previewHash": input["previewHash"], "expiresAt": op.expires, "preview": op.review}
				result, reviewError := tools.review(ctx, req, review, "请本人核对当前工作、所选外部服务、精确内容和接收范围；未知操作只核对原关联，不重新派发。\n"+hostJSONString(review), func(scope *ChoiceScope) (any, error) {
					if scope == nil || *scope != op.lease.scope {
						return nil, connectionFailure("a2a_connection_changed")
					}
					if e = h.check(ctx, op.lease); e != nil {
						return nil, e
					}
					h.mu.Lock()
					if op.expires <= host.options.Now().UnixMilli() {
						h.mu.Unlock()
						return nil, connectionFailure("a2a_preview_expired")
					}
					if op.state != "prepared" {
						out := h.retained(l, op)
						h.mu.Unlock()
						return out, nil
					}
					op.state = "running"
					h.mu.Unlock()
					_, e := host.ExecuteReviewed(ctx, op.original, scope)
					h.mu.Lock()
					if e != nil {
						op.state = "original-operation-needs-reconciliation"
					} else {
						op.state = "completed"
					}
					out := h.retained(l, op)
					h.mu.Unlock()
					if e != nil {
						return nil, e
					}
					return out, h.check(ctx, l)
				})
				if reviewError == nil && result != nil && !result.IsError {
					if panel := uploadObject(result.StructuredContent); panel["kind"] == "galaxy-a2a-panel" {
						return render(panel), nil
					}
				}
				return result, reviewError
			case "galaxy_a2a_work_abort_local":
				h.mu.Lock()
				op := h.operations[text(input["handle"])]
				h.mu.Unlock()
				if op == nil {
					return failure(connectionFailure("a2a_preview_unavailable"))
				}
				if e = h.check(ctx, op.lease); e != nil {
					return failure(e)
				}
				h.mu.Lock()
				state := op.state
				h.mu.Unlock()
				if state != "completed" {
					if _, e = host.Abort(op.original); e != nil {
						return failure(e)
					}
					h.mu.Lock()
					if op.state == "prepared" {
						op.state = "locally-stopped"
					}
					h.mu.Unlock()
				}
				h.mu.Lock()
				stopped := op.state == "locally-stopped"
				h.mu.Unlock()
				return render(h.data(l, map[string]any{"actionResult": map[string]any{"associationId": op.review["associationId"], "peerId": op.review["peerId"], "localStopped": stopped, "remoteCanceled": false, "originalOperationRetained": true}})), nil
			}
			return failure(remoteFactsInvalid())
		})
	}
	return h.Close
}
