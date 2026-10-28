package native

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func nativeAccountResult(value any, e error) (*mcp.CallToolResult, error) {
	if e == nil {
		return toolResult(value)
	}
	result, encodeError := toolResult(map[string]any{"error": runtimeErrorCode(e), "originalOperationRetained": true})
	if result != nil {
		result.IsError = true
	}
	return result, encodeError
}
func registerNativeIdentityAccountTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	accounts := NewNativeIdentityAccounts(runtime)
	id := materialUUID()
	action := func(value string) any { return map[string]any{"const": value} }
	reads := map[string]any{"type": "object", "oneOf": []any{objectSchema(map[string]any{"action": action("providers")}, "action"), objectSchema(map[string]any{"action": action("begin"), "providerId": map[string]any{"type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"}}, "action", "providerId"), objectSchema(map[string]any{"action": map[string]any{"type": "string", "enum": []string{"status", "cancel"}}, "id": id}, "action", "id"), objectSchema(map[string]any{"action": action("query"), "id": id, "after": id, "limit": integerSchema(1, 100, 20)}, "action")}}
	addNativeTool(server, &mcp.Tool{Name: "galaxy_identity_account_read", InputSchema: reads, Description: "Use this installed local plugin to read configured official-account providers, begin the existing OIDC login, read its exact status or this identity’s existing links, or cancel a pending login. Login alone never associates the ID. Keep the returned loginId; never invent a provider, identity or replacement login after an unknown result.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "native_account_link_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input NativeIdentityAccountRead
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return nativeAccountResult(nil, e)
		}
		result, e := accounts.Read(ctx, input)
		return nativeAccountResult(result, e)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_identity_account_prepare", InputSchema: objectSchema(map[string]any{"action": map[string]any{"type": "string", "enum": []string{"link", "unlink"}}, "id": id}, "action", "id"), Description: "Prepare the exact existing OIDC account association or unlink preview for this current local identity. Return the verified account, issuer and Galaxy ID for actual user review. Does not sign or associate.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "native_account_link_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			Action string `json:"action"`
			ID     string `json:"id"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return nativeAccountResult(nil, e)
		}
		result, e := accounts.Prepare(ctx, input.Action, input.ID)
		return nativeAccountResult(result, e)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_identity_account_execute", InputSchema: objectSchema(map[string]any{"previewId": id}, "previewId"), Description: "Ask the actual user in the host form or temporary local review page to approve the shown official account and Galaxy ID, then sign the existing OIDC intent with this current Native control device. A model-provided confirmed field is never accepted. Reconcile an unknown original result before any exact-byte retry.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "native_account_link_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			PreviewID string `json:"previewId"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return nativeAccountResult(nil, e)
		}
		if result, handled, e := accounts.ResumePreview(ctx, input.PreviewID); e != nil || handled {
			return nativeAccountResult(result, e)
		}
		preview, e := accounts.Preview(ctx, input.PreviewID)
		if e != nil {
			return nativeAccountResult(nil, e)
		}
		raw, e := protocol.Encode(preview)
		if e != nil {
			return nativeAccountResult(nil, e)
		}
		return tools.review(ctx, req, preview, fmt.Sprintf("本人确认准确官方账户与银河ID的现有关联操作：\n%s\n登录本身不建立关联；仅以当前控制设备签署已显示的原意图，不授予新的银河API权限。", raw), func(scope *ChoiceScope) (any, error) { return accounts.ExecuteReviewed(ctx, input.PreviewID, scope) })
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_identity_account_recover", InputSchema: objectSchema(map[string]any{"id": id}), Description: "Recover this local identity’s original already approved account operation. Omit id to list retained unfinished operations. Read the server’s durable association first; retry only the exact saved signed bytes on the same current binding, without a new login, ID or signature. Keys, bearers and signed packets are not returned.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "native_account_link_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			ID string `json:"id,omitempty"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return nativeAccountResult(nil, e)
		}
		result, e := accounts.Recover(ctx, input.ID)
		return nativeAccountResult(result, e)
	})
}
