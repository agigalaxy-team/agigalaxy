package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"sort"
	"strings"
)

var personalSummaryPaths = map[string]string{"galaxy_personal_summary_preferences": "preferences/read", "galaxy_personal_summary_preferences_save": "preferences/save", "galaxy_personal_summary_put": "put", "galaxy_personal_summary_get": "get", "galaxy_personal_summary_receipt": "receipt", "galaxy_personal_summary_list": "list", "galaxy_personal_summary_sources": "sources", "galaxy_personal_summary_delete": "delete"}

func psNormalize(name string, input any) (map[string]any, error) {
	contract := psObject(psContracts()[name])
	if contract == nil {
		return nil, fault.New("invalid_personal_summary_request", 400)
	}
	raw, e := jstext.EncodeJSON(input)
	if e != nil {
		return nil, e
	}
	v, e := jstext.DecodeJSON(raw)
	value := psObject(v)
	if e != nil || value == nil {
		return nil, fault.New("invalid_personal_summary_request", 400)
	}
	schema := psObject(contract["schema"])
	remoteDefaults(schema, value)
	if remoteChatValidate(schema, value) != nil {
		return nil, fault.New("invalid_personal_summary_request", 400)
	}
	if value["content"] != nil {
		content, e := psContent(value["content"])
		if e != nil {
			return nil, e
		}
		value["content"] = content
	}
	return value, nil
}
func (h *NativePersonalSummaries) RemoteCall(ctx context.Context, name string, input any) (map[string]any, error) {
	return h.remoteCall(ctx, name, input, nil)
}
func (h *NativePersonalSummaries) remoteCall(ctx context.Context, name string, input any, expected *ChoiceScope) (map[string]any, error) {
	h.mu.Lock()
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return nil, connectionFailure("native_runtime_closed")
	}
	value, e := psNormalize(name, input)
	if e != nil {
		return nil, e
	}
	path := personalSummaryPaths[name]
	if path == "" {
		return nil, fault.New("invalid_personal_summary_request", 400)
	}
	if expected == nil {
		scope, e := h.runtime.store.ChoiceScope(ctx)
		if e != nil {
			return nil, e
		}
		expected = &scope
	}
	return h.runtime.Call(ctx, "/v2/personal-summaries/"+path, value, ConnectionCallOptions{ExpectedScope: expected})
}
func (h *NativePersonalSummaries) localCall(ctx context.Context, l *personalSummaryLease, name string, input map[string]any, scope *ChoiceScope) (any, error) {
	if e := l.check(ctx, false); e != nil {
		return nil, e
	}
	switch name {
	case "galaxy_summary_local_save":
		return h.save(ctx, l, input)
	case "galaxy_summary_local_get":
		return h.get(ctx, l, text(input["summaryId"]))
	case "galaxy_summary_local_list":
		return h.list(ctx, l)
	case "galaxy_summary_local_status":
		return h.status(ctx, l)
	case "galaxy_summary_sync_choice":
		return h.choose(ctx, l, input, scope)
	}
	h.syncMu.Lock()
	defer h.syncMu.Unlock()
	switch name {
	case "galaxy_summary_sync":
		return h.synchronize(ctx, l, false)
	case "galaxy_summary_sync_reconcile":
		return h.reconcile(ctx, l, text(input["summaryId"]), text(input["versionId"]))
	case "galaxy_summary_binding_refresh":
		return h.onBinding(ctx, l)
	case "galaxy_summary_sync_pull":
		return h.pull(ctx, l, text(input["summaryId"]))
	case "galaxy_summary_sync_resolve":
		return h.resolve(ctx, l, input, scope)
	case "galaxy_summary_cloud_delete":
		return h.deleteCloud(ctx, l, text(input["summaryId"]), scope)
	}
	return nil, fault.New("invalid_personal_summary_request", 400)
}
func (h *NativePersonalSummaries) LocalCall(ctx context.Context, name string, input any, scope *ChoiceScope) (any, error) {
	value, e := psNormalize(name, input)
	if e != nil {
		return nil, e
	}
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	return h.localCall(ctx, l, name, value, scope)
}
func (l *personalSummaryLease) reviewContext() map[string]any {
	var binding, generation any
	if l.connection != nil {
		binding = l.connection.BindingID
		generation = l.connection.Generation
	}
	return map[string]any{"subjectId": l.scope.Owner, "endpoint": l.scope.Endpoint, "bindingId": binding, "generation": generation}
}
func (l *personalSummaryLease) reviewCheck(ctx context.Context) error {
	if e := l.check(ctx, false); e != nil {
		return e
	}
	if l.connection != nil {
		return l.check(ctx, true)
	}
	now, e := l.host.runtime.connection.Snapshot(ctx)
	if e != nil {
		return e
	}
	if now != nil {
		return connectionFailure("summary_binding_changed")
	}
	return nil
}
func registerPersonalSummaryTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) func() {
	h := runtime.personalSummaries
	contracts := psContracts()
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := psObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: contract["schema"], Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "invalid_personal_summary_request", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, e := jstext.DecodeJSON(req.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			if strings.HasPrefix(name, "galaxy_personal_summary_") {
				if isOne(name, "galaxy_personal_summary_preferences_save", "galaxy_personal_summary_delete") {
					operation, cancel, l, e := h.begin(ctx)
					if e != nil {
						return toolError(e)
					}
					defer cancel()
					review := map[string]any{"input": input, "authorizationContext": l.reviewContext()}
					return tools.review(operation, req, review, "请本人核对这次私有摘要云端选择或删除的准确范围；本机笔记与房间分享保持各自原有权限。\n"+hostJSONString(review), func(scope *ChoiceScope) (any, error) {
						if scope == nil || *scope != l.scope {
							return nil, connectionFailure("summary_binding_changed")
						}
						if e := l.reviewCheck(operation); e != nil {
							return nil, e
						}
						return h.remoteCall(operation, name, input, &l.scope)
					})
				}
				out, e := h.RemoteCall(ctx, name, input)
				if e != nil {
					return toolError(e)
				}
				return toolResult(out)
			}
			value, e := psNormalize(name, input)
			if e != nil {
				return toolError(e)
			}
			if isOne(name, "galaxy_summary_sync_choice", "galaxy_summary_sync_resolve", "galaxy_summary_cloud_delete") {
				operation, cancel, l, e := h.begin(ctx)
				if e != nil {
					return toolError(e)
				}
				defer cancel()
				review := map[string]any{"input": value, "authorizationContext": l.reviewContext()}
				message := "请本人核对个人摘要的所选服务、房间范围和内容。私有云副本与房间分享分开；不会启动模型、读取整段聊天或扩大原资料权限。\n" + hostJSONString(review)
				return tools.review(operation, req, review, message, func(scope *ChoiceScope) (any, error) {
					if e := l.reviewCheck(operation); e != nil {
						return nil, e
					}
					return h.localCall(operation, l, name, value, scope)
				})
			}
			out, e := h.LocalCall(ctx, name, value, nil)
			if e != nil {
				return toolError(e)
			}
			return toolResult(out)
		})
	}
	return h.Close
}

// PersonalSummaryOnBinding restores only this owner's recorded summary choice.
// It shares the same queue owner as tools and never infers an unset opt-in.
func (r *Runtime) PersonalSummaryOnBinding(ctx context.Context) (map[string]any, error) {
	return r.personalSummaries.OnBinding(ctx)
}
