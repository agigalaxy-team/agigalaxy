package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/choices"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"sort"
)

// NativeExtendedServices consumes the remaining original fixed HTTP adapters.
// Existing Runtime owns every credential, endpoint, scope and uncertain POST.
type NativeExtendedServices struct{ runtime *Runtime }

func NewNativeExtendedServices(r *Runtime) *NativeExtendedServices {
	return &NativeExtendedServices{runtime: r}
}
func remoteExtendedContracts() map[string]any {
	var out map[string]any
	_ = protocol.Decode([]byte(remoteExtendedContractsJSON), &out)
	return out
}

var remoteExtendedPaths = map[string]string{
	"galaxy_discovery_v2_query": "/v2/discovery/query", "galaxy_discovery_v2_detail": "/v2/discovery/detail", "galaxy_search_v2_query": "/v2/search/query", "galaxy_search_v2_reference": "/v2/search/reference",
	"galaxy_choice_preferences": "/v2/choice-snapshots/preferences/read", "galaxy_choice_preferences_save": "/v2/choice-snapshots/preferences/save", "galaxy_choice_put": "/v2/choice-snapshots/put", "galaxy_choice_get": "/v2/choice-snapshots/get", "galaxy_choice_receipt": "/v2/choice-snapshots/receipt", "galaxy_choice_list": "/v2/choice-snapshots/list", "galaxy_choice_delete": "/v2/choice-snapshots/delete",
	"galaxy_builder_support_read": "/v2/builders/support/read", "galaxy_builder_support_publish": "/v2/builders/support/events", "galaxy_builder_pack_export": "/v2/builders/pack/export", "galaxy_builder_read": "/v1/builders/read", "galaxy_builder_owned": "/v1/builders/owned/query", "galaxy_builder_receipt": "/v1/builders/events/receipt", "galaxy_builder_notices": "/v1/builders/notices/query",
	"galaxy_worker_pack_manifest": "/v2/builders/pack/manifest", "galaxy_worker_pack_candidates": "/v2/builders/pack-uses/candidates", "galaxy_worker_pack_use_record": "/v2/builders/pack-uses/events", "galaxy_worker_pack_use_read": "/v2/builders/pack-uses/read", "galaxy_worker_pack_uses": "/v2/builders/pack-uses/query", "galaxy_worker_pack_use_receipt": "/v2/builders/pack-uses/receipt",
	"galaxy_attachment_config": "/v2/chat/attachments/config", "galaxy_attachment_read": "/v2/chat/attachments/read", "galaxy_attachment_owned": "/v2/chat/attachments/query", "galaxy_attachment_revoke": "/v2/chat/attachments/revoke",
	"galaxy_target_governance_config": "/v2/target-governance/config", "galaxy_target_governance_target": "/v2/target-governance/target", "galaxy_target_governance_query": "/v2/target-governance/query", "galaxy_target_governance_report": "/v2/target-governance/reports", "galaxy_target_governance_event": "/v2/target-governance/events", "galaxy_target_governance_receipt": "/v2/target-governance/receipt",
	"galaxy_moderation_config": "/v1/moderation/config", "galaxy_moderation_query": "/v1/moderation/reports/query", "galaxy_moderation_report": "/v1/moderation/reports",
	"galaxy_bookmarks": "/v2/reading-bookmarks/query", "galaxy_bookmark_status": "/v2/reading-bookmarks/status", "galaxy_bookmark_command": "/v2/reading-bookmarks/command", "galaxy_bookmark_receipt": "/v2/reading-bookmarks/receipt",
}
var remoteChoiceActions = map[string]string{"galaxy_choice_preferences": "preferences/read", "galaxy_choice_preferences_save": "preferences/save", "galaxy_choice_put": "put", "galaxy_choice_get": "get", "galaxy_choice_receipt": "receipt", "galaxy_choice_list": "list", "galaxy_choice_delete": "delete"}

func remoteExtendedNormalize(name string, input any) (map[string]any, error) {
	contract := uploadObject(remoteExtendedContracts()[name])
	if contract == nil {
		return nil, remoteFactsInvalid()
	}
	raw, e := jstext.EncodeJSON(input)
	if e != nil {
		return nil, e
	}
	parsed, e := jstext.DecodeJSON(raw)
	value := uploadObject(parsed)
	if e != nil || value == nil {
		return nil, remoteFactsInvalid()
	}
	switch name {
	case "galaxy_discovery_v2_query":
		value, e = opportunities.ParseQuery(value)
	case "galaxy_discovery_v2_detail":
		value, e = opportunities.ParseDetail(value)
	case "galaxy_search_v2_query":
		value, e = searchv2.ParseQuery(raw)
	case "galaxy_search_v2_reference":
		value, e = searchv2.ParseReference(raw)
	default:
		if action := remoteChoiceActions[name]; action != "" {
			value, e = choices.Parse(action, value)
		} else {
			remoteDefaults(uploadObject(contract["schema"]), value)
		}
	}
	if e != nil {
		return nil, e
	}
	if name == "galaxy_moderation_query" && value["caseId"] != nil && value["assistanceId"] != nil {
		return nil, remoteFactsInvalid()
	}
	if remoteChatValidate(uploadObject(contract["schema"]), value) != nil {
		return nil, remoteFactsInvalid()
	}
	return value, nil
}
func (c *NativeExtendedServices) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	scope, e := c.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	return c.call(ctx, name, input, &scope)
}
func (c *NativeExtendedServices) call(ctx context.Context, name string, input any, scope *ChoiceScope) (map[string]any, error) {
	value, e := remoteExtendedNormalize(name, input)
	if e != nil {
		return nil, e
	}
	path := remoteExtendedPaths[name]
	options := ConnectionCallOptions{ExpectedScope: scope}
	switch name {
	case "galaxy_target_governance_config":
		options.Method = "GET"
		value = nil
	case "galaxy_target_governance_get":
		path = "/v2/target-governance/" + text(value["reportId"])
		options.Method = "GET"
		value = nil
	case "galaxy_moderation_get":
		path = "/v1/moderation/reports/" + text(value["reportId"]) + "/read"
		value = map[string]any{}
	case "galaxy_moderation_event":
		path = "/v1/moderation/reports/" + text(value["reportId"]) + "/events"
		delete(value, "reportId")
	case "galaxy_moderation_receipt":
		path = "/v1/moderation/reports/" + text(value["reportId"]) + "/receipt"
		delete(value, "reportId")
	}
	if path == "" {
		return nil, remoteFactsInvalid()
	}
	return c.runtime.Call(ctx, path, value, options)
}
func registerExtendedRemoteTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeExtendedServices(runtime)
	contracts := remoteExtendedContracts()
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := uploadObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, Description: text(contract["description"]), InputSchema: contract["schema"], Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "native_remote_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, e := jstext.DecodeJSON(req.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			if isOne(name, "galaxy_choice_preferences_save", "galaxy_choice_delete") {
				operation, cancel, l, e := runtime.identityLease(ctx, true)
				if e != nil {
					return toolError(e)
				}
				defer cancel()
				value := map[string]any{"input": input, "authorizationContext": map[string]any{"subjectId": l.scope.Owner, "endpoint": l.scope.Endpoint, "bindingId": l.connection.bindingID, "generation": l.connection.generation}}
				return tools.review(operation, req, value, "请本人核对所选私有选择快照及服务范围；不会从摘要选择推断授权，也不扩大所选ID。\n"+hostJSONString(value), func(scope *ChoiceScope) (any, error) {
					if scope == nil || *scope != l.scope {
						return nil, connectionFailure("native_choice_binding_changed")
					}
					if e := l.check(operation); e != nil {
						return nil, e
					}
					return client.call(operation, name, input, &l.scope)
				})
			}
			out, e := client.Call(ctx, name, input)
			if e != nil {
				result, encoding := toolResult(map[string]any{"error": runtimeErrorCode(e), "mayNeedReceiptReconciliation": write})
				if result != nil {
					result.IsError = true
				}
				return result, encoding
			}
			return toolResult(out)
		})
	}
}
