package native

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func registerNativeHandoffTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	runtime.mu.Lock()
	handoff := runtime.deviceHandoff
	if handoff == nil {
		handoff = NewNativeDeviceHandoff(runtime)
		runtime.deviceHandoff = handoff
	}
	runtime.mu.Unlock()
	addNativeTool(server, &mcp.Tool{Name: "galaxy_device_pending", Description: "Read public pending device handoff packets, not private keys or recovery codes.", InputSchema: objectSchema(map[string]any{}), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "device_handoff_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		value, e := handoff.Pending(ctx)
		return materialToolResult(value, e)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_device_offer", Description: "Prepare a public device request for an existing identity. The old device must approve; this does not sign in by email.", InputSchema: objectSchema(map[string]any{"subjectId": map[string]any{"type": "string", "pattern": "^GUID[0-9A-Z]{28}$"}}, "subjectId"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "device_handoff_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			SubjectID string `json:"subjectId"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		scope, e := runtime.store.ChoiceScope(ctx)
		if e != nil {
			return toolError(e)
		}
		return tools.review(ctx, req, input, fmt.Sprintf("为现有银河身份 %s 在本机创建一个新的设备公钥请求。\n原身份ID不变，原控制设备必须另行批准；不通过邮件登录，不连接服务，不恢复或上传资料。私钥只保存在本机，不出现在转移包中。", input.SubjectID), func(ctx context.Context, current *ChoiceScope) (any, error) {
			if *current != scope {
				return nil, connectionFailure("device_handoff_owner_changed")
			}
			return handoff.OfferReviewed(ctx, input.SubjectID, current)
		})
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_device_approve", Description: "Approve this exact public new-device offer on a currently controlling device. Never paste private key or recovery seed.", InputSchema: objectSchema(map[string]any{"offer": materialString(1, 24000)}, "offer"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "device_handoff_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			Offer string `json:"offer"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		preview, scope, e := handoff.PreviewOffer(ctx, input.Offer)
		if e != nil {
			return toolError(e)
		}
		review := map[string]any{"offer": input.Offer, "preview": preview}
		return tools.review(ctx, req, review, "允许下列新设备使用此银河身份。当前设备和资料保留。", func(ctx context.Context, current *ChoiceScope) (any, error) {
			if *scope != *current {
				return nil, connectionFailure("device_handoff_owner_changed")
			}
			return handoff.ApproveReviewed(ctx, input.Offer, current)
		})
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_device_accept", Description: "On the requesting device, verify public old-device approval and prove possession. Connect is a separate choice.", InputSchema: objectSchema(map[string]any{"approval": materialString(1, 24000)}, "approval"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "device_handoff_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			Approval string `json:"approval"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		preview, scope, e := handoff.PreviewApproval(ctx, input.Approval)
		if e != nil {
			return toolError(e)
		}
		review := map[string]any{"approval": input.Approval, "preview": preview}
		return tools.review(ctx, req, review, "在这台设备上接续下列银河身份。", func(ctx context.Context, current *ChoiceScope) (any, error) {
			if *scope != *current {
				return nil, connectionFailure("device_handoff_owner_changed")
			}
			return handoff.AcceptReviewed(ctx, input.Approval, current)
		})
	})
	operation := objectSchema(map[string]any{"operationId": materialUUID()}, "operationId")
	addNativeTool(server, &mcp.Tool{Name: "galaxy_device_reconcile", Description: "Check the original device handoff after unknown delivery.", InputSchema: operation, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "device_handoff_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			OperationID string `json:"operationId"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		value, e := handoff.Reconcile(ctx, input.OperationID)
		return materialToolResult(value, e)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_device_cancel", Description: "Cancel this device’s original pending handoff. A committed receipt remains committed; stopping locally is not server revocation.", InputSchema: operation, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "device_handoff_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			OperationID string `json:"operationId"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		value, e := handoff.Cancel(ctx, input.OperationID)
		return materialToolResult(value, e)
	})
}
