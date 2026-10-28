package native

import (
	"context"
	"encoding/json"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func integrationRecoveryWithin(dir string) (bool, error) {
	for _, name := range []string{".galaxy-initialization.json", ".galaxy-reset.json"} {
		present, e := exists(filepath.Join(dir, name))
		if e != nil || present {
			return present, e
		}
	}
	return false, nil
}

// Read old state as JavaScript strings before writing a selection: unrelated
// local records, including unknown fields, are not reconstructed from a DTO.
func integrationPrivacyMaterialWithin(dir string) (uploadPrivacyMaterial, string, error) {
	var identity map[string]any
	if e := readFallback(dir, "galaxy-id.json", "node.json", &identity); e != nil {
		return uploadPrivacyMaterial{}, "", e
	}
	owner := text(identity["id"])
	material, e := uploadPrivacyWithin(dir, owner)
	if e != nil {
		return material, owner, e
	}
	var raw json.RawMessage
	if e = readFallback(dir, "galaxy-local-state.json", "local-state.json", &raw); e != nil {
		return material, owner, e
	}
	if len(raw) != 0 && string(raw) != "null" {
		value, err := jstext.DecodeJSON(raw)
		if err != nil {
			return material, owner, err
		}
		state, ok := value.(map[string]any)
		if !ok {
			return material, owner, connectionFailure("native_local_state_invalid")
		}
		material.state = state
	}
	return material, owner, nil
}

func integrationPrivacyView(owner string, settings UploadPrivacySettings) map[string]any {
	return map[string]any{"galaxyId": nullableText(owner), "settings": settings, "levels": uploadPrivacyLevelsWithDefault(), "allowedDataTypes": AllowedUploadDataTypes(settings), "uploadStarted": false, "changesOnlineVisibility": false, "localOnly": true}
}

func (s *Store) integrationPrivacyGet(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	e := s.With(ctx, false, func(dir string) error {
		material, owner, e := integrationPrivacyMaterialWithin(dir)
		if e != nil {
			return e
		}
		recovery, e := integrationRecoveryWithin(dir)
		if e != nil {
			return e
		}
		out = integrationPrivacyView(owner, material.settings)
		out["initialized"], out["recoveryRequired"] = owner != "", recovery
		return nil
	})
	return out, e
}

func (s *Store) integrationPrivacySet(ctx context.Context, input map[string]any, scope *ChoiceScope) (any, error) {
	if scope == nil {
		return nil, connectionFailure("native_choice_binding_required")
	}
	var selection UploadPrivacySelection
	selection.Level = text(input["level"])
	if value, ok := input["includeFullConversations"].(bool); ok {
		selection.IncludeFullConversations = &value
	}
	if value, ok := input["sessionIds"]; ok {
		ids := []string{}
		for _, id := range uploadRows(value) {
			ids = append(ids, text(id))
		}
		selection.SessionIDs = &ids
	}
	var out any
	e := s.With(ctx, true, func(dir string) error {
		if recovery, e := integrationRecoveryWithin(dir); e != nil {
			return e
		} else if recovery {
			return connectionFailure("local_recovery_required")
		}
		if e := s.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		material, owner, e := integrationPrivacyMaterialWithin(dir)
		if e != nil {
			return e
		}
		if owner == "" {
			return connectionFailure("local_identity_required")
		}
		if requested, present := input["galaxyId"]; present && requested != owner {
			return connectionFailure("local_identity_mismatch")
		}
		stamp := localNow()
		settings, e := SelectUploadPrivacy(material.settings, selection, stamp)
		if e != nil {
			return e
		}
		state := initializationNormalize(material.state)
		state["uploadPrivacy"] = settings
		initializationAudit(state, "upload_privacy.changed", owner, stamp, map[string]any{"level": settings.Level, "includeFullConversations": settings.IncludeFullConversations, "selectedSessionCount": len(settings.SessionIDs)})
		if e = writeJSON(filepath.Join(dir, "galaxy-local-state.json"), state); e != nil {
			return e
		}
		out = integrationPrivacyView(owner, settings)
		return nil
	})
	return out, e
}

func (s *Store) integrationSettingsSave(ctx context.Context, input map[string]any, scope *ChoiceScope) (any, error) {
	if scope == nil {
		return nil, connectionFailure("native_choice_binding_required")
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	var x NativeLocalSettingsInput
	if e = protocol.Decode(raw, &x); e != nil {
		return nil, e
	}
	if e = validateNativeLocalSettings(x); e != nil {
		return nil, e
	}
	privacy, e := s.integrationPrivacyGet(ctx)
	if e != nil {
		return nil, e
	}
	owner := text(privacy["galaxyId"])
	if owner == "" || x.GalaxyID != nil && *x.GalaxyID != "" && *x.GalaxyID != owner {
		return nil, connectionFailure("local_identity_changed")
	}
	// This local-only host has no API or archiveSync. Use its actual empty
	// endpoint in the existing journal key; do not create a service connection.
	key := "local-settings:" + s.Endpoint + ":" + owner + ":" + x.ChoiceID
	var prior map[string]any
	journal := func(write, completed bool) error {
		return s.With(ctx, write, func(dir string) error {
			if e := s.verifyChoiceWithin(dir, scope); e != nil {
				return e
			}
			if _, e := readJSON(connectionRecordPath(dir, key), &prior); e != nil {
				return e
			}
			if prior != nil && !connectionEqual(prior["input"], input) {
				return connectionFailure("local_settings_original_choice_changed")
			}
			if write {
				return uploadNativeRecordWithin(dir, key, map[string]any{"input": input, "completed": completed})
			}
			return nil
		})
	}
	if e = journal(false, false); e != nil {
		return nil, e
	}
	if prior["completed"] == true {
		return map[string]any{"saved": true}, nil
	}
	if x.ConversationMode == "cloud" {
		return nil, connectionFailure("account_target_unavailable")
	}
	if e = journal(true, false); e != nil {
		return nil, e
	}
	enabled := x.ConversationMode != "off"
	if _, e = s.configureArchive(ctx, ArchiveInput{GalaxyID: owner, Enabled: &enabled, Sessions: x.Sessions, AutoCleanAfterDays: x.AutoCleanAfterDays}, scope); e != nil {
		return nil, e
	}
	// Preserve the original local archive enumeration, including its errors.
	// No cloud consumer is present to choose or restore a remote snapshot.
	after := ""
	for {
		page, err := s.ArchiveList(ctx, ArchiveQuery{GalaxyID: owner, Limit: 100, After: after})
		if err != nil {
			return nil, err
		}
		after = text(uploadObject(page)["nextAfter"])
		if after == "" {
			break
		}
	}
	if _, e = s.integrationPrivacySet(ctx, map[string]any{"galaxyId": owner, "level": x.Level, "includeFullConversations": false, "sessionIds": []any{}}, scope); e != nil {
		return nil, e
	}
	if e = journal(true, true); e != nil {
		return nil, e
	}
	return map[string]any{"saved": true}, nil
}

// integrationMaterialCall belongs to the standalone local-only factory. The
// caller normalizes its original tool schema and captures the three write choices.
func (s *Store) integrationMaterialCall(ctx context.Context, name string, input map[string]any, scope *ChoiceScope) (any, error) {
	switch name {
	case "galaxy_local_upload_privacy_get":
		return s.integrationPrivacyGet(ctx)
	case "galaxy_local_upload_privacy_set":
		return s.integrationPrivacySet(ctx, input, scope)
	case "galaxy_local_settings_save":
		return s.integrationSettingsSave(ctx, input, scope)
	case "galaxy_local_worker_identity_create":
		return s.InitializeWorkerIdentity(ctx, text(input["workerId"]), true, scope)
	case "galaxy_local_work_upload_preview", "galaxy_local_archive_upload_preview":
		captured, e := s.ChoiceScope(ctx)
		if e != nil {
			return nil, e
		}
		privacy, e := s.integrationPrivacyGet(ctx)
		if e != nil {
			return nil, e
		}
		owner := text(privacy["galaxyId"])
		if owner == "" {
			return nil, connectionFailure("local_identity_required")
		}
		copyInput := map[string]any{}
		for key, value := range input {
			copyInput[key] = value
		}
		copyInput["galaxyId"] = owner
		raw, e := protocol.Encode(copyInput)
		if e != nil {
			return nil, e
		}
		var record any
		if name == "galaxy_local_work_upload_preview" {
			var q WorkQuery
			if e = protocol.Decode(raw, &q); e == nil {
				record, e = s.WorkGet(ctx, q)
			}
		} else {
			var q ArchiveQuery
			if e = protocol.Decode(raw, &q); e == nil {
				record, e = s.ArchiveExport(ctx, q)
			}
		}
		if e != nil {
			return nil, e
		}
		settings := privacy["settings"].(UploadPrivacySettings)
		var out any
		if name == "galaxy_local_work_upload_preview" {
			out, e = ProjectWorkForUpload(settings, uploadObject(record))
		} else {
			out, e = ProjectConversationForUpload(settings, uploadObject(record))
		}
		if e != nil {
			return nil, e
		}
		e = s.With(ctx, false, func(dir string) error { return s.verifyChoiceWithin(dir, &captured) })
		return out, e
	default:
		return nil, connectionFailure("local_integration_tool_unknown")
	}
}
