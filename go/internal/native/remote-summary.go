package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"math/big"
	"sort"
	"strings"
)

type NativeSharedSummaries struct{ runtime *Runtime }

func NewNativeSharedSummaries(runtime *Runtime) *NativeSharedSummaries {
	return &NativeSharedSummaries{runtime}
}
func remoteSummaryContracts() map[string]any {
	var value map[string]any
	_ = protocol.Decode([]byte(remoteSummaryContractsJSON), &value)
	return value
}

type nativeSummaryRef struct {
	MessageID string `json:"messageId"`
	Revision  int64  `json:"revision"`
}
type nativeSummaryContent struct {
	Generator struct {
		Kind  string  `json:"kind"`
		Label *string `json:"label,omitempty"`
	} `json:"generator"`
	Coverage struct {
		From     string `json:"fromSequence"`
		Through  string `json:"throughSequence"`
		Complete bool   `json:"complete"`
	} `json:"coverage"`
	Fragments []struct {
		ID         string             `json:"id"`
		Kind       string             `json:"kind"`
		Text       string             `json:"text"`
		SourceRefs []nativeSummaryRef `json:"sourceRefs"`
	} `json:"fragments"`
	KeyRefs []nativeSummaryRef `json:"keyMessageRefs"`
}

func remoteSummaryNormalize(name string, input any) (map[string]any, error) {
	contract := uploadObject(remoteSummaryContracts()[name])
	if contract == nil {
		return nil, remoteFactsInvalid()
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, remoteFactsInvalid()
	}
	schema := uploadObject(contract["schema"])
	remoteDefaults(schema, value)
	if remoteChatValidate(schema, value) != nil {
		return nil, remoteFactsInvalid()
	}
	if name == "galaxy_inbox_query" {
		if after, present := value["after"]; present {
			parts := strings.SplitN(text(after), ":", 2)
			if len(parts) != 2 || remoteChatValidate(uploadObject(materialUUID()), parts[1]) != nil {
				return nil, remoteFactsInvalid()
			}
		}
	}
	if name == "galaxy_chat_shared_summary_publish" {
		content := uploadObject(value["content"])
		coverage := uploadObject(content["coverage"])
		from, ok1 := new(big.Int).SetString(text(coverage["fromSequence"]), 10)
		through, ok2 := new(big.Int).SetString(text(coverage["throughSequence"]), 10)
		if !ok1 || !ok2 || from.Cmp(through) > 0 {
			return nil, remoteFactsInvalid()
		}
		fragments := uploadRows(content["fragments"])
		if len(fragments) == 0 && len(uploadRows(content["keyMessageRefs"])) == 0 {
			return nil, remoteFactsInvalid()
		}
		seen := map[string]bool{}
		for _, value := range fragments {
			fragment := uploadObject(value)
			id := text(fragment["id"])
			if seen[id] || fragment["kind"] == "derived" && len(uploadRows(fragment["sourceRefs"])) == 0 {
				return nil, remoteFactsInvalid()
			}
			seen[id] = true
		}
		raw, e := protocol.Encode(content)
		if e != nil {
			return nil, e
		}
		var ordered nativeSummaryContent
		if protocol.Decode(raw, &ordered) != nil {
			return nil, remoteFactsInvalid()
		}
		raw, e = localdata.Encode(ordered)
		if e != nil || len(raw) > 65536 {
			return nil, remoteFactsInvalid()
		}
	}
	return value, nil
}
func remoteSummaryCall(ctx context.Context, runtime *Runtime, name string, input any, expected *ChoiceScope) (map[string]any, error) {
	value, e := remoteSummaryNormalize(name, input)
	if e != nil {
		return nil, e
	}
	scope, e := runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	if expected != nil && scope != *expected {
		return nil, fault.New("native_choice_binding_changed", 409)
	}
	mapping := map[string]string{"galaxy_chat_shared_summary_publish": "/v2/chat/shared-summaries/publish", "galaxy_chat_shared_summary_get": "/v2/chat/shared-summaries/get", "galaxy_chat_shared_summary_receipt": "/v2/chat/shared-summaries/receipt", "galaxy_chat_shared_summary_list": "/v2/chat/shared-summaries/list", "galaxy_chat_shared_summary_retract": "/v2/chat/shared-summaries/retract", "galaxy_inbox_query": "/v2/notifications/query", "galaxy_inbox_options": "/v2/notifications/options/read", "galaxy_inbox_options_save": "/v2/notifications/options/save"}
	path := mapping[name]
	if path == "" {
		return nil, remoteFactsInvalid()
	}
	return runtime.Call(ctx, path, value, ConnectionCallOptions{ExpectedScope: &scope})
}
func (c *NativeSharedSummaries) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	if !strings.HasPrefix(name, "galaxy_chat_shared_summary_") {
		return nil, remoteFactsInvalid()
	}
	return remoteSummaryCall(ctx, c.runtime, name, input, nil)
}
func registerRemoteSummaryTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	registerRemoteSummaryDomainTools(server, tools, runtime, func(name string) bool { return strings.HasPrefix(name, "galaxy_chat_shared_summary_") })
}
func registerRemoteSummaryDomainTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime, selected func(string) bool) {
	contracts := remoteSummaryContracts()
	names := []string{}
	for name := range contracts {
		if selected(name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		contract := uploadObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: contract["schema"], Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "native_remote_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var input map[string]any
			if protocol.Decode(request.Params.Arguments, &input) != nil {
				return toolError(remoteFactsInvalid())
			}
			if name == "galaxy_inbox_options_save" {
				normalized, e := remoteSummaryNormalize(name, input)
				if e != nil {
					return toolError(e)
				}
				raw, e := protocol.Encode(normalized)
				if e != nil {
					return toolError(e)
				}
				return tools.review(ctx, request, normalized, "本人确认所示收件箱静音或阻止范围。不会撤销原公开事实，不标记本人已读，也不启动系统提醒或模型。\n"+string(raw), func(scope *ChoiceScope) (any, error) { return remoteSummaryCall(ctx, runtime, name, normalized, scope) })
			}
			value, e := remoteSummaryCall(ctx, runtime, name, input, nil)
			if e != nil {
				result, encodeError := toolResult(map[string]any{"error": runtimeErrorCode(e), "mayNeedReceiptReconciliation": write})
				if result != nil {
					result.IsError = true
				}
				return result, encodeError
			}
			return toolResult(value)
		})
	}
}
