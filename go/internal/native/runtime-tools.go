package native

import (
	"context"

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
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_connect", Description: "Connect the current local identity and device to the selected service. This does not link an account or change upload choices.", InputSchema: objectSchema(map[string]any{})}, "native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if _, e := runtime.ConnectService(ctx); e != nil {
			return toolError(e)
		}
		result, e := runtime.Status(ctx, RuntimeStatusOptions{SkipAccount: true})
		if e != nil {
			return toolError(e)
		}
		return toolResult(result)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_account_connect", Description: "Link the current local identity to an official Galaxy account through website login and confirmation.", InputSchema: objectSchema(map[string]any{})}, "native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if !isOfficialNativeAuthority(runtime.config.Endpoint) {
			return toolError(connectionFailure("native_account_link_official_service_required"))
		}
		if scope, err := runtime.store.ChoiceScope(ctx); err == nil {
			if operation := tools.browser.accountProgress(ctx, scope); operation != nil {
				switch operation["state"] {
				case "awaiting-account", "processing", "unconfirmed":
					return toolResult(operation)
				}
			}
		}
		if _, e := runtime.ConnectService(ctx); e != nil {
			return toolError(e)
		}
		current, e := runtime.Status(ctx, RuntimeStatusOptions{})
		if e != nil {
			return toolError(e)
		}
		switch uploadObject(current["officialAccount"])["state"] {
		case "linked":
			return toolResult(current)
		case "unavailable":
			return toolError(connectionFailure("native_account_link_status_unavailable"))
		}
		plan, e := runtime.PrepareConnect(ctx)
		if e != nil {
			return toolError(e)
		}
		value, e := accountConnect.review(ctx, tools.browser, plan)
		if e != nil {
			return toolError(e)
		}
		return toolResult(value)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_disconnect", Description: "Stop this runtime's connection and saved automatic reconnection. This does not revoke the remote device.", InputSchema: objectSchema(map[string]any{})}, "native_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		result, e := runtime.Disconnect(ctx)
		if e != nil {
			return toolError(e)
		}
		return toolResult(result)
	})
}
