package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"sort"
)

func registerRemoteChatTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	chat := NewNativeChat(runtime)
	contracts := remoteChatContracts()
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := uploadObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: remoteChatInputSchema(name, uploadObject(contract["schema"])), Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "native_chat_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var input map[string]any
			if e := protocol.Decode(request.Params.Arguments, &input); e != nil {
				return toolError(e)
			}
			normalized, e := remoteChatNormalize(name, input)
			if e != nil {
				return toolError(e)
			}
			if remoteChatChoice(name) {
				captured, e := tools.store.ChoiceScope(ctx)
				if e != nil {
					return toolError(e)
				}
				preview := map[string]any{"input": normalized, "galaxyId": captured.Owner}
				room := map[string]any{}
				if roomID := text(normalized["roomId"]); roomID != "" {
					room, e = chat.Call(ctx, "galaxy_chat_room", map[string]any{"roomId": roomID}, &captured)
					if e != nil && name == "galaxy_chat_agent_grant" {
						return toolError(e)
					}
					if e == nil {
						preview["reviewRoom"] = map[string]any{"roomId": roomID, "title": room["title"]}
					}
				}
				return tools.review(ctx, request, preview, chatChoiceMessage(name, normalized, room), func(ctx context.Context, scope *ChoiceScope) (any, error) {
					if scope == nil || *scope != captured {
						return nil, fault.New("native_choice_binding_changed", 409)
					}
					return chat.Call(ctx, name, normalized, scope)
				})
			}
			value, e := chat.Call(ctx, name, normalized, nil)
			if e != nil {
				result, encodeError := toolResult(map[string]any{"error": runtimeErrorCode(e), "mayNeedReceiptReconciliation": write && nativeOutcomeUnknown(e)})
				if result != nil {
					result.IsError = true
				}
				return result, encodeError
			}
			return toolResult(value)
		})
	}
}
