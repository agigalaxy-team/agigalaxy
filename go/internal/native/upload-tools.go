package native

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Register only the original tools backed by the migrated services. Both
// uploaders share Runtime's identity, lifecycle, transport and request fences.
func registerUploadTools(server *mcp.Server, rt *toolRuntime, runtime *Runtime) {
	work, archive := NewWorkUpload(runtime), NewArchiveUpload(runtime)
	register := func(name, description, invalid string, schema any, write, review bool, run func(context.Context, map[string]any, *ChoiceScope) (any, error)) {
		addNativeTool(server, &mcp.Tool{Name: name, Description: description, InputSchema: schema, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, invalid, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var input map[string]any
			if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
				return toolError(connectionFailure(invalid))
			}
			if review {
				var previewScope *ChoiceScope
				message := fmt.Sprintf("本人选择：%s\n当前设备和身份的原保存范围；endpoint=%s\n准确输入：%s\n新选择仅影响这些资料、档位和目标；不会删除宿主原件，也不会更改公开查询。", description, runtime.config.Endpoint, string(req.Params.Arguments))
				if name == "galaxy_work_cloud_delete" || name == "galaxy_archive_cloud_delete" {
					current, e := uploadChoiceScope(ctx, runtime.store)
					if e != nil {
						return toolError(e)
					}
					previewScope = &current
					var q UploadCloudQuery
					if e = protocol.Decode(req.Params.Arguments, &q); e != nil {
						return toolError(e)
					}
					kind := "archive"
					if name == "galaxy_work_cloud_delete" {
						kind = "work"
					}
					value, e := runtime.uploadCloudCall(ctx, q, kind, "status", previewScope)
					if e != nil {
						return toolError(e)
					}
					raw, e := protocol.Encode(value)
					if e != nil {
						return toolError(e)
					}
					message += fmt.Sprintf("\n删除范围：当前身份 %s、准确账户 %s、此云端副本。\n实际云端状态：%s\n本机原件、宿主原件和其他账户副本不受影响；此来源范围将停止自动再上传。", current.Owner, q.TargetAccountID, raw)
				}
				if name == "galaxy_local_settings_save" && input["autoCleanAfterDays"] != nil {
					message += fmt.Sprintf("\n保存时将依已有规则清理超过 %v 天的本机捕获原件；云端副本与宿主原件单独保留。", input["autoCleanAfterDays"])
				}
				return rt.review(ctx, req, input, message, func(scope *ChoiceScope) (any, error) {
					if previewScope != nil && *previewScope != *scope {
						return nil, connectionFailure("native_connection_selection_changed")
					}
					return run(ctx, input, scope)
				})
			}
			v, e := run(ctx, input, nil)
			return materialToolResult(v, e)
		})
	}
	decode := func(input any, output any) error {
		raw, e := protocol.Encode(input)
		if e != nil {
			return e
		}
		return protocol.Decode(raw, output)
	}
	empty := objectSchema(map[string]any{})
	level := map[string]any{"type": "string", "enum": []string{"local-only", "history-overview", "work-content", "conversation-archive"}}
	boolean := map[string]any{"type": "boolean"}
	ids := func(item any) any { return map[string]any{"type": "array", "maxItems": 500, "items": item} }
	register("galaxy_local_upload_privacy_get", "Read the saved four-level upload selection. Level 2 is the initial default; full conversations stay excluded unless explicitly enabled for selected archive session IDs.", "local_upload_privacy_input_invalid", empty, false, false, func(ctx context.Context, _ map[string]any, _ *ChoiceScope) (any, error) {
		return runtime.GetUploadPrivacy(ctx)
	})
	register("galaxy_local_upload_privacy_set", "Choose local upload data types. This starts no upload, changes no online public-query setting, and does not limit your own host model or local history reads.", "local_upload_privacy_input_invalid", objectSchema(map[string]any{"galaxyId": stringSchema(), "level": level, "includeFullConversations": boolean, "sessionIds": ids(stringSchema())}, "level"), true, true, func(ctx context.Context, input map[string]any, scope *ChoiceScope) (any, error) {
		if owner, ok := input["galaxyId"]; ok && owner != scope.Owner {
			return nil, connectionFailure("local_identity_changed")
		}
		var x UploadPrivacySelection
		selection := map[string]any{}
		for _, key := range []string{"level", "includeFullConversations", "sessionIds"} {
			if value, ok := input[key]; ok {
				selection[key] = value
			}
		}
		if e := decode(selection, &x); e != nil {
			return nil, e
		}
		return runtime.SetUploadPrivacyReviewed(ctx, x, scope)
	})
	session := objectSchema(map[string]any{"host": stringSchema(), "sessionId": stringSchema()}, "host", "sessionId")
	settingsSchema := objectSchema(map[string]any{"choiceId": materialUUID(), "galaxyId": map[string]any{"type": "string"}, "level": level, "conversationMode": map[string]any{"type": "string", "enum": []string{"off", "local", "cloud"}}, "sessions": ids(session), "targetAccountId": materialUUID(), "autoCleanAfterDays": map[string]any{"type": []string{"integer", "null"}, "minimum": 1, "maximum": 36500}, "restoreArchiveSessionIds": ids(materialUUID())}, "choiceId", "level", "conversationMode", "sessions", "autoCleanAfterDays")
	register("galaxy_local_settings_save", "Save one exact local/upload/private-account conversation selection. The program resolves session references and maintains unchanged source ranges. New private disclosure is reviewed once.", "local_settings_invalid", settingsSchema, true, true, func(ctx context.Context, input map[string]any, scope *ChoiceScope) (any, error) {
		var x NativeLocalSettingsInput
		if e := decode(input, &x); e != nil {
			return nil, e
		}
		return runtime.SaveLocalSettingsReviewed(ctx, x, scope)
	})
	register("galaxy_work_sync_settings", "Read the exact chosen account/work scope and durable history upload queue; no connection or upload.", "work_sync_input_invalid", empty, false, false, func(ctx context.Context, _ map[string]any, _ *ChoiceScope) (any, error) { return work.Settings(ctx) })
	register("galaxy_work_sync_accounts", "Read real current associated account choices for private work-history synchronization.", "work_sync_input_invalid", empty, false, false, func(ctx context.Context, _ map[string]any, _ *ChoiceScope) (any, error) { return work.Accounts(ctx) })
	workSchema := objectSchema(map[string]any{"choiceId": materialUUID(), "enabled": boolean, "targetAccountId": materialUUID(), "workIds": ids(stringSchema()), "includeExisting": boolean, "includeFutureWork": boolean, "restoreWorkIds": ids(stringSchema())}, "choiceId", "enabled", "workIds")
	register("galaxy_work_sync_choice", "Choose a private account and work range, preserving unchanged sources and earlier receipts. Existing materials and restoring deleted sources require an explicit selection.", "work_sync_input_invalid", workSchema, true, true, func(ctx context.Context, input map[string]any, scope *ChoiceScope) (any, error) {
		var x WorkUploadChoice
		if e := decode(input, &x); e != nil {
			return nil, e
		}
		return work.ChooseReviewed(ctx, x, scope)
	})
	register("galaxy_work_sync_flush", "Continue this already selected work range at its saved upload level. Actual metadata is sent at level 2; free text requires level 3. Unknown ACKs keep original operationId and payload.", "work_sync_input_invalid", objectSchema(map[string]any{"workId": stringSchema()}), true, false, func(ctx context.Context, input map[string]any, _ *ChoiceScope) (any, error) {
		return work.Flush(ctx, text(input["workId"]))
	})
	register("galaxy_archive_sync_settings", "Read this identity’s exact private-cloud target/range and durable immutable upload queue. Does not connect or upload.", "archive_sync_input_invalid", empty, false, false, func(ctx context.Context, _ map[string]any, _ *ChoiceScope) (any, error) { return archive.Settings(ctx) })
	register("galaxy_archive_sync_accounts", "Read actual currently associated account targets through the selected identity connection. Uses no cookie and never chooses the earliest account.", "archive_sync_input_invalid", empty, false, false, func(ctx context.Context, _ map[string]any, _ *ChoiceScope) (any, error) { return archive.Accounts(ctx) })
	archiveSchema := objectSchema(map[string]any{"choiceId": materialUUID(), "enabled": boolean, "targetAccountId": materialUUID(), "archiveSessionIds": ids(materialUUID()), "restoreArchiveSessionIds": ids(materialUUID())}, "choiceId", "enabled", "archiveSessionIds")
	register("galaxy_archive_sync_choice", "Choose a private account and selected original sessions; preserve unchanged ranges, and restore an owner-deleted source only when explicitly selected for restoration.", "archive_sync_input_invalid", archiveSchema, true, true, func(ctx context.Context, input map[string]any, scope *ChoiceScope) (any, error) {
		var x ArchiveUploadChoice
		if e := decode(input, &x); e != nil {
			return nil, e
		}
		return archive.ChooseReviewed(ctx, x, scope)
	})
	register("galaxy_archive_sync_flush", "Continue already selected private archive snapshots. Reconciles original IDs/chunks after unknown delivery; no new scope, cookie or per-chunk choice.", "archive_sync_input_invalid", objectSchema(map[string]any{"archiveSessionId": materialUUID()}), true, false, func(ctx context.Context, input map[string]any, _ *ChoiceScope) (any, error) {
		return archive.Flush(ctx, text(input["archiveSessionId"]))
	})
	cloud := func(name, description, kind string, schema any, write, review bool, run func(context.Context, UploadCloudQuery, *ChoiceScope) (any, error)) {
		register(name, description, kind+"_sync_input_invalid", schema, write, review, func(ctx context.Context, input map[string]any, scope *ChoiceScope) (any, error) {
			var q UploadCloudQuery
			if e := decode(input, &q); e != nil {
				return nil, e
			}
			return run(ctx, q, scope)
		})
	}
	workItem := objectSchema(map[string]any{"targetAccountId": materialUUID(), "workId": stringSchema()}, "targetAccountId", "workId")
	workPage := objectSchema(map[string]any{"targetAccountId": materialUUID(), "after": materialString(1, 512), "limit": integerSchema(1, 50, 20)}, "targetAccountId")
	cloud("galaxy_work_cloud_list", "Read private work copies uploaded by this identity to the explicit account, using the returned cursor for later pages.", "work", workPage, false, false, func(ctx context.Context, q UploadCloudQuery, _ *ChoiceScope) (any, error) {
		return work.ListCloud(ctx, q)
	})
	cloud("galaxy_work_cloud_get", "Read an owned private work copy. Does not infer public visibility or expand other identity sources.", "work", workItem, false, false, func(ctx context.Context, q UploadCloudQuery, _ *ChoiceScope) (any, error) {
		return work.GetCloud(ctx, q)
	})
	cloud("galaxy_work_cloud_delete", "Delete the exact private work copy and prevent the same source scope silently reappearing.", "work", workItem, true, true, work.DeleteCloudReviewed)
	archiveItem := objectSchema(map[string]any{"targetAccountId": materialUUID(), "id": materialUUID()}, "targetAccountId", "id")
	archivePage := objectSchema(map[string]any{"targetAccountId": materialUUID(), "after": materialString(1, 512), "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}}, "targetAccountId")
	archiveExport := objectSchema(map[string]any{"targetAccountId": materialUUID(), "id": materialUUID(), "sequence": materialSequence()}, "targetAccountId", "id")
	cloud("galaxy_archive_cloud_list", "Read owned private cloud archives at the explicitly selected account. Continue with nextAfter unchanged; no new disclosure choice is needed for another page.", "archive", archivePage, false, false, func(ctx context.Context, q UploadCloudQuery, _ *ChoiceScope) (any, error) {
		return archive.ListCloud(ctx, q)
	})
	cloud("galaxy_archive_cloud_export", "Read one owned cloud archive chunk. Local upload level does not restrict the owner reading their existing private copy.", "archive", archiveExport, false, false, func(ctx context.Context, q UploadCloudQuery, _ *ChoiceScope) (any, error) {
		return archive.ExportCloud(ctx, q)
	})
	cloud("galaxy_archive_cloud_delete", "Delete the exact owned private cloud snapshot. Its source scope cannot silently reappear; other sources and local originals remain separate.", "archive", archiveItem, true, true, archive.DeleteCloudReviewed)
	cloud("galaxy_archive_cloud_cleanup", "Apply the selected account’s existing private-archive retention rule. Does not create or enlarge a sync selection.", "archive", objectSchema(map[string]any{"targetAccountId": materialUUID()}, "targetAccountId"), true, false, func(ctx context.Context, q UploadCloudQuery, _ *ChoiceScope) (any, error) {
		return archive.CleanupCloud(ctx, q)
	})
}
