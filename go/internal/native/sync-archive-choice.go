package native

import (
	"context"
	"database/sql"

	"github.com/google/uuid"
)

type ArchiveUploadChoice struct {
	ChoiceID                 string   `json:"choiceId"`
	Enabled                  bool     `json:"enabled"`
	TargetAccountID          string   `json:"targetAccountId,omitempty"`
	ArchiveSessionIDs        []string `json:"archiveSessionIds"`
	RestoreArchiveSessionIDs []string `json:"restoreArchiveSessionIds"`
}

func (a *ArchiveUpload) Accounts(ctx context.Context) (any, error) {
	return NewWorkUpload(a.runtime).Accounts(ctx)
}
func (a *ArchiveUpload) ChooseReviewed(ctx context.Context, input ArchiveUploadChoice, scope *ChoiceScope) (any, error) {
	if scope == nil || scope.Owner == "" {
		return nil, connectionFailure("native_connection_choice_required")
	}
	if !controlUUID(input.ChoiceID) || input.ArchiveSessionIDs == nil || len(input.ArchiveSessionIDs) > 500 || len(input.RestoreArchiveSessionIDs) > 500 || input.TargetAccountID != "" && !controlUUID(input.TargetAccountID) || input.Enabled && (input.TargetAccountID == "" || len(input.ArchiveSessionIDs) == 0) {
		return nil, connectionFailure("archive_sync_input_invalid")
	}
	ids := []string{}
	for _, id := range input.ArchiveSessionIDs {
		if !controlUUID(id) {
			return nil, connectionFailure("archive_sync_input_invalid")
		}
		if !connectionIncludes(ids, id) {
			ids = append(ids, id)
		}
	}
	if input.RestoreArchiveSessionIDs == nil {
		input.RestoreArchiveSessionIDs = []string{}
	}
	for _, id := range input.RestoreArchiveSessionIDs {
		if !connectionIncludes(ids, id) {
			return nil, connectionFailure("archive_sync_input_invalid")
		}
	}
	var previous map[string]any
	e := a.access(ctx, false, false, scope.Owner, scope, func(db *sql.DB, owner string) error {
		var e error
		previous, e = archiveUploadChoice(ctx, db, owner, a.runtime.config.Endpoint)
		return e
	})
	if e != nil {
		return nil, e
	}
	oldIDs, _ := connectionStrings(previous["archiveSessionIds"])
	unchanged := previous["enabled"] == input.Enabled && text(previous["targetAccountId"]) == input.TargetAccountID && uploadSameSet(oldIDs, ids)
	if previous["choiceId"] == input.ChoiceID {
		restored, _ := connectionStrings(previous["restoreArchiveSessionIds"])
		if !unchanged || !connectionEqual(restored, input.RestoreArchiveSessionIDs) {
			return nil, connectionFailure("archive_sync_original_choice_changed")
		}
		return a.Settings(ctx)
	}
	if unchanged && len(input.RestoreArchiveSessionIDs) == 0 {
		return a.Settings(ctx)
	}
	if input.Enabled {
		privacy, owner, e := a.runtime.ReadUploadPrivacy(ctx, scope)
		if e != nil {
			return nil, e
		}
		if owner != scope.Owner || !privacy.IncludeFullConversations {
			return nil, connectionFailure("upload_privacy_conversation_scope_not_allowed")
		}
		for _, id := range ids {
			if !connectionIncludes(privacy.SessionIDs, id) {
				return nil, connectionFailure("upload_privacy_conversation_scope_not_allowed")
			}
		}
		targets, e := a.runtime.Call(ctx, "/v2/account-archives/accounts", map[string]any{}, ConnectionCallOptions{ExpectedScope: scope})
		if e != nil {
			return nil, e
		}
		available := false
		if targets["subjectId"] == scope.Owner {
			for _, value := range uploadRows(targets["accounts"]) {
				account := uploadObject(value)
				if account["accountId"] == input.TargetAccountID && account["endpoint"] == a.runtime.config.Endpoint {
					available = true
				}
			}
		}
		if !available {
			return nil, connectionFailure("account_target_unavailable")
		}
		for _, id := range ids {
			value, e := a.runtime.store.ArchiveDescribe(ctx, ArchiveQuery{GalaxyID: scope.Owner, ArchiveSessionID: id})
			if e != nil {
				return nil, e
			}
			if value == nil {
				return nil, connectionFailure("local_archive_session_unavailable")
			}
		}
	}
	var out any
	e = a.access(ctx, true, true, scope.Owner, scope, func(db *sql.DB, owner string) error {
		current, e := archiveUploadChoice(ctx, db, owner, a.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		if !connectionEqual(current, previous) {
			return connectionFailure("archive_sync_choice_changed")
		}
		sameTarget := text(previous["targetAccountId"]) == input.TargetAccountID
		scopeIDs := map[string]any{}
		if sameTarget {
			for key, value := range uploadObject(previous["scopeIds"]) {
				scopeIDs[key] = value
			}
		}
		for _, id := range ids {
			prior := scopeIDs[id]
			stopped := false
			if prior != nil {
				row, e := oneMap(ctx, db, "SELECT id FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state='deleted' LIMIT 1", owner, a.runtime.config.Endpoint, id, prior)
				if e != nil {
					return e
				}
				stopped = row != nil
			}
			if prior == nil || connectionIncludes(input.RestoreArchiveSessionIDs, id) || !stopped && (previous["enabled"] != true || !connectionIncludes(oldIDs, id)) {
				scopeIDs[id] = uuid.NewString()
			}
		}
		if integer(previous["revision"]) >= 9007199254740991 {
			return connectionFailure("archive_sync_choice_invalid")
		}
		choice := map[string]any{"choiceId": input.ChoiceID, "enabled": input.Enabled, "targetAccountId": nullableText(input.TargetAccountID), "archiveSessionIds": ids, "restoreArchiveSessionIds": input.RestoreArchiveSessionIDs, "scopeIds": scopeIDs, "revision": integer(previous["revision"]) + 1}
		if _, e = db.ExecContext(ctx, "INSERT INTO sync_choices(owner_id,endpoint,body_json) VALUES(?,?,?) ON CONFLICT(owner_id,endpoint) DO UPDATE SET body_json=excluded.body_json", owner, a.runtime.config.Endpoint, jsJSON(choice)); e != nil {
			return e
		}
		out = map[string]any{"galaxyId": owner, "endpoint": a.runtime.config.Endpoint, "choice": choice, "localOnly": true}
		return nil
	})
	if e == nil {
		a.runtime.wakePrivateSync(ctx)
	}
	return out, e
}
