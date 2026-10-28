package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func ProjectConversationForUpload(settings UploadPrivacySettings, archive map[string]any) (map[string]any, error) {
	settings = NormalizeUploadPrivacy(settings)
	session := uploadObject(archive["session"])
	if settings.Level != "conversation-archive" || !settings.IncludeFullConversations || !connectionIncludes(settings.SessionIDs, text(session["archiveSessionId"])) {
		return nil, connectionFailure("upload_privacy_conversation_scope_not_allowed")
	}
	if e := connectionNoCredentials(archive["messages"]); e != nil {
		return nil, e
	}
	data := map[string]any{}
	for _, key := range []string{"galaxyId", "session", "messages", "nextAfter", "coverage", "completeConversation"} {
		if v, ok := archive[key]; ok {
			data[key] = v
		}
	}
	if v, ok := archive["selectedCoverage"]; ok {
		data["selectedCoverage"] = v
	}
	return map[string]any{"data": data, "uploadStarted": false}, nil
}

// PreviewLocalUpload reads only actual selected-owner material. It shares the
// existing projection and changes no queue, source scope, connection or model.
func (r *Runtime) PreviewLocalUpload(ctx context.Context, archive bool, input map[string]any) (any, error) {
	op, cancel, generation, e := r.operation(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	scope, e := r.store.ChoiceScope(op)
	if e != nil {
		return nil, e
	}
	privacy, owner, e := r.ReadUploadPrivacy(op, &scope)
	if e != nil {
		return nil, e
	}
	if owner == "" {
		return nil, connectionFailure("local_identity_required")
	}
	var record any
	var projected map[string]any
	if archive {
		q := ArchiveQuery{GalaxyID: owner, ArchiveSessionID: text(input["archiveSessionId"]), AfterSequence: integer(input["afterSequence"]), Limit: int(integer(input["limit"]))}
		record, e = r.store.ArchiveExport(op, q)
		if e == nil {
			projected, e = ProjectConversationForUpload(privacy, uploadObject(record))
		}
	} else {
		q := WorkQuery{GalaxyID: owner, WorkID: text(input["workId"]), Host: text(input["host"]), SessionID: text(input["sessionId"]), AfterSequence: integer(input["afterSequence"]), Limit: int(integer(input["limit"]))}
		record, e = r.store.WorkGet(op, q)
		if e == nil {
			projected, e = ProjectWorkForUpload(privacy, uploadObject(record))
		}
	}
	if e != nil {
		return nil, e
	}
	if e = r.store.With(op, false, func(dir string) error { return r.store.verifyChoiceWithin(dir, &scope) }); e != nil {
		return nil, e
	}
	if e = r.checkOperation(generation); e != nil {
		return nil, e
	}
	return projected, nil
}
func registerNativeUploadPreviewTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	var contracts map[string]any
	_ = protocol.Decode([]byte(uploadPreviewContractsJSON), &contracts)
	for _, archive := range []bool{false, true} {
		name, description, key := "galaxy_local_work_upload_preview", "Project actual local work fields according to the saved upload level before choosing a service. Level 2 omits observations and raw work content. This preview uploads nothing.", "work"
		if archive {
			name, description, key = "galaxy_local_archive_upload_preview", "Project only an explicitly enabled and selected private archive session at upload level 4. Does not upload, publish, or infer permission for another destination.", "archive"
		}
		schema := uploadObject(contracts[key])
		addNativeTool(server, &mcp.Tool{Name: name, Description: description, InputSchema: schema, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "local_upload_preview_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, e := connectionObject(request.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			remoteDefaults(schema, input)
			if !archive && text(input["workId"]) == "" && (text(input["host"]) == "" || text(input["sessionId"]) == "") {
				return toolError(connectionFailure("local_work_input_invalid"))
			}
			out, e := runtime.PreviewLocalUpload(ctx, archive, input)
			if e != nil {
				return toolError(e)
			}
			return toolResult(out)
		})
	}
}
