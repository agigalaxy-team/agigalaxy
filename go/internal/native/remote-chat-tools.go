package native

import (
	"context"
	"fmt"
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
				if name == "galaxy_chat_agent_grant" {
					room, e := chat.Call(ctx, "galaxy_chat_room", map[string]any{"roomId": normalized["roomId"]}, &captured)
					if e != nil {
						return toolError(e)
					}
					preview["reviewRoom"] = map[string]any{"roomId": normalized["roomId"], "title": room["title"]}
				}
				raw, e := protocol.Encode(preview)
				if e != nil {
					return toolError(e)
				}
				return tools.review(ctx, request, preview, fmt.Sprintf("本人确认准确的聊天操作 %s。\n%s\n仅采用所示房间、对象、选择与期限；不启动宿主模型。结果不明保留原操作标识，只核对原回执。", name, raw), func(scope *ChoiceScope) (any, error) {
					if scope == nil || *scope != captured {
						return nil, fault.New("native_choice_binding_changed", 409)
					}
					return chat.Call(ctx, name, normalized, scope)
				})
			}
			value, e := chat.Call(ctx, name, normalized, nil)
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
