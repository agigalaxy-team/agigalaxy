package native

import (
	"context"
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The raw SDK handler is required to retain the original text-only results and
// request-state flow. Reuse the SDK's schema library to validate its arguments;
// raw Server.AddTool does not perform that validation itself.
func addNativeTool(server *mcp.Server, tool *mcp.Tool, invalidCode string, handler mcp.ToolHandler) {
	b, e := json.Marshal(tool.InputSchema)
	if e != nil {
		panic("invalid Native tool schema")
	}
	var schema jsonschema.Schema
	if json.Unmarshal(b, &schema) != nil {
		panic("invalid Native tool schema")
	}
	resolved, e := schema.Resolve(nil)
	if e != nil {
		panic("invalid Native tool schema")
	}
	server.AddTool(tool, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		data := request.Params.Arguments
		if len(data) == 0 {
			data = json.RawMessage(`{}`)
			request.Params.Arguments = data
		}
		var value any
		if json.Unmarshal(data, &value) != nil || resolved.Validate(&value) != nil {
			return toolError(fault.New(invalidCode, 400))
		}
		return handler(ctx, request)
	})
}
