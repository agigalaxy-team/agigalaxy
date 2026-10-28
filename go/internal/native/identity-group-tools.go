package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"sort"
)

func registerNativeIdentityGroupTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) func() {
	host := NewNativeIdentityGroupOperations(runtime)
	var contracts map[string]any
	_ = protocol.Decode([]byte(nativeIdentityGroupContractsJSON), &contracts)
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := uploadObject(contracts[name])
		addNativeTool(server, &mcp.Tool{Name: name, Description: text(contract["description"]), InputSchema: contract["schema"], Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "invalid_identity_group", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			value, decodeError := jstext.DecodeJSON(req.Params.Arguments)
			input := uploadObject(value)
			if decodeError != nil || input == nil {
				return toolError(remoteFactsInvalid())
			}
			failed := func(e error) (*mcp.CallToolResult, error) {
				out, encoding := toolResult(map[string]any{"error": runtimeErrorCode(e), "originalOperationRetained": true})
				if out != nil {
					out.IsError = true
				}
				return out, encoding
			}
			if name == "galaxy_identity_group_native_execute" {
				preview, e := host.Preview(ctx, text(input["previewId"]))
				if e != nil {
					return failed(e)
				}
				if uploadObject(preview)["state"] != nil {
					return toolResult(preview)
				}
				message := "请本人核对完整身份显示关系：受影响的原身份、原资料引用及哈希、更正、接收人、可见范围与当前设备。原ID、事实作者、权限、配额及能力不合并。\n" + hostJSONString(preview)
				return tools.review(ctx, req, preview, message, func(scope *ChoiceScope) (any, error) {
					return host.ExecuteReviewed(ctx, text(input["previewId"]), scope)
				})
			}
			var out any
			var e error
			switch name {
			case "galaxy_identity_group_native_prepare":
				out, e = host.Prepare(ctx, input)
			case "galaxy_identity_group_native_cancel_preview":
				out, e = host.CancelPreview(ctx, text(input["previewId"]))
			case "galaxy_identity_group_native_recover":
				out, e = host.Recover(ctx, text(input["action"]), text(input["proofId"]))
			default:
				e = remoteFactsInvalid()
			}
			if e != nil {
				return failed(e)
			}
			return toolResult(out)
		})
	}
	return host.Close
}
