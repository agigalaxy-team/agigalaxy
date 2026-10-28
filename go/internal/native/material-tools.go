package native

import (
	"context"
	"database/sql"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func materialString(min, max int) any {
	return map[string]any{"type": "string", "minLength": min, "maxLength": max}
}
func materialSequence() any {
	return map[string]any{"type": "integer", "minimum": 0, "maximum": int64(9007199254740991)}
}
func materialUUID() any {
	return map[string]any{"type": "string", "pattern": `^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$`}
}

// Pin the identity before a write reaches its transaction. The Store checks this
// same owner under the coordination lock instead of adopting a newly selected ID.
func (r *toolRuntime) materialOwner(ctx context.Context, requested, domain string) (string, error) {
	owner, e := r.store.Owner(ctx)
	if e != nil {
		return "", e
	}
	if requested != "" && requested != owner {
		return "", fault.New("local_"+domain+"_identity_changed", 409)
	}
	if owner == "" {
		return "", fault.New("local_"+domain+"_identity_required", 409)
	}
	return owner, nil
}
func materialToolResult(v any, e error) (*mcp.CallToolResult, error) {
	if e != nil {
		return toolError(e)
	}
	return toolResult(v)
}
func (s *Store) workDeletePreview(ctx context.Context, q WorkQuery) (any, error) {
	var preview any
	e := s.history(ctx, q.GalaxyID, func(db *sql.DB, owner string) error {
		work, e := findWork(ctx, db, owner, q)
		if e != nil || work == nil {
			return e
		}
		counts, e := oneMap(ctx, db, "SELECT (SELECT count(*) FROM work_observations WHERE work_id=?) AS observationCount,(SELECT count(*) FROM work_summaries WHERE work_id=?) AS summaryCount,(SELECT count(*) FROM work_environments WHERE owner_id=? AND host=? AND session_id=?) AS environmentCount", work["id"], work["id"], owner, work["host"], work["session_id"])
		if e != nil {
			return e
		}
		counts["galaxyId"] = owner
		counts["workId"] = work["id"]
		counts["host"] = work["host"]
		counts["sessionId"] = work["session_id"]
		counts["title"] = work["title"]
		preview = counts
		return nil
	})
	return preview, e
}

func registerLocalMaterialTools(server *mcp.Server, rt *toolRuntime) {
	noteProperties := map[string]any{"galaxyId": stringSchema(), "host": stringSchema(), "sessionId": stringSchema(), "sourceId": stringSchema(), "title": materialString(0, 180), "text": materialString(1, 4000), "sourceKind": map[string]any{"type": "string", "enum": []string{"user-statement", "model-report"}, "default": "model-report"}}
	addNativeTool(server, &mcp.Tool{Name: "galaxy_local_work_note", Description: "Add an explicitly labelled user statement or model report to a local work session. It cannot impersonate a host observation or turn a success claim into verified success.", InputSchema: objectSchema(noteProperties, "host", "sessionId", "text"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "local_work_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var x WorkNoteInput
		if e := protocol.Decode(req.Params.Arguments, &x); e != nil {
			return toolError(workInvalid())
		}
		owner, e := rt.materialOwner(ctx, x.GalaxyID, "work")
		if e != nil {
			return toolError(e)
		}
		x.GalaxyID = owner
		v, e := rt.store.RecordWorkNote(ctx, x)
		return materialToolResult(v, e)
	})
	summaryProperties := map[string]any{"galaxyId": stringSchema(), "workId": stringSchema(), "expectedRevision": materialSequence(), "throughSequence": materialSequence(), "sourceObservationIds": map[string]any{"type": "array", "minItems": 1, "maxItems": 500, "items": stringSchema()}, "title": materialString(1, 180), "summary": materialString(1, 12000), "outcome": map[string]any{"type": "string", "enum": []string{"unknown", "reported-success", "reported-failure", "partial", "cancelled"}, "default": "unknown"}, "model": materialString(1, 256), "execution": objectSchema(map[string]any{"host": stringSchema(), "sessionId": stringSchema(), "messageId": stringSchema()}, "host", "sessionId")}
	addNativeTool(server, &mcp.Tool{Name: "galaxy_local_work_summary", Description: "Save your own Agent’s local summary with expectedRevision, throughSequence and all covered sourceObservationIds. This is user-model interpretation, not official inference or ability evaluation.", InputSchema: objectSchema(summaryProperties, "workId", "expectedRevision", "throughSequence", "sourceObservationIds", "title", "summary"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "local_work_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var x WorkSummaryInput
		if e := protocol.Decode(req.Params.Arguments, &x); e != nil {
			return toolError(workInvalid())
		}
		owner, e := rt.materialOwner(ctx, x.GalaxyID, "work")
		if e != nil {
			return toolError(e)
		}
		x.GalaxyID = owner
		v, e := rt.store.SubmitWorkSummary(ctx, x)
		return materialToolResult(v, e)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_local_archive_list", Description: "List current-identity private captured sessions. archiveSessionId is the exact scope ID used when separately choosing a full-conversation upload.", InputSchema: objectSchema(map[string]any{"galaxyId": stringSchema(), "limit": integerSchema(1, 100, 30), "after": materialString(0, 200)}), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "local_archive_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var x ArchiveQuery
		if e := protocol.Decode(req.Params.Arguments, &x); e != nil {
			return toolError(fault.New("local_archive_input_invalid", 400))
		}
		v, e := rt.store.ArchiveList(ctx, x)
		return materialToolResult(v, e)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_local_archive_export", Description: "Export a page of actually captured original messages and parts for one selected private session. Coverage is explicit; missing earlier messages are not fabricated.", InputSchema: objectSchema(map[string]any{"galaxyId": stringSchema(), "archiveSessionId": materialUUID(), "afterSequence": materialSequence(), "limit": integerSchema(1, 100, 20)}, "archiveSessionId"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "local_archive_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var x ArchiveQuery
		if e := protocol.Decode(req.Params.Arguments, &x); e != nil {
			return toolError(fault.New("local_archive_input_invalid", 400))
		}
		v, e := rt.store.ArchiveExport(ctx, x)
		return materialToolResult(v, e)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_local_archive_cleanup", Description: "Apply the current identity’s previously selected automatic cleanup age to captured local originals. With no cleanup age configured this deletes nothing.", InputSchema: objectSchema(map[string]any{"galaxyId": stringSchema()}), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "local_archive_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var x ArchiveQuery
		if e := protocol.Decode(req.Params.Arguments, &x); e != nil {
			return toolError(fault.New("local_archive_input_invalid", 400))
		}
		owner, e := rt.store.Owner(ctx)
		if e != nil {
			return toolError(e)
		}
		if x.GalaxyID != "" && x.GalaxyID != owner {
			return toolError(fault.New("local_archive_identity_changed", 409))
		}
		if owner == "" {
			return toolResult(map[string]any{"galaxyId": nil, "deletedMessages": 0, "localOnly": true})
		}
		x.GalaxyID = owner
		v, e := rt.store.ArchiveCleanup(ctx, x)
		return materialToolResult(v, e)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_local_work_delete", Description: "Delete one selected local work history and its queued local upload bodies for the current identity. Host originals, separately selected conversation archives and cloud replicas are separate.", InputSchema: objectSchema(map[string]any{"galaxyId": stringSchema(), "workId": stringSchema()}, "workId"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "local_work_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var x WorkQuery
		if e := protocol.Decode(req.Params.Arguments, &x); e != nil {
			return toolError(workInvalid())
		}
		owner, e := rt.materialOwner(ctx, x.GalaxyID, "work")
		if e != nil {
			return toolError(e)
		}
		x.GalaxyID = owner
		selected, e := rt.store.workDeletePreview(ctx, x)
		if e != nil {
			return toolError(e)
		}
		if selected == nil && req.Params.RequestState == "" {
			return toolError(fault.New("local_work_unavailable", 404))
		}
		if selected == nil {
			selected = map[string]any{"galaxyId": owner, "workId": x.WorkID}
		}
		preview, _ := protocol.Encode(selected)
		message := "银河：删除所选本机履历。\n删除下列会话的本人本机工作事实、摘要、环境及其待上传本机正文；不删除宿主原件、独立原会话归档或云副本。\n" + string(preview)
		return rt.review(ctx, req, x, message, func(scope *ChoiceScope) (any, error) { return rt.store.deleteWork(ctx, x, scope) })
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_local_archive_delete", Description: "Delete the selected private local archive and stop capturing that session. Clears its queued local snapshot bodies; does not delete host originals, ordinary work facts or an independent cloud replica.", InputSchema: objectSchema(map[string]any{"galaxyId": stringSchema(), "archiveSessionId": materialUUID()}, "archiveSessionId"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "local_archive_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var x ArchiveQuery
		if e := protocol.Decode(req.Params.Arguments, &x); e != nil {
			return toolError(fault.New("local_archive_input_invalid", 400))
		}
		owner, e := rt.materialOwner(ctx, x.GalaxyID, "archive")
		if e != nil {
			return toolError(e)
		}
		x.GalaxyID = owner
		selected, e := rt.store.ArchiveDescribe(ctx, x)
		if e != nil {
			return toolError(e)
		}
		if selected == nil && req.Params.RequestState == "" {
			return toolError(fault.New("local_archive_session_unavailable", 404))
		}
		if selected == nil {
			selected = map[string]any{"galaxyId": owner, "archiveSessionId": x.ArchiveSessionID}
		}
		preview, _ := protocol.Encode(selected)
		message := "银河：删除所选本机原文。\n删除下列会话的本人本机原文及其待上传本机快照，并停止该会话后续采集；不删除宿主原件、普通工作事实或云副本。\n" + string(preview)
		return rt.review(ctx, req, x, message, func(scope *ChoiceScope) (any, error) { return rt.store.archiveDelete(ctx, x, scope) })
	})
}
