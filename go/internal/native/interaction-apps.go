package native

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const InteractionAppMIME = "text/html;profile=mcp-app"

type InteractionArtifact struct{ URI, HTML, SHA256 string }

func LoadInteractionArtifact(directory string) (*InteractionArtifact, error) {
	if !filepath.IsAbs(directory) {
		return nil, fault.New("panel_artifact_required", 400)
	}
	raw, e := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if e != nil {
		return nil, e
	}
	var manifest struct {
		SchemaVersion int    `json:"schemaVersion"`
		URI           string `json:"uri"`
		SHA256        string `json:"sha256"`
	}
	if e = json.Unmarshal(raw, &manifest); e != nil {
		return nil, e
	}
	html, e := os.ReadFile(filepath.Join(directory, "panel.html"))
	if e != nil {
		return nil, e
	}
	artifact := &InteractionArtifact{URI: manifest.URI, HTML: string(html), SHA256: manifest.SHA256}
	if manifest.SchemaVersion != 1 || !artifact.valid() {
		return nil, fault.New("panel_artifact_changed", 409)
	}
	return artifact, nil
}
func (a *InteractionArtifact) valid() bool {
	return a != nil && len(a.SHA256) == 64 && a.SHA256 == identity.Digest([]byte(a.HTML)) && a.URI == "ui://galaxy/compact/"+a.SHA256[:24]+".html"
}
func InteractionToolMeta(uri string, appOnly bool) mcp.Meta {
	ui := map[string]any{"resourceUri": uri}
	if appOnly {
		ui["visibility"] = []string{"app"}
	}
	return mcp.Meta{"ui": ui, "ui/resourceUri": uri}
}
func interactionResourceMeta() mcp.Meta {
	return mcp.Meta{"ui": map[string]any{"csp": map[string]any{"connectDomains": []string{}, "resourceDomains": []string{}, "frameDomains": []string{}}, "prefersBorder": true}}
}
func RegisterInteractionResource(server *mcp.Server, artifact *InteractionArtifact) error {
	if server == nil || !artifact.valid() {
		return fault.New("panel_artifact_required", 400)
	}
	html, uri := artifact.HTML, artifact.URI
	server.AddResource(&mcp.Resource{Name: "Galaxy compact workspace", URI: uri, MIMEType: InteractionAppMIME, Meta: interactionResourceMeta()}, func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		if req.Params.URI != uri {
			return nil, fault.New("panel_artifact_required", 404)
		}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: uri, MIMEType: InteractionAppMIME, Text: html, Meta: interactionResourceMeta()}}}, nil
	})
	return nil
}

// Review is supplied by the same Native toolRuntime review gate. The alias
// name identifies the original reviewed operation, not a second permission.
type InteractionAppReviewer func(context.Context, *mcp.CallToolRequest, string, any, string, func(*ChoiceScope) (any, error)) (*mcp.CallToolResult, error)
type InteractionAppOperations struct {
	SaveSettings func(context.Context, json.RawMessage, *ChoiceScope) (any, error)
}
type interactionPanelInput struct {
	View             string `json:"view,omitempty"`
	GalaxyID         string `json:"galaxyId,omitempty"`
	WorkID           string `json:"workId,omitempty"`
	ArchiveSessionID string `json:"archiveSessionId,omitempty"`
	AfterSequence    int64  `json:"afterSequence,omitempty"`
	After            string `json:"after,omitempty"`
}

func interactionComponent(data map[string]any) *mcp.CallToolResult {
	text := "银河 · 履历"
	if data["error"] != nil {
		text = "本机内容暂时无法读取。"
	}
	private := map[string]any{"kind": "galaxy-local-work-panel"}
	for k, v := range data {
		private[k] = v
	}
	model := map[string]any{"kind": "galaxy-local-work-panel", "galaxyId": data["galaxyId"], "error": data["error"], "localOnly": true}
	if view, ok := data["view"]; ok {
		model["view"] = view
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}, StructuredContent: model, Meta: mcp.Meta{"galaxyLocalWork": private}}
}
func interactionPanelError(e error) *mcp.CallToolResult {
	code := fault.Code(e)
	if !regexp.MustCompile(`^[a-z0-9_-]{1,100}$`).MatchString(code) {
		code = "local_panel_unavailable"
	}
	result := interactionComponent(map[string]any{"error": code})
	result.IsError = true
	return result
}
func interactionMap(value any) (map[string]any, error) {
	raw, e := protocol.Encode(value)
	if e != nil {
		return nil, e
	}
	var result map[string]any
	e = protocol.Decode(raw, &result)
	return result, e
}
func interactionPanelSchema() map[string]any {
	return objectSchema(map[string]any{"view": map[string]any{"type": "string", "enum": []string{"history", "privacy", "archive"}, "default": "history"}, "galaxyId": map[string]any{"type": "string"}, "workId": map[string]any{"type": "string"}, "archiveSessionId": materialUUID(), "afterSequence": materialSequence(), "after": map[string]any{"type": "string", "maxLength": 200}})
}
func (r *Runtime) interactionPanelSnapshot(ctx context.Context, input interactionPanelInput) (map[string]any, error) {
	if input.View == "" {
		input.View = "history"
	}
	if !isOne(input.View, "history", "privacy", "archive") || input.AfterSequence < 0 || protocol.TextLength(input.After) > 200 {
		return nil, fault.New("local_panel_input_invalid", 400)
	}
	scope, e := r.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	privacyValue, e := r.GetUploadPrivacy(ctx)
	if e != nil {
		return nil, e
	}
	privacy, e := interactionMap(privacyValue)
	if e != nil {
		return nil, e
	}
	owner := text(privacy["galaxyId"])
	if input.GalaxyID != "" && input.GalaxyID != owner {
		return nil, fault.New("local_identity_changed", 409)
	}
	data := map[string]any{"view": input.View, "galaxyId": nullableText(owner)}
	if owner == "" {
		data["notInitialized"] = true
		if e = r.store.With(ctx, false, func(dir string) error { return r.store.verifyChoiceWithin(dir, &scope) }); e != nil {
			return nil, e
		}
		return data, nil
	}
	if input.View == "privacy" {
		work, e := r.interactionCollect(ctx, owner, false)
		if e != nil {
			return nil, e
		}
		archives, e := r.interactionCollect(ctx, owner, true)
		if e != nil {
			return nil, e
		}
		settingsValue, e := r.store.ArchiveSettings(ctx)
		if e != nil {
			return nil, e
		}
		settings, e := interactionMap(settingsValue)
		if e != nil {
			return nil, e
		}
		choices := []any{}
		byKey := map[string]map[string]any{}
		for _, value := range work {
			item := initializationMap(value)
			row := map[string]any{"workId": item["workId"], "host": item["host"], "sessionId": item["sessionId"], "title": item["title"], "updatedAt": item["updatedAt"]}
			key := interactionSessionKey(item)
			byKey[key] = row
			choices = append(choices, row)
		}
		for _, value := range archives {
			item := initializationMap(value)
			key := interactionSessionKey(item)
			row := byKey[key]
			if row == nil {
				row = map[string]any{"host": item["host"], "sessionId": item["sessionId"], "updatedAt": item["updatedAt"]}
				byKey[key] = row
				choices = append(choices, row)
			}
			row["archiveSessionId"] = item["archiveSessionId"]
		}
		for _, value := range initializationArray(initializationMap(settings["settings"])["sessions"]) {
			item := initializationMap(value)
			key := interactionSessionKey(item)
			if byKey[key] == nil {
				row := map[string]any{"host": item["host"], "sessionId": item["sessionId"], "title": "已保存的会话"}
				byKey[key] = row
				choices = append(choices, row)
			}
		}
		data["privacy"] = privacy
		data["archiveSettings"] = settings
		data["work"] = map[string]any{"items": work}
		data["archives"] = map[string]any{"items": archives}
		data["sessionChoices"] = choices
		data["accountsPending"] = true
		data["archiveSync"], e = NewArchiveUpload(r).Settings(ctx)
		if e != nil {
			return nil, e
		}
		data["workSync"], e = NewWorkUpload(r).Settings(ctx)
		if e != nil {
			return nil, e
		}
	} else if input.View == "archive" {
		page, e := r.store.ArchiveList(ctx, ArchiveQuery{GalaxyID: owner, Limit: 30, After: input.After})
		if e != nil {
			return nil, e
		}
		archives, e := interactionMap(page)
		if e != nil {
			return nil, e
		}
		for _, value := range initializationArray(archives["items"]) {
			if e = r.interactionArchiveTitle(ctx, owner, initializationMap(value)); e != nil {
				return nil, e
			}
		}
		data["archives"] = archives
		data["selectedArchive"] = nil
		if input.ArchiveSessionID != "" {
			value, e := r.store.ArchiveExport(ctx, ArchiveQuery{GalaxyID: owner, ArchiveSessionID: input.ArchiveSessionID, AfterSequence: input.AfterSequence, Limit: 20})
			if e != nil {
				if fault.Code(e) != "local_archive_session_unavailable" {
					return nil, e
				}
				data["missingSelection"] = "archive"
			} else {
				selected, e := interactionMap(value)
				if e != nil {
					return nil, e
				}
				session := map[string]any{}
				for key, value := range initializationMap(selected["session"]) {
					session[key] = value
				}
				if e = r.interactionArchiveTitle(ctx, owner, session); e != nil {
					return nil, e
				}
				data["selectedArchive"] = selected
				if title := session["title"]; title != nil {
					data["archiveTitle"] = title
				}
			}
		}
	} else {
		page, e := r.store.WorkList(ctx, WorkQuery{GalaxyID: owner, Limit: 30, After: input.After})
		if e != nil {
			return nil, e
		}
		data["work"] = page
		data["selectedWork"] = nil
		if input.WorkID != "" {
			value, e := r.store.WorkGet(ctx, WorkQuery{GalaxyID: owner, WorkID: input.WorkID, AfterSequence: input.AfterSequence, Limit: 100})
			if e != nil {
				return nil, e
			}
			if value == nil {
				data["missingSelection"] = "work"
			} else {
				selected, e := interactionMap(value)
				if e != nil {
					return nil, e
				}
				data["selectedWork"] = selected
				work := initializationMap(selected["work"])
				original, e := r.store.ArchiveFindSession(ctx, ArchiveQuery{GalaxyID: owner, Host: text(work["host"]), SessionID: text(work["sessionId"])})
				if e != nil {
					return nil, e
				}
				if original != nil {
					original, e := interactionMap(original)
					if e != nil {
						return nil, e
					}
					if integer(original["messageCount"]) > 0 {
						data["relatedArchiveSessionId"] = original["archiveSessionId"]
					}
				}
			}
		}
	}
	if e = r.store.With(ctx, false, func(dir string) error { return r.store.verifyChoiceWithin(dir, &scope) }); e != nil {
		return nil, e
	}
	return data, nil
}
func (r *Runtime) interactionArchiveTitle(ctx context.Context, owner string, item map[string]any) error {
	value, e := r.store.WorkGet(ctx, WorkQuery{GalaxyID: owner, Host: text(item["host"]), SessionID: text(item["sessionId"]), Limit: 1})
	if e != nil {
		return e
	}
	if value != nil {
		work, e := interactionMap(value)
		if e != nil {
			return e
		}
		title := text(initializationMap(work["work"])["title"])
		if title != "" && title != "Recorded work" && title != "Unprocessed work" {
			item["title"] = title
		}
	}
	return nil
}
func interactionSessionKey(item map[string]any) string {
	raw, _ := protocol.Encode([]string{text(item["host"]), text(item["sessionId"])})
	return string(raw)
}
func (r *Runtime) interactionCollect(ctx context.Context, owner string, archive bool) ([]any, error) {
	items := []any{}
	after := ""
	for {
		var value any
		var e error
		if archive {
			value, e = r.store.ArchiveList(ctx, ArchiveQuery{GalaxyID: owner, Limit: 100, After: after})
		} else {
			value, e = r.store.WorkList(ctx, WorkQuery{GalaxyID: owner, Limit: 100, After: after})
		}
		if e != nil {
			return nil, e
		}
		page, e := interactionMap(value)
		if e != nil {
			return nil, e
		}
		items = append(items, initializationArray(page["items"])...)
		next := text(page["nextAfter"])
		if next == "" {
			return items, nil
		}
		if next == after {
			return nil, fault.New("local_panel_pagination_invalid", 409)
		}
		after = next
	}
}

// RegisterInteractionApps reuses the shipped HTML and real migrated local
// operations. It does not register the still-unmigrated remote help controller.
func RegisterInteractionApps(server *mcp.Server, runtime *Runtime, artifact *InteractionArtifact, review InteractionAppReviewer, operations InteractionAppOperations) error {
	if runtime == nil || review == nil {
		return fault.New("panel_runtime_required", 400)
	}
	if operations.SaveSettings == nil {
		operations.SaveSettings = func(ctx context.Context, raw json.RawMessage, scope *ChoiceScope) (any, error) {
			var input NativeLocalSettingsInput
			if e := protocol.Decode(raw, &input); e != nil {
				return nil, e
			}
			return runtime.SaveLocalSettingsReviewed(ctx, input, scope)
		}
	}
	if e := RegisterInteractionResource(server, artifact); e != nil {
		return e
	}
	add := func(name string, schema map[string]any, description string, write, appOnly bool, handler mcp.ToolHandler) {
		addNativeTool(server, &mcp.Tool{Name: name, Description: description, InputSchema: schema, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}, Meta: InteractionToolMeta(artifact.URI, appOnly)}, "local_panel_input_invalid", handler)
	}
	read := func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input interactionPanelInput
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return interactionPanelError(e), nil
		}
		data, e := runtime.interactionPanelSnapshot(ctx, input)
		if e != nil {
			return interactionPanelError(e), nil
		}
		return interactionComponent(data), nil
	}
	add("galaxy_local_panel", interactionPanelSchema(), "Open the existing local work/history/upload-settings panel. Actual private bodies remain component-only metadata; no connection, upload or model is started.", false, false, read)
	add("galaxy_local_panel_read", interactionPanelSchema(), "Read this panel's selected local work or original capture. Full body remains component-only.", false, true, read)
	reviewed := func(ctx context.Context, req *mcp.CallToolRequest, name string, input any, message, view, owner string, run func(*ChoiceScope) (any, error)) (*mcp.CallToolResult, error) {
		var shown any = input
		if selection, ok := input.(InitializationInput); ok {
			preview, e := PreviewInitialization(selection)
			if e != nil {
				return interactionPanelError(e), nil
			}
			shown = preview
		}
		if selection, ok := input.(WorkQuery); ok && name == "galaxy_local_work_delete" {
			preview, e := runtime.store.workDeletePreview(ctx, selection)
			if e != nil {
				return interactionPanelError(e), nil
			}
			if preview != nil {
				shown = preview
			}
		}
		if selection, ok := input.(ArchiveQuery); ok && name == "galaxy_local_archive_delete" {
			preview, e := runtime.store.ArchiveDescribe(ctx, selection)
			if e != nil {
				return interactionPanelError(e), nil
			}
			if preview != nil {
				shown = preview
			}
		}
		exact, e := protocol.Encode(shown)
		if e != nil {
			return interactionPanelError(e), nil
		}
		message += "\n" + string(exact)
		result, e := review(ctx, req, name, input, message, run)
		if e != nil {
			return interactionPanelError(e), nil
		}
		if result == nil {
			return interactionPanelError(fault.New("local_panel_unavailable", 500)), nil
		}
		raw, e := protocol.Encode(result)
		if e != nil {
			return interactionPanelError(e), nil
		}
		var wire map[string]any
		if e = protocol.Decode(raw, &wire); e != nil {
			return interactionPanelError(e), nil
		}
		if wire["resultType"] == "input_required" {
			return result, nil
		}
		if result.IsError {
			return result, nil
		}
		var value map[string]any
		if result.StructuredContent != nil {
			value, _ = interactionMap(result.StructuredContent)
		} else {
			for _, content := range result.Content {
				if content, ok := content.(*mcp.TextContent); ok {
					_ = protocol.Decode([]byte(content.Text), &value)
					break
				}
			}
		}
		if isOne(text(value["state"]), "user-choice-needs-browser", "declined", "pending") {
			return interactionComponent(map[string]any{"view": view, "galaxyId": nullableText(owner), "choice": value}), nil
		}
		if isOne(name, "galaxy_local_settings_save", "galaxy_work_sync_choice", "galaxy_archive_sync_choice") {
			runtime.ResumePrivateSync(0)
		}
		snapshot, e := runtime.interactionPanelSnapshot(ctx, interactionPanelInput{View: view, GalaxyID: owner})
		if e != nil {
			return interactionPanelError(e), nil
		}
		return interactionComponent(snapshot), nil
	}
	add("galaxy_local_panel_prepare", objectSchema(map[string]any{"view": map[string]any{"type": "string", "enum": []string{"history", "privacy", "archive"}, "default": "history"}, "subjectType": map[string]any{"type": "string", "enum": []string{"person", "organization"}, "default": "person"}}), "Prepare only this device through the original Native person choice. Existing identity is reused without type changes.", true, true, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			View        string `json:"view"`
			SubjectType string `json:"subjectType"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return interactionPanelError(e), nil
		}
		if input.View == "" {
			input.View = "history"
		}
		if input.SubjectType == "" {
			input.SubjectType = "person"
		}
		owner, e := runtime.store.Owner(ctx)
		if e != nil {
			return interactionPanelError(e), nil
		}
		if owner != "" {
			data, e := runtime.interactionPanelSnapshot(ctx, interactionPanelInput{View: input.View})
			if e != nil {
				return interactionPanelError(e), nil
			}
			return interactionComponent(data), nil
		}
		selection := InitializationInput{InitializationPath: "personal-galaxy", SubjectType: input.SubjectType}
		return reviewed(ctx, req, "galaxy_native_initialize", selection, "创建本机身份，不连接、不上传、不调用模型。主体类型："+input.SubjectType, input.View, "", func(scope *ChoiceScope) (any, error) { return runtime.store.Initialize(ctx, selection, true, scope) })
	})
	// The same reviewed domain functions enforce owner/scope inside the write lock.
	add("galaxy_local_panel_archive_save", objectSchema(map[string]any{"galaxyId": stringSchema(), "enabled": map[string]any{"type": "boolean"}, "sessions": map[string]any{"type": "array", "maxItems": 500, "items": objectSchema(map[string]any{"host": stringSchema(), "sessionId": stringSchema()}, "host", "sessionId")}, "autoCleanAfterDays": map[string]any{"type": []string{"integer", "null"}, "minimum": 1, "maximum": 36500}}, "enabled", "sessions"), "Save exact local original capture scopes through the original person choice. No upload.", true, true, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input ArchiveInput
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return interactionPanelError(e), nil
		}
		if e := ValidateArchive(input); e != nil {
			return interactionPanelError(e), nil
		}
		message, e := runtime.store.archiveChoiceMessage(ctx, input)
		if e != nil {
			return interactionPanelError(e), nil
		}
		return reviewed(ctx, req, "galaxy_local_archive_configure", input, message, "privacy", input.GalaxyID, func(scope *ChoiceScope) (any, error) { return runtime.store.configureArchive(ctx, input, scope) })
	})
	add("galaxy_local_panel_upload_save", objectSchema(map[string]any{"galaxyId": stringSchema(), "level": map[string]any{"type": "string", "enum": []string{"local-only", "history-overview", "work-content", "conversation-archive"}}, "includeFullConversations": map[string]any{"type": "boolean"}, "sessionIds": map[string]any{"type": "array", "maxItems": 500, "items": stringSchema()}}, "level"), "Save this panel user's exact upload selection through the original Native choice.", true, true, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			GalaxyID string `json:"galaxyId,omitempty"`
			UploadPrivacySelection
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return interactionPanelError(e), nil
		}
		return reviewed(ctx, req, "galaxy_local_upload_privacy_set", input, "仅保存允许上传的类型与范围；不上传、不改变公开查询、不限制宿主模型。", "privacy", input.GalaxyID, func(scope *ChoiceScope) (any, error) {
			if input.GalaxyID != "" && input.GalaxyID != scope.Owner {
				return nil, fault.New("local_identity_changed", 409)
			}
			return runtime.SetUploadPrivacyReviewed(ctx, input.UploadPrivacySelection, scope)
		})
	})
	for _, archive := range []bool{false, true} {
		isArchive := archive
		name := "galaxy_local_panel_work_delete"
		field := "workId"
		operation := "galaxy_local_work_delete"
		view := "history"
		if isArchive {
			name = "galaxy_local_panel_archive_delete"
			field = "archiveSessionId"
			operation = "galaxy_local_archive_delete"
			view = "archive"
		}
		originalOperation, originalView := operation, view
		add(name, objectSchema(map[string]any{"galaxyId": stringSchema(), field: stringSchema()}, field), "Delete only this selected local record through the original person choice. Host originals and independent cloud replicas remain separate.", true, true, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			if isArchive {
				var input ArchiveQuery
				if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
					return interactionPanelError(e), nil
				}
				return reviewed(ctx, req, originalOperation, input, "删除所选本机原会话，并停止后续采集；宿主原件、普通履历和云副本分别处理。", "archive", input.GalaxyID, func(scope *ChoiceScope) (any, error) { return runtime.store.archiveDelete(ctx, input, scope) })
			}
			var input WorkQuery
			if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
				return interactionPanelError(e), nil
			}
			return reviewed(ctx, req, originalOperation, input, "删除所选本人本机履历、摘要及待上传本机正文；不删除宿主原件、独立会话归档或云副本。", originalView, input.GalaxyID, func(scope *ChoiceScope) (any, error) { return runtime.store.deleteWork(ctx, input, scope) })
		})
	}
	if operations.SaveSettings != nil {
		schema := objectSchema(map[string]any{"choiceId": materialUUID(), "galaxyId": map[string]any{"type": "string"}, "level": map[string]any{"type": "string", "enum": []string{"local-only", "history-overview", "work-content", "conversation-archive"}}, "conversationMode": map[string]any{"type": "string", "enum": []string{"off", "local", "cloud"}}, "sessions": map[string]any{"type": "array", "maxItems": 500, "items": objectSchema(map[string]any{"host": stringSchema(), "sessionId": stringSchema()}, "host", "sessionId")}, "targetAccountId": materialUUID(), "autoCleanAfterDays": map[string]any{"type": []string{"integer", "null"}, "minimum": 1, "maximum": 36500}, "restoreArchiveSessionIds": map[string]any{"type": "array", "maxItems": 500, "items": materialUUID(), "default": []string{}}}, "choiceId", "level", "conversationMode", "sessions", "autoCleanAfterDays")
		add("galaxy_local_panel_settings_save", schema, "Save the original exact conversation retention, upload and private account selection through Native person choice.", true, true, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var input map[string]any
			if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
				return interactionPanelError(e), nil
			}
			raw := append(json.RawMessage{}, req.Params.Arguments...)
			return reviewed(ctx, req, "galaxy_local_settings_save", input, "保存本次所选会话与上传范围，不更改其他资料；联网保存按原账户选择办理。", "privacy", text(input["galaxyId"]), func(scope *ChoiceScope) (any, error) { return operations.SaveSettings(ctx, raw, scope) })
		})
	}
	registerInteractionSyncApps(runtime, add, reviewed)
	return nil
}
