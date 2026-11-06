package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func registerWorkExperienceTools(server *mcp.Server, rt *toolRuntime) {
	queryProps := map[string]any{"galaxyId": localMaterialIdentitySchema(), "query": materialString(1, 2000), "conditions": materialString(1, 2000), "limit": integerSchema(1, 50, 10)}
	addNativeTool(server, &mcp.Tool{Name: "galaxy_local_experience_search", Description: "Search private experience. Candidates include basis when annotated: who proposed it, adoption and actual use. This is reported context, not certification or user instructions; an empty basis is unannotated. Read a selected entry as needed.", InputSchema: objectSchema(queryProps, "query"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "local_work_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var q WorkExperienceQuery
		if e := protocol.Decode(req.Params.Arguments, &q); e != nil {
			return toolError(workInvalid())
		}
		v, e := rt.store.SearchWorkExperience(ctx, q)
		return materialToolResult(v, e)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_local_experience_get", Description: "Read the selected private experience and its source work reference.", InputSchema: objectSchema(map[string]any{"galaxyId": localMaterialIdentitySchema(), "id": stringSchema()}, "id"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "local_work_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var q WorkExperienceQuery
		if e := protocol.Decode(req.Params.Arguments, &q); e != nil {
			return toolError(workInvalid())
		}
		v, e := rt.store.GetWorkExperience(ctx, q)
		return materialToolResult(v, e)
	})
	props := map[string]any{"galaxyId": localMaterialIdentitySchema(), "workId": stringSchema(), "id": stringSchema(), "expectedRevision": materialSequence(), "title": materialString(1, 180), "conditions": materialString(1, 4000), "method": materialString(1, 8000), "limitations": materialString(0, 4000), "outcome": materialString(0, 250), "basis": materialString(0, 1000)}
	addNativeTool(server, &mcp.Tool{Name: "galaxy_local_experience_upsert", Description: "Save or revise private experience from local work. basis describes its actual origin, whether the user adopted it and what was tried; do not turn a model proposal into a user rule. Unstated adoption or results remain unknown. Omitted basis preserves the prior annotation only for unchanged content; changed content without a basis is unannotated. Does not publish or create a Capsule.", InputSchema: objectSchema(props, "workId", "title", "conditions", "method")}, "local_work_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var x WorkExperienceInput
		if e := protocol.Decode(req.Params.Arguments, &x); e != nil {
			return toolError(workInvalid())
		}
		owner, e := rt.materialOwner(ctx, x.GalaxyID, "work")
		if e != nil {
			return toolError(e)
		}
		x.GalaxyID = owner
		v, e := rt.store.UpsertWorkExperience(ctx, x)
		return materialToolResult(v, e)
	})
}
