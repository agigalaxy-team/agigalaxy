package native

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func registerRuntimeTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_status", Description: "Read current local identity and restore only its existing saved connection choice. Does not initialize, upload or start a model.", InputSchema: objectSchema(map[string]any{}), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		result, e := runtime.Status(ctx, RuntimeStatusOptions{RestoreSelected: true})
		if e != nil {
			return toolError(e)
		}
		return toolResult(result)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_connect", Description: "Review connecting the current existing device to its configured authority. No local notes or original conversations are uploaded.", InputSchema: objectSchema(map[string]any{})}, "native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		plan, e := runtime.PrepareConnect(ctx)
		if e != nil {
			return toolError(e)
		}
		message := fmt.Sprintf("连接当前银河身份 %s\n服务：%s\n设备：%s\n允许请求的范围：%s\n连接时验证当前控制权；不会上传本机笔记或会话原件，也不启动模型。", plan.GalaxyID, plan.Endpoint, plan.DeviceID, strings.Join(plan.Scopes, "、"))
		return tools.review(ctx, req, plan, message, func(scope *ChoiceScope) (any, error) {
			connection, e := runtime.ConnectReviewed(ctx, plan, scope)
			if e != nil {
				return nil, e
			}
			b, e := protocol.Encode(connection)
			if e != nil {
				return nil, e
			}
			var result map[string]any
			if e = json.Unmarshal(b, &result); e != nil {
				return nil, e
			}
			summary, summaryError := runtime.PersonalSummaryOnBinding(ctx)
			if summaryError != nil {
				result["personalSummary"] = map[string]any{"state": "refresh-required", "syncChoiceInferred": false}
			} else {
				result["personalSummary"] = summary
			}
			return result, nil
		})
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_disconnect", Description: "Stop this runtime's connection and saved automatic reconnection. This does not revoke the remote device.", InputSchema: objectSchema(map[string]any{})}, "native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		result, e := runtime.Disconnect(ctx)
		if e != nil {
			return toolError(e)
		}
		return toolResult(result)
	})
}
