package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func registerNavigationTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	runtime.mu.Lock()
	navigation := runtime.navigation
	if navigation == nil {
		navigation = NewNativeNavigation(runtime, NavigationOptions{})
		runtime.navigation = navigation
	}
	runtime.mu.Unlock()
	addNativeTool(server, &mcp.Tool{Name: "galaxy_open", InputSchema: navigationInputSchema(), Description: "Open a stable object or one active entry in the browser. Local workRef stays on this device; the URL contains no original prompt or credentials.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "navigation_reference_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input map[string]any
		if e := protocol.Decode(request.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		value, e := navigation.Open(ctx, input)
		if e != nil {
			return toolError(e)
		}
		return toolResult(value)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_return", InputSchema: objectSchema(map[string]any{"navigationId": materialUUID()}, "navigationId"), Description: "Refresh the same stable object and recover the local origin. Closing the browser does not cancel collaboration.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "navigation_reference_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			NavigationID string `json:"navigationId"`
		}
		if e := protocol.Decode(request.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		value, e := navigation.Resume(ctx, input.NavigationID)
		if e != nil {
			return toolError(e)
		}
		return toolResult(value)
	})
}
