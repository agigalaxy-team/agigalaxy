package native

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type WorkerToolOptions struct {
	Meta          mcp.Meta
	ComponentOnly func(*mcp.CallToolRequest) bool
}

func (h *NativeWorkerHost) captureTool(ctx context.Context) (context.Context, *nativeIdentityLease, func(), error) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, nil, nil, a2aError("Worker host closed")
	}
	h.active.Add(1)
	h.mu.Unlock()
	op, cancel, _, e := h.runtime.operation(ctx, true)
	if e != nil {
		h.active.Done()
		return nil, nil, nil, e
	}
	stop := context.AfterFunc(h.lifecycle, cancel)
	ctx, leaseCancel, l, e := h.runtime.identityLease(op, false)
	if e != nil {
		stop()
		cancel()
		h.active.Done()
		return nil, nil, nil, e
	}
	done := func() { leaseCancel(); stop(); cancel(); h.active.Done() }
	if l.connection.bindingID == "" {
		done()
		return nil, nil, nil, a2aError("Worker host current connection required")
	}
	return ctx, l, done, nil
}
func (h *NativeWorkerHost) panel(ctx context.Context, l *nativeIdentityLease, fields map[string]any) (map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var device any
	if l.scope.DeviceID != "" {
		device = l.scope.DeviceID
	}
	scope, _ := protocol.EncodeJS([]any{l.scope.Owner, device, h.runtime.config.Endpoint, l.connection.bindingID, l.connection.generation})
	out := map[string]any{"schemaVersion": 1, "kind": "galaxy-worker-panel", "viewId": uuid.NewString(), "ownerScope": identity.Digest(scope), "checkedAt": h.now().UTC().Format("2006-01-02T15:04:05.000Z"), "availability": "ready", "workers": h.Workers(), "associations": []any{}}
	for key, value := range fields {
		out[key] = value
	}
	return out, nil
}
func workerReviewData(p *WorkerPreview, action string, worker map[string]any) (map[string]any, error) {
	var payloadJSON, visibility, operationID string
	recipients := []string{}
	exact := map[string]any{}
	switch p.kind {
	case "pack-use-retry":
		saved := a2aObject(p.row["packUse"])
		raw, e := protocol.EncodeJS(saved["payload"])
		if e != nil {
			return nil, e
		}
		payloadJSON = string(raw)
		if identity.Digest(raw) != saved["payloadHash"] {
			return nil, a2aError("original PackUse review hash changed")
		}
		visibility = text(a2aObject(saved["disclosure"])["visibility"])
		recipients = mustUploadStrings(a2aObject(saved["disclosure"])["viewers"])
		operationID = text(saved["operationId"])
		exact = map[string]any{"payloadJson": payloadJSON, "payload": saved["payload"], "disclosure": saved["disclosure"], "configuration": p.row["configuration"]}
	case "pack-use":
		op := p.operation
		payloadJSON = text(op["payloadJson"])
		visibility = text(op["visibility"])
		recipients = mustUploadStrings(op["viewers"])
		operationID = text(op["operationId"])
		if identity.Digest([]byte(payloadJSON)) != op["payloadHash"] {
			return nil, a2aError("original PackUse review hash changed")
		}
		exact = map[string]any{"payloadJson": payloadJSON, "payload": op["payload"], "disclosure": map[string]any{"visibility": visibility, "viewers": recipients}}
	case "result":
		inner := p.inner.value
		authorization := uploadObject(inner["authorization"])
		payloadJSON = text(authorization["payloadJson"])
		visibility = text(authorization["visibility"])
		recipients = mustUploadStrings(authorization["viewers"])
		operationID = text(uploadObject(uploadObject(inner["draft"])["event"])["eventId"])
		exact = map[string]any{"payloadJson": payloadJSON, "payload": a2aObjectFromJSON([]byte(payloadJSON)), "authorization": authorization, "source": uploadObject(inner["draft"])["source"]}
	default:
		inner := p.inner.value
		payloadJSON = text(inner["payloadJson"])
		visibility = "selected-peer"
		recipients = []string{text(inner["peerPrincipal"])}
		operationID = text(inner["operationId"])
		exact = map[string]any{"payloadJson": payloadJSON, "payload": a2aObjectFromJSON([]byte(payloadJSON)), "externalEndpoint": inner["endpoint"], "peerPrincipal": inner["peerPrincipal"]}
	}
	configuration := a2aObject(p.row["configuration"])
	if text(configuration["id"]) == "" || a2aInteger(configuration["version"]) < 1 {
		return nil, a2aError("exact Worker Configuration review required")
	}
	if recipients == nil {
		recipients = []string{}
	}
	return map[string]any{"action": action, "associationId": p.row["associationId"], "workerId": p.row["workerId"], "workerName": worker["id"], "pack": p.row["pack"], "workerVersion": worker["version"], "sourceHash": worker["sourceHash"], "configuration": configuration, "purpose": p.row["purpose"], "caseId": p.row["caseId"], "attempt": p.row["attempt"], "operationId": operationID, "payloadHash": identity.Digest([]byte(payloadJSON)), "visibility": visibility, "recipients": recipients, "exact": exact}, nil
}
func (h *NativeWorkerHost) prunePreviews() {
	expired := []*WorkerPreview{}
	h.mu.Lock()
	for key, p := range h.previews {
		if p.expiresAt <= h.now().UnixMilli() && p.state != "running" {
			delete(h.previews, key)
			if p.state == "prepared" {
				expired = append(expired, p)
			}
		}
	}
	h.mu.Unlock()
	for _, p := range expired {
		_, _ = h.Abort(p)
	}
}
func registerNativeWorkerTools(server *mcp.Server, tools *toolRuntime, host *NativeWorkerHost, options ...WorkerToolOptions) func() {
	if host == nil {
		return func() {}
	}
	var settings WorkerToolOptions
	if len(options) > 0 {
		settings = options[0]
	}
	contracts := workerContracts()
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := uploadObject(contracts[name])
		schema := identityClone(uploadObject(contract["schema"]))
		schema["type"] = "object"
		if name == "galaxy_worker_host_prepare" {
			for _, raw := range uploadRows(schema["oneOf"]) {
				p := uploadObject(uploadObject(uploadObject(raw)["properties"])["purpose"])
				delete(p, "minLength")
				delete(p, "maxLength")
			}
		}
		addNativeTool(server, &mcp.Tool{Name: name, Description: text(contract["description"]), InputSchema: schema, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: contract["write"] != true}, Meta: settings.Meta}, "native_remote_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			ctx, l, done, e := host.captureTool(ctx)
			failed := func(err error) (*mcp.CallToolResult, error) {
				out := map[string]any{"error": "worker_host_action_incomplete", "reason": err.Error(), "originalOperationRetained": true}
				if l != nil && l.check(context.Background()) != nil {
					out = map[string]any{"error": "worker_host_connection_changed", "originalOperationRetained": true, "privateResultWithheld": true}
				}
				result, encode := toolResult(out)
				if result != nil {
					result.IsError = true
				}
				return result, encode
			}
			if e != nil {
				return failed(e)
			}
			defer done()
			var raw map[string]any
			if protocol.Decode(request.Params.Arguments, &raw) != nil {
				return failed(a2aError("invalid Worker input"))
			}
			input, e := workerInput(name, raw)
			if e != nil {
				return failed(e)
			}
			render := func(fields map[string]any) (*mcp.CallToolResult, error) {
				data, e := host.panel(ctx, l, fields)
				if e != nil {
					return failed(e)
				}
				component := settings.ComponentOnly != nil && settings.ComponentOnly(request)
				return workerPanelResult(data, component), nil
			}
			switch name {
			case "galaxy_worker_host_read":
				value, e := host.Read(ctx, input)
				if e != nil {
					return failed(e)
				}
				action := text(input["action"])
				if action == "list" {
					rows := uploadRows(value["associations"])
					associations := []any{}
					start := len(rows) - 32
					if start < 0 {
						start = 0
					}
					for i := len(rows) - 1; i >= start; i-- {
						row := a2aClone(uploadObject(rows[i]))
						selected, e := host.Read(ctx, map[string]any{"action": "get", "associationId": row["associationId"]})
						if e != nil {
							if check := l.check(ctx); check != nil {
								return failed(check)
							}
							row["sourceUnavailable"] = true
						} else {
							row["purpose"] = a2aObject(selected["association"])["purpose"]
							peer := a2aObject(selected["peer"])
							row["state"] = a2aObject(peer["peer"])["state"]
							if row["state"] == nil {
								row["state"] = peer["status"]
							}
						}
						associations = append(associations, row)
					}
					return render(map[string]any{"associations": associations, "earlierAssociationsAvailable": len(rows) > 32})
				}
				if isOne(action, "reconcile-result", "reconcile-use") {
					return render(map[string]any{"actionResult": map[string]any{"associationId": input["associationId"], "action": action, "result": value}})
				}
				peer := a2aObject(value["peer"])
				if saved := uploadObject(peer["resultImportV2"]); saved != nil && saved["state"] != "acknowledged" {
					receipt, e := host.Read(ctx, map[string]any{"action": "reconcile-result", "associationId": input["associationId"]})
					if e != nil {
						return failed(e)
					}
					value, e = host.Read(ctx, map[string]any{"action": "get", "associationId": input["associationId"]})
					if e != nil {
						return failed(e)
					}
					value["resultReceipt"] = receipt
				}
				if a2aObject(value["association"])["packUse"] != nil {
					receipt, e := host.Read(ctx, map[string]any{"action": "reconcile-use", "associationId": input["associationId"]})
					if e != nil {
						return failed(e)
					}
					value["packUseReceipt"] = receipt
				}
				return render(map[string]any{"selected": value})
			case "galaxy_worker_host_prepare":
				host.prunePreviews()
				host.mu.Lock()
				if len(host.previews)+host.preparing >= 128 {
					host.mu.Unlock()
					return failed(a2aError("Worker preview capacity"))
				}
				host.preparing++
				host.mu.Unlock()
				defer func() { host.mu.Lock(); host.preparing--; host.mu.Unlock() }()
				p, e := host.Prepare(ctx, input)
				if e != nil {
					return failed(e)
				}
				if p.value["state"] == "acknowledged" {
					value := a2aClone(p.value)
					value["action"] = input["action"]
					value["associationId"] = input["associationId"]
					value["remoteResent"] = false
					return render(map[string]any{"actionResult": value})
				}
				review, e := workerReviewData(p, text(input["action"]), host.worker(text(p.row["workerId"])))
				if e != nil {
					return failed(e)
				}
				if e = l.check(ctx); e != nil {
					return failed(e)
				}
				p.handle = uuid.NewString()
				wire, _ := protocol.EncodeJS(review)
				p.previewHash = identity.Digest(wire)
				p.expiresAt = host.now().UnixMilli() + 300000
				p.state = "prepared"
				p.reviewData = review
				host.mu.Lock()
				host.previews[p.handle] = p
				host.mu.Unlock()
				preview := a2aClone(review)
				preview["handle"] = p.handle
				preview["previewHash"] = p.previewHash
				preview["expiresAt"] = time.UnixMilli(p.expiresAt).UTC().Format("2006-01-02T15:04:05.000Z")
				return render(map[string]any{"preview": preview})
			case "galaxy_worker_host_execute":
				host.prunePreviews()
				host.mu.Lock()
				p := host.previews[text(input["handle"])]
				valid := p != nil && p.previewHash == input["previewHash"] && p.expiresAt > host.now().UnixMilli()
				host.mu.Unlock()
				if !valid {
					return failed(a2aError("Worker preview changed or expired"))
				}
				if e = p.lease.check(ctx); e != nil {
					return failed(e)
				}
				retained := func() (map[string]any, error) {
					host.mu.Lock()
					state, result := p.state, p.result
					host.mu.Unlock()
					value := map[string]any{"action": p.reviewData["action"], "associationId": p.reviewData["associationId"], "operationId": p.reviewData["operationId"], "state": state, "remoteResent": false}
					if state == "completed" {
						value["result"] = result
					} else {
						value["originalOperationRetained"] = true
					}
					return host.panel(ctx, l, map[string]any{"actionResult": value})
				}
				host.mu.Lock()
				state := p.state
				host.mu.Unlock()
				if state != "prepared" {
					data, e := retained()
					if e != nil {
						return failed(e)
					}
					return workerPanelResult(data, settings.ComponentOnly != nil && settings.ComponentOnly(request)), nil
				}
				choice := map[string]any{"handle": input["handle"], "previewHash": input["previewHash"], "expiresAt": p.expiresAt, "preview": p.reviewData}
				reviewJSON, _ := protocol.EncodeJS(choice)
				result, e := tools.review(ctx, request, choice, fmt.Sprintf("本人仅确认所示 Worker、Pack 版本、实际 Configuration、Attempt、选中内容与接收范围。外部报告、Case Result 与 PackUse 各自独立选择，不启动模型或安装。\n%s\n关闭或取消不表示远端工作已取消；未知沿原操作核对。", reviewJSON), func(scope *ChoiceScope) (any, error) {
					if e = l.check(ctx); e != nil {
						return nil, e
					}
					if e = p.lease.check(ctx); e != nil {
						return nil, e
					}
					host.mu.Lock()
					state := p.state
					expired := p.expiresAt <= host.now().UnixMilli()
					if state == "prepared" && !expired {
						p.state = "running"
					}
					host.mu.Unlock()
					if expired {
						return nil, a2aError("Worker preview expired during review")
					}
					if state != "prepared" {
						return retained()
					}
					if p.expiresAt <= host.now().UnixMilli() {
						return nil, a2aError("Worker preview expired")
					}
					value, e := host.ExecuteReviewed(ctx, p, scope)
					host.mu.Lock()
					if e == nil {
						p.result = value
						p.state = "completed"
					} else {
						p.state = "original-operation-needs-reconciliation"
					}
					host.mu.Unlock()
					if e != nil {
						return nil, e
					}
					return retained()
				})
				if e != nil {
					return failed(e)
				}
				if check := l.check(ctx); check != nil {
					return failed(check)
				}
				if len(result.Content) == 1 {
					if content, ok := result.Content[0].(*mcp.TextContent); ok {
						decoded, decodeErr := a2aDecodeJSON([]byte(content.Text))
						data := a2aObject(decoded)
						if decodeErr == nil && data["kind"] == "galaxy-worker-panel" {
							return workerPanelResult(data, settings.ComponentOnly != nil && settings.ComponentOnly(request)), nil
						}
					}
				}
				return result, nil
			case "galaxy_worker_host_abort_local":
				host.mu.Lock()
				p := host.previews[text(input["handle"])]
				var state string
				if p != nil {
					state = p.state
				}
				host.mu.Unlock()
				if p == nil {
					return failed(a2aError("unknown Worker preview"))
				}
				if e = p.lease.check(ctx); e != nil {
					return failed(e)
				}
				if state == "completed" {
					return render(map[string]any{"actionResult": map[string]any{"state": "completed", "localStopped": false, "remoteCanceled": false, "associationId": p.row["associationId"], "originalOperationRetained": true}})
				}
				value, e := host.Abort(p)
				if e != nil {
					return failed(e)
				}
				host.mu.Lock()
				if p.state == "prepared" {
					p.state = "locally-stopped"
				}
				host.mu.Unlock()
				value["associationId"] = p.row["associationId"]
				value["remoteCanceled"] = false
				value["originalOperationRetained"] = true
				return render(map[string]any{"actionResult": value})
			}
			return failed(a2aError("unknown Worker tool"))
		})
	}
	return host.Close
}
