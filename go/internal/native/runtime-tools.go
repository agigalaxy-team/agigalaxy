package native

import (
	"context"
	"encoding/json"
	"fmt"

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
		if isOfficialNativeAuthority(runtime.config.Endpoint) {
			if scope, err := runtime.store.ChoiceScope(ctx); err == nil {
				if operation := tools.browser.accountProgress(ctx, scope); operation != nil {
					result["connectionOperation"] = operation
				}
			}
		}
		return toolResult(result)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_connect", Description: "Connect the existing local identity. On the official service the browser lets the user log in and confirm the account and local ID once; the browser completes the connection and association. Open the returned page. No local notes or original conversations are uploaded.", InputSchema: objectSchema(map[string]any{})}, "native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		current, e := runtime.Status(ctx, RuntimeStatusOptions{})
		if e != nil {
			return toolError(e)
		}
		if isOfficialNativeAuthority(runtime.config.Endpoint) {
			if scope, err := runtime.store.ChoiceScope(ctx); err == nil {
				if operation := tools.browser.accountProgress(ctx, scope); operation != nil {
					switch operation["state"] {
					case "awaiting-account", "processing", "unconfirmed":
						return toolResult(operation)
					}
				}
			}
		}
		if current["connected"] == true {
			if !isOfficialNativeAuthority(runtime.config.Endpoint) {
				return toolResult(current)
			}
			status := uploadObject(current["officialAccount"])
			if status["state"] == "linked" {
				return toolResult(current)
			}
			if status["state"] == "unavailable" {
				return toolError(connectionFailure("native_account_link_status_unavailable"))
			}
		}
		plan, e := runtime.PrepareConnect(ctx)
		if e != nil {
			return toolError(e)
		}
		if isOfficialNativeAuthority(runtime.config.Endpoint) {
			value, err := accountConnect.review(ctx, tools.browser, plan)
			if err != nil {
				return toolError(err)
			}
			return toolResult(value)
		}
		message := fmt.Sprintf("使用此银河身份连接所选服务。\n银河 ID：%s\n服务：%s", plan.GalaxyID, plan.Endpoint)
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
