package native

import (
	"context"
	"path/filepath"
)

func UploadPrivacyLevels() []any {
	levels := []any{
		map[string]any{"id": "local-only", "number": 1, "title": "只存本机", "titleEn": "Local only", "description": "不允许上传本地工作资料。"},
		map[string]any{"id": "history-overview", "number": 2, "title": "履历概况", "titleEn": "History overview", "description": "只允许所选工作类型、角色、时间、结果状态及来源标识和主要模型工具版本；不含任务正文、过程摘要、项目客户名或路径。"},
		map[string]any{"id": "work-content", "number": 3, "title": "选定工作内容", "titleEn": "Selected work content", "description": "另允许所选工作的具体说明、过程摘要和选定材料，不包含完整会话。"},
		map[string]any{"id": "conversation-archive", "number": 4, "title": "完整会话可选", "titleEn": "Optional conversation archive", "description": "完整会话仍默认排除；另行启用并选定会话后才允许该范围，凭据始终排除。"},
	}
	for _, value := range levels {
		level := value.(map[string]any)
		id := level["id"].(string)
		level["defaultSelected"] = id == defaultUploadPrivacyLevel
		level["dataTypes"] = AllowedUploadDataTypes(UploadPrivacySettings{Level: id})
	}
	return levels
}
func (r *Runtime) GetUploadPrivacy(ctx context.Context) (any, error) {
	settings, owner, e := r.ReadUploadPrivacy(ctx, nil)
	if e != nil {
		return nil, e
	}
	return map[string]any{"galaxyId": nullableText(owner), "initialized": owner != "", "recoveryRequired": false, "settings": settings, "levels": UploadPrivacyLevels(), "allowedDataTypes": AllowedUploadDataTypes(settings), "uploadStarted": false, "changesOnlineVisibility": false, "localOnly": true}, nil
}
func (r *Runtime) SetUploadPrivacyReviewed(ctx context.Context, input UploadPrivacySelection, scope *ChoiceScope) (any, error) {
	if scope == nil || scope.Owner == "" {
		return nil, connectionFailure("native_connection_choice_required")
	}
	var out any
	e := r.store.With(ctx, true, func(dir string) error {
		if e := r.store.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		owner, e := r.store.ownerWithin(dir, scope.Owner)
		if e != nil {
			return e
		}
		material, e := uploadPrivacyWithin(dir, owner)
		if e != nil {
			return e
		}
		stamp := localNow()
		settings, e := SelectUploadPrivacy(material.settings, input, stamp)
		if e != nil {
			return e
		}
		if owner == text(material.identity["id"]) {
			state := initializationNormalize(material.state)
			state["uploadPrivacy"] = settings
			initializationAudit(state, "upload_privacy.changed", owner, stamp, map[string]any{"level": settings.Level, "includeFullConversations": settings.IncludeFullConversations, "selectedSessionCount": len(settings.SessionIDs)})
			if e = writeJSON(filepath.Join(dir, "galaxy-local-state.json"), state); e != nil {
				return e
			}
		} else {
			identities := material.separate["identities"].(map[string]any)
			identities[owner] = settings
			if e = writeJSON(filepath.Join(dir, "galaxy-upload-privacy.json"), map[string]any{"version": 1, "identities": identities}); e != nil {
				return e
			}
		}
		out = map[string]any{"galaxyId": owner, "settings": settings, "levels": UploadPrivacyLevels(), "allowedDataTypes": AllowedUploadDataTypes(settings), "uploadStarted": false, "changesOnlineVisibility": false, "localOnly": true}
		return nil
	})
	if e == nil {
		r.wakePrivateSync(ctx)
	}
	return out, e
}
