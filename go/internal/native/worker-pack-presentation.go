package native

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func workerPanelResult(data map[string]any, componentOnly bool) *mcp.CallToolResult {
	model := data
	meta := mcp.Meta(nil)
	if preview := a2aObject(data["preview"]); componentOnly && preview != nil {
		model = a2aClone(data)
		p := a2aClone(preview)
		delete(p, "exact")
		p["exactContentInComponent"] = true
		model["preview"] = p
		meta = mcp.Meta{"galaxyWorker": map[string]any{"preview": preview}}
	}
	encoded, err := protocol.Encode(model)
	if err != nil {
		return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "当前内容暂不可用。"}}}
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(encoded)}}, StructuredContent: model, Meta: meta}
}
