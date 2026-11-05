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
	accountConnect := &nativeAccountConnect{runtime: runtime, accounts: NewNativeIdentityAccounts(runtime), pending: map[ChoiceScope]*nativeAccountLogin{}}
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_discovery", Description: "Explicitly read and verify the selected service's public Manifest and root-managed keyring, persisting its public trust state. This does not connect or grant authorization.", InputSchema: objectSchema(map[string]any{}), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		result, e := runtime.Discover(ctx)
		if e != nil {
			return toolError(e)
		}
		return toolResult(result)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_status", Description: "Read current local identity and restore only its existing saved connection choice. Does not initialize, upload or start a model.", InputSchema: objectSchema(map[string]any{}), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		result, e := runtime.Status(ctx, RuntimeStatusOptions{RestoreSelected: true})
		if e != nil {
			return toolError(e)
		}
		if runtime.config.Endpoint == officialNativeAuthority {
			if status := tools.browser.accountProgress(text(result["identity"]), runtime.config.Endpoint); status != nil {
				result["officialAccount"] = status
			}
		}
		return toolResult(result)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_connect", Description: "Connect the existing local identity. On the official service the browser lets the user log in and confirm the account and local ID once; the browser completes the connection and association. Open the returned page. No local notes or original conversations are uploaded.", InputSchema: objectSchema(map[string]any{})}, "native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		current, e := runtime.Status(ctx, RuntimeStatusOptions{})
		if e != nil {
			return toolError(e)
		}
		if current["connected"] == true && runtime.config.Endpoint != officialNativeAuthority {
			return toolResult(current)
		}
		plan, e := runtime.PrepareConnect(ctx)
		if e != nil {
			return toolError(e)
		}
		if runtime.config.Endpoint == officialNativeAuthority {
			value, err := accountConnect.review(ctx, tools.browser, plan)
			if err != nil {
				return toolError(err)
			}
			return toolResult(value)
		}
		message := fmt.Sprintf("连接当前银河身份 %s\n服务：%s\n设备：%s\n允许请求的范围：%s\n连接时验证当前控制权；不会上传本机笔记或会话原件，也不启动模型。", plan.GalaxyID, plan.Endpoint, plan.DeviceID, strings.Join(plan.Scopes, "、"))
		if plan.FirstUse {
			message = fmt.Sprintf("首次连接银河身份 %s\n服务：%s\n将登记这台本机为该身份的首个控制设备，随后建立连接；本机可以管理自己的身份与设备。\n允许请求的范围：%s\n私钥只留在本机，不上传笔记或会话原件，也不启动模型。", plan.GalaxyID, plan.Endpoint, strings.Join(plan.Scopes, "、"))
		}
		return tools.reviewOn(ctx, req, plan, message, true, func(ctx context.Context, scope *ChoiceScope) (any, error) {
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
