package native

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type interactionReviewed func(context.Context, *mcp.CallToolRequest, string, any, string, string, string, func(*ChoiceScope) (any, error)) (*mcp.CallToolResult, error)

func registerInteractionSyncApps(runtime *Runtime, add func(string, map[string]any, string, bool, bool, mcp.ToolHandler), reviewed interactionReviewed) {
	work, archive := NewWorkUpload(runtime), NewArchiveUpload(runtime)
	ownerInput := objectSchema(map[string]any{"galaxyId": stringSchema()}, "galaxyId")
	add("galaxy_local_panel_sync_accounts", ownerInput, "Read actual private cloud account targets only after this panel user asks to configure copies.", false, true, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			GalaxyID string `json:"galaxyId"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return interactionPanelError(e), nil
		}
		scope, e := runtime.store.ChoiceScope(ctx)
		if e != nil {
			return interactionPanelError(e), nil
		}
		if input.GalaxyID != scope.Owner {
			return interactionPanelError(fault.New("local_identity_changed", 409)), nil
		}
		data := map[string]any{"view": "privacy", "galaxyId": input.GalaxyID, "accountUpdate": true, "accountsPending": false, "accounts": []any{}, "accountSettingsUrl": runtime.config.Website + "/app/account", "accountsUnavailable": false, "accountConnectionRequired": false}
		var enabled bool
		e = runtime.store.With(ctx, false, func(dir string) error {
			if e := runtime.store.verifyChoiceWithin(dir, &scope); e != nil {
				return e
			}
			selection, e := runtime.connection.selectionWithin(dir)
			if e != nil {
				return e
			}
			enabled = selection.Permission != nil && selection.Permission.Enabled
			return nil
		})
		if e != nil {
			return interactionPanelError(e), nil
		}
		if !enabled {
			data["accountConnectionRequired"] = true
			return interactionComponent(data), nil
		}
		targets, e := archive.Accounts(ctx)
		if e != nil {
			data["accountsUnavailable"] = true
		} else {
			target, e := interactionMap(targets)
			if e != nil {
				return interactionPanelError(e), nil
			}
			data["accounts"] = target["accounts"]
		}
		if e = runtime.store.With(ctx, false, func(dir string) error { return runtime.store.verifyChoiceWithin(dir, &scope) }); e != nil {
			return interactionPanelError(e), nil
		}
		return interactionComponent(data), nil
	})
	workSchema := objectSchema(map[string]any{"galaxyId": stringSchema(), "choiceId": materialUUID(), "enabled": map[string]any{"type": "boolean"}, "targetAccountId": materialUUID(), "workIds": map[string]any{"type": "array", "maxItems": 500, "items": stringSchema()}, "includeExisting": map[string]any{"type": "boolean", "default": false}, "includeFutureWork": map[string]any{"type": "boolean", "default": false}, "restoreWorkIds": map[string]any{"type": "array", "maxItems": 500, "items": stringSchema(), "default": []string{}}}, "galaxyId", "choiceId", "enabled", "workIds")
	add("galaxy_local_panel_work_sync_save", workSchema, "Save the panel user's exact private account/work selection through Native person choice; no implicit old material selection.", true, true, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			GalaxyID string `json:"galaxyId"`
			WorkUploadChoice
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return interactionPanelError(e), nil
		}
		return reviewed(ctx, req, "galaxy_work_sync_choice", input, "仅按本次账户与工作范围保存本人私有资料；不选择其他原内容。", "privacy", input.GalaxyID, func(scope *ChoiceScope) (any, error) {
			if scope.Owner != input.GalaxyID {
				return nil, fault.New("local_identity_changed", 409)
			}
			return work.ChooseReviewed(ctx, input.WorkUploadChoice, scope)
		})
	})
	archiveSchema := objectSchema(map[string]any{"galaxyId": stringSchema(), "choiceId": materialUUID(), "enabled": map[string]any{"type": "boolean"}, "targetAccountId": materialUUID(), "archiveSessionIds": map[string]any{"type": "array", "maxItems": 500, "items": materialUUID()}, "restoreArchiveSessionIds": map[string]any{"type": "array", "maxItems": 500, "items": materialUUID(), "default": []string{}}}, "galaxyId", "choiceId", "enabled", "archiveSessionIds")
	add("galaxy_local_panel_archive_sync_save", archiveSchema, "Save the panel user's exact private account/original-session selection through Native person choice.", true, true, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			GalaxyID string `json:"galaxyId"`
			ArchiveUploadChoice
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return interactionPanelError(e), nil
		}
		return reviewed(ctx, req, "galaxy_archive_sync_choice", input, "仅保存所选账户及明确选定且允许上传的原会话范围。", "privacy", input.GalaxyID, func(scope *ChoiceScope) (any, error) {
			if scope.Owner != input.GalaxyID {
				return nil, fault.New("local_identity_changed", 409)
			}
			return archive.ChooseReviewed(ctx, input.ArchiveUploadChoice, scope)
		})
	})
	add("galaxy_local_panel_sync_flush", ownerInput, "Continue only the existing exact private work/archive selections. Creates no new scope or per-chunk approval.", true, true, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			GalaxyID string `json:"galaxyId"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return interactionPanelError(e), nil
		}
		scope, e := runtime.store.ChoiceScope(ctx)
		if e != nil {
			return interactionPanelError(e), nil
		}
		if scope.Owner != input.GalaxyID {
			return interactionPanelError(fault.New("local_identity_changed", 409)), nil
		}
		if _, e = work.Flush(ctx, ""); e != nil {
			return interactionPanelError(e), nil
		}
		if e = runtime.store.With(ctx, false, func(dir string) error { return runtime.store.verifyChoiceWithin(dir, &scope) }); e != nil {
			return interactionPanelError(e), nil
		}
		if _, e = archive.Flush(ctx, ""); e != nil {
			return interactionPanelError(e), nil
		}
		snapshot, e := runtime.interactionPanelSnapshot(ctx, interactionPanelInput{View: "privacy", GalaxyID: input.GalaxyID})
		if e != nil {
			return interactionPanelError(e), nil
		}
		return interactionComponent(snapshot), nil
	})
}
