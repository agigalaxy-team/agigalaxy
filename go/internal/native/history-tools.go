package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func registerHistoryMaterial(s *mcp.Server, store *Store) {
	for _, kind := range []string{"pending", "export"} {
		properties := map[string]any{"galaxyId": stringSchema(), "workId": stringSchema()}
		if kind == "pending" {
			properties["limit"] = integerSchema(1, 200, 100)
		}
		addNativeTool(s, &mcp.Tool{Name: "galaxy_local_work_" + kind,Annotations:&mcp.ToolAnnotations{ReadOnlyHint:true}, Description: "Read the current owner's retained work material. No model, upload, identity creation or capture is started.", InputSchema: objectSchema(properties, "workId")}, "local_work_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var x struct {
				GalaxyID string `json:"galaxyId"`
				WorkID   string `json:"workId"`
				Limit    *int   `json:"limit,omitempty"`
			}
			if e := protocol.Decode(request.Params.Arguments, &x); e != nil {
				return toolError(fault.New("local_work_input_invalid", 400))
			}
			if x.Limit != nil && (kind == "export" || *x.Limit < 1 || *x.Limit > 200) {
				return toolError(fault.New("local_work_input_invalid", 400))
			}
			q := WorkQuery{GalaxyID: x.GalaxyID, WorkID: x.WorkID}
			if x.Limit != nil {
				q.Limit = *x.Limit
			}
			var value any
			var e error
			if kind == "pending" {
				value, e = store.WorkPending(ctx, q)
			} else {
				value, e = store.WorkExport(ctx, q)
			}
			if e != nil {
				return toolError(e)
			}
			return toolResult(value)
		})
	}
}
