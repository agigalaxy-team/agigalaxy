package native

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func registerNativeAuthorizationTool(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_authorize", InputSchema: nativeAuthorizationContracts()["input"], Description: "Authorize only the exact reviewed payload/scope using the local device. Preserve requestId and bytes after missing ACK. Existing saved authorization retries do not ask again.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "native_authorization_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input map[string]any
		if e := protocol.Decode(request.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		normalized, e := nativeAuthorizationNormalize(input)
		if e != nil {
			return toolError(e)
		}
		exists, e := runtime.AuthorizationExists(ctx, normalized)
		if e != nil {
			return toolError(e)
		}
		if exists {
			value, e := runtime.AuthorizeReviewed(ctx, normalized, nil)
			if e != nil {
				result, encodeError := toolResult(map[string]any{"error": runtimeErrorCode(e), "requestId": normalized["requestId"], "reconcileOriginal": true})
				if result != nil {
					result.IsError = true
				}
				return result, encodeError
			}
			return toolResult(value)
		}
		raw, e := protocol.Encode(normalized)
		if e != nil {
			return toolError(e)
		}
		return tools.review(ctx, request, normalized, fmt.Sprintf("本人确认仅授权所示准确材料、对象、动作、接收范围和期限。\n%s\n保留原requestId与payloadJson字节；不自动执行业务发布。未知结果先查询原同意回执，不新编号或重签。", raw), func(scope *ChoiceScope) (any, error) { return runtime.AuthorizeReviewed(ctx, normalized, scope) })
	})
}
