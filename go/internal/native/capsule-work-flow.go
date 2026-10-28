package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"time"
)

func (h *NativeCapsuleWork) reconcile(ctx context.Context, l *nativeIdentityLease, row map[string]any) (any, error) {
	payload, e := connectionObject([]byte(text(row["payloadJson"])))
	if e != nil || identity.Digest([]byte(text(row["payloadJson"]))) != row["payloadHash"] {
		return nil, connectionFailure("capsule_work_original_changed")
	}
	kind := "use"
	if row["action"] == "publish" {
		kind = "publication"
	}
	receipt, e := h.read(ctx, l, "/v2/capsules/receipt", map[string]any{"type": kind, "operationId": payload["id"], "payloadHash": row["payloadHash"]})
	if e != nil {
		return nil, e
	}
	if receipt["state"] == "acknowledged" {
		row["state"] = "acknowledged"
		row["receipt"] = receipt
		if e = h.save(ctx, l, row); e != nil {
			return nil, e
		}
	}
	state := receipt["state"]
	if state == "absent" {
		state = "unknown"
	}
	return map[string]any{"state": state, "handle": row["handle"], "title": capsulePurposeName(text(row["action"])), "receipt": receipt, "currentReadPermissionConfirmed": false}, nil
}
func (h *NativeCapsuleWork) status(ctx context.Context, l *nativeIdentityLease, id string) (any, error) {
	row, e := h.load(ctx, l, id, true)
	if e != nil {
		return nil, e
	}
	if row["state"] == "prepared" {
		return map[string]any{"state": "prepared", "handle": id, "title": capsulePurposeName(text(row["action"]))}, nil
	}
	return h.reconcile(ctx, l, row)
}
func (h *NativeCapsuleWork) pending(ctx context.Context, l *nativeIdentityLease) (any, error) {
	value, e := l.readAny(ctx, capsuleWorkKey(l, "index"))
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, id := range uploadRows(value) {
		row, e := l.read(ctx, capsuleWorkKey(l, text(id)))
		if e != nil {
			return nil, e
		}
		if row != nil && row["state"] != "acknowledged" && (row["state"] != "prepared" || integer(row["expiresAt"]) > time.Now().UnixMilli()) {
			items = append(items, map[string]any{"handle": id, "action": row["action"], "state": row["state"], "title": capsulePurposeName(text(row["action"]))})
		}
	}
	return map[string]any{"items": items}, nil
}
func (h *NativeCapsuleWork) Preview(ctx context.Context, id string) (map[string]any, error) {
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	row, e := h.load(ctx, l, id, false)
	if e != nil {
		return nil, e
	}
	if row["state"] == "prepared" {
		payload, e := connectionObject([]byte(text(row["payloadJson"])))
		if e != nil {
			return nil, e
		}
		if row["action"] == "publish" {
			check, e := h.read(ctx, l, "/v2/capsules/preview", map[string]any{"payload": payload})
			if e != nil {
				return nil, e
			}
			if check["readyForPublicPublication"] != true && !(row["visibility"] == "Private" && check["reason"] == "capsule_publication_not_permitted") {
				code := text(check["reason"])
				if code == "" {
					code = "capsule_source_unavailable"
				}
				return nil, connectionFailure(code)
			}
		} else {
			capsule, e := h.read(ctx, l, "/v2/capsules/read", map[string]any{"capsuleId": payload["capsuleId"], "versionId": payload["versionId"]})
			if e != nil {
				return nil, e
			}
			if capsule["version"] == nil {
				return nil, connectionFailure("capsule_source_unavailable")
			}
			if row["action"] != "reference" {
				if capsule["newApplicationAllowed"] != true {
					return nil, connectionFailure("capsule_not_applicable")
				}
				input := map[string]any{}
				if payload["taskId"] != nil {
					input["taskId"] = payload["taskId"]
				}
				view, e := h.read(ctx, l, "/v2/cases/"+text(payload["caseId"])+"/read", input)
				if e != nil {
					return nil, e
				}
				if workResult(view, l.scope.Owner, text(row["action"]), uploadObject(payload["resultRef"])) == nil {
					return nil, connectionFailure("capsule_work_current_result_required")
				}
			}
		}
	}
	return row, nil
}
func (h *NativeCapsuleWork) ExecuteReviewed(ctx context.Context, id string, scope *ChoiceScope) (result any, err error) {
	if scope == nil {
		return nil, connectionFailure("capsule_work_choice_required")
	}
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if l.scope != *scope {
		return nil, connectionFailure("capsule_work_identity_changed")
	}
	row, e := h.load(ctx, l, id, false)
	if e != nil {
		return nil, e
	}
	if row["state"] == "acknowledged" {
		return map[string]any{"state": row["state"], "handle": id, "title": capsulePurposeName(text(row["action"])), "receipt": row["receipt"]}, nil
	}
	if row["state"] != "prepared" {
		return h.reconcile(ctx, l, row)
	}
	if integer(row["expiresAt"]) <= time.Now().UnixMilli() {
		return nil, connectionFailure("capsule_work_preview_expired")
	}
	h.mu.Lock()
	if old := h.flights[id]; old != nil {
		h.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-old.done:
			return old.result, old.err
		}
	}
	flight := &capsuleWorkFlight{done: make(chan struct{})}
	h.flights[id] = flight
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		flight.result, flight.err = result, err
		delete(h.flights, id)
		close(flight.done)
		h.mu.Unlock()
	}()
	payload, e := connectionObject([]byte(text(row["payloadJson"])))
	if e != nil || identity.Digest([]byte(text(row["payloadJson"]))) != row["payloadHash"] {
		return nil, connectionFailure("capsule_work_original_changed")
	}
	e = l.update(ctx, capsuleWorkKey(l, id), func(old map[string]any) (map[string]any, error) {
		if !connectionEqual(old, row) {
			return nil, connectionFailure("capsule_work_original_changed")
		}
		next := identityClone(row)
		next["state"] = "authorizing"
		return next, nil
	})
	if e != nil {
		return nil, e
	}
	row["state"] = "authorizing"
	action := "capsule.use"
	if row["action"] == "publish" {
		action = "capsule.publish"
	}
	_, e = h.runtime.AuthorizeReviewed(ctx, map[string]any{"requestId": row["consentRequestId"], "action": action, "objectId": payload["id"], "payloadJson": row["payloadJson"], "visibility": row["visibility"], "viewers": row["viewers"]}, &l.scope)
	if e == nil {
		e = h.check(ctx, l)
	}
	if e == nil {
		row["state"] = "sending"
		e = h.save(ctx, l, row)
	}
	if e == nil {
		path := "/v2/capsules/uses"
		if row["action"] == "publish" {
			path = "/v2/capsules/events"
		}
		_, e = h.read(ctx, l, path, map[string]any{"consentId": row["consentRequestId"], "payloadJson": row["payloadJson"]})
	}
	if e != nil {
		if changed := h.check(ctx, l); changed != nil {
			return nil, changed
		}
		row["state"] = "unknown"
		if save := h.save(ctx, l, row); save != nil {
			return nil, save
		}
		if receipt, readErr := h.reconcile(ctx, l, row); readErr == nil {
			return receipt, nil
		}
		return nil, e
	}
	return h.reconcile(ctx, l, row)
}
func (h *NativeCapsuleWork) Call(ctx context.Context, name string, input any) (any, error) {
	x, e := workPurposeNormalize(name, input)
	if e != nil {
		return nil, e
	}
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	switch name {
	case "galaxy_capsule_work_sources":
		return h.sources(ctx, l, x)
	case "galaxy_capsule_work_read":
		return h.work(ctx, l, x)
	case "galaxy_capsule_work_application":
		return h.originalApplication(ctx, l, x)
	case "galaxy_capsule_work_prepare":
		return h.prepare(ctx, l, x)
	case "galaxy_capsule_work_status":
		return h.status(ctx, l, text(x["handle"]))
	case "galaxy_capsule_work_pending":
		return h.pending(ctx, l)
	}
	return nil, remoteFactsInvalid()
}
func registerNativeCapsuleWorkTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) func() {
	h := NewNativeCapsuleWork(runtime)
	contracts := workPurposeContracts()
	for name, raw := range contracts {
		if len(name) < 20 || name[:20] != "galaxy_capsule_work_" {
			continue
		}
		contract := uploadObject(raw)
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, Description: text(contract["description"]), InputSchema: contract["schema"], Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "capsule_work_unavailable", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, e := connectionObject(req.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			failure := func(e error) (*mcp.CallToolResult, error) {
				result, encoding := toolResult(map[string]any{"error": runtimeErrorCode(e), "reconcileOriginal": write})
				if result != nil {
					result.IsError = true
				}
				return result, encoding
			}
			if name == "galaxy_capsule_work_execute" {
				preview, e := h.Preview(ctx, text(input["handle"]))
				if e != nil {
					return failure(e)
				}
				if preview["state"] != "prepared" {
					value, e := h.Call(ctx, "galaxy_capsule_work_status", input)
					if e != nil {
						return failure(e)
					}
					return toolResult(value)
				}
				value := map[string]any{"handle": input["handle"], "preview": preview}
				return tools.review(ctx, req, value, "请本人核对所选方法用途、当前工作与精确结果、资料版本、许可证、可见范围和原操作。引用或阅读不代表成功复用。\n"+hostJSONString(value), func(scope *ChoiceScope) (any, error) { return h.ExecuteReviewed(ctx, text(input["handle"]), scope) })
			}
			out, e := h.Call(ctx, name, input)
			if e != nil {
				return failure(e)
			}
			return toolResult(out)
		})
	}
	return h.Close
}
