package native

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func identityDeviceResult(value any, e error) (*mcp.CallToolResult, error) {
	if e == nil {
		return toolResult(value)
	}
	result, encodeError := toolResult(map[string]any{"error": runtimeErrorCode(e), "originalOperationRetained": true, "recoverWith": "galaxy_identity_device_native_read", "privateResultWithheld": true})
	if result != nil {
		result.IsError = true
	}
	return result, encodeError
}
func registerIdentityControlTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	devices := NewNativeDeviceManagement(runtime)
	reads := map[string]any{"type": "object", "oneOf": []any{objectSchema(map[string]any{"action": map[string]any{"type": "string", "enum": []string{"current", "list", "pending"}}}, "action"), objectSchema(map[string]any{"action": map[string]any{"const": "reconcile"}, "operationId": materialUUID()}, "action", "operationId")}}
	addNativeTool(server, &mcp.Tool{Name: "galaxy_identity_device_native_read", InputSchema: reads, Description: "Read devices controlled by this local identity on this authority, or original pending/receipt metadata. Reconcile only the original operation; no signing, device approval, binding, retry, recovery or data restoration.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "device_management_native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			Action      string `json:"action"`
			OperationID string `json:"operationId,omitempty"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return identityDeviceResult(nil, e)
		}
		value, e := devices.Read(ctx, input.Action, input.OperationID)
		return identityDeviceResult(value, e)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_identity_device_native_prepare_revoke", InputSchema: objectSchema(map[string]any{"deviceId": materialUUID()}, "deviceId"), Description: "Prepare the exact target device, signer, epoch/head, original operation/challenge hashes, expiry and revocation effects. This registers an unsigned challenge only; no signature or device revocation. Device handoff cancellation is a separate action.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "device_management_native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			DeviceID string `json:"deviceId"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return identityDeviceResult(nil, e)
		}
		value, e := devices.PrepareRevoke(ctx, input.DeviceID)
		return identityDeviceResult(value, e)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_identity_device_native_confirm", InputSchema: objectSchema(map[string]any{"previewId": materialUUID()}, "previewId"), Description: "Show the complete saved device-revocation preview on the actual native user-choice surface. Only that current original preview may sign once. Unknown results require original receipt reconciliation; a model confirmed field is forbidden.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "device_management_native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			PreviewID string `json:"previewId"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return identityDeviceResult(nil, e)
		}
		preview, e := devices.Preview(ctx, input.PreviewID)
		if e != nil {
			return identityDeviceResult(nil, e)
		}
		raw, e := protocol.Encode(preview)
		if e != nil {
			return identityDeviceResult(nil, e)
		}
		review := map[string]any{"previewId": input.PreviewID, "preview": preview, "operationId": uploadObject(preview)["operationId"]}
		message := fmt.Sprintf("本人确认撤销准确设备。\n%s\n仅撤销此权威下目标设备的控制访问、现有绑定和凭据。保留原GUID、历史证明及恢复材料；不删除资料、不恢复资料。结果不明保留原操作核对。", raw)
		return tools.review(ctx, req, review, message, func(scope *ChoiceScope) (any, error) { return devices.ConfirmReviewed(ctx, input.PreviewID, scope) })
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_identity_device_native_stop_retry", InputSchema: objectSchema(map[string]any{"operationId": materialUUID()}, "operationId"), Description: "Ask the actual user to stop only local retry of this exact original device operation. Keep its unknown proof/locator for read-only reconciliation. This does not cancel the server operation, restore device access or revoke another device.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "device_management_native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			OperationID string `json:"operationId"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return identityDeviceResult(nil, e)
		}
		pending, e := devices.Read(ctx, "pending", "")
		if e != nil {
			return identityDeviceResult(nil, e)
		}
		original := uploadObject(pending)["active"]
		if uploadObject(original)["operationId"] != input.OperationID {
			return identityDeviceResult(nil, connectionFailure("device_management_native_operation_unavailable"))
		}
		raw, e := protocol.Encode(original)
		if e != nil {
			return identityDeviceResult(nil, e)
		}
		review := map[string]any{"operationId": input.OperationID, "original": original}
		return tools.review(ctx, req, review, fmt.Sprintf("停止本机重试准确设备操作：%s\n不取消服务器操作，不恢复设备访问；原证明和操作定位保留用于只读核对。", raw), func(scope *ChoiceScope) (any, error) {
			latest, e := devices.Read(ctx, "pending", "")
			if e != nil {
				return nil, e
			}
			if !connectionEqual(uploadObject(latest)["active"], original) {
				return nil, connectionFailure("device_management_native_pending_changed")
			}
			return devices.StopRetryReviewed(ctx, input.OperationID, scope)
		})
	})
	registerNativeRecoveryTools(server, tools, runtime)
	registerNativeIdentityAccountTools(server, tools, runtime)
	registerNativeHandoffTools(server, tools, runtime)
}
