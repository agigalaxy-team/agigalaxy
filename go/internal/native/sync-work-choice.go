package native

import (
	"context"
	"database/sql"

	"github.com/google/uuid"
)

type WorkUploadChoice struct {
	ChoiceID          string   `json:"choiceId"`
	Enabled           bool     `json:"enabled"`
	TargetAccountID   string   `json:"targetAccountId,omitempty"`
	WorkIDs           []string `json:"workIds"`
	IncludeExisting   bool     `json:"includeExisting"`
	IncludeFutureWork bool     `json:"includeFutureWork"`
	RestoreWorkIDs    []string `json:"restoreWorkIds"`
}

func workChoiceSame(input WorkUploadChoice, choice map[string]any) bool {
	ids, _ := connectionStrings(choice["workIds"])
	return choice["enabled"] == input.Enabled && text(choice["targetAccountId"]) == input.TargetAccountID && choice["includeExisting"] == input.IncludeExisting && choice["includeFutureWork"] == input.IncludeFutureWork && uploadSameSet(ids, input.WorkIDs)
}
func (u *WorkUpload) Accounts(ctx context.Context) (any, error) {
	scope, e := uploadChoiceScope(ctx, u.runtime.store)
	if e != nil {
		return nil, e
	}
	return u.runtime.Call(ctx, "/v2/account-archives/accounts", map[string]any{}, ConnectionCallOptions{ExpectedScope: &scope})
}

// ChooseReviewed preserves the existing explicit account/source selection. A
// changed target or a restored owner-deleted source needs the caller's review.
func (u *WorkUpload) ChooseReviewed(ctx context.Context, input WorkUploadChoice, scope *ChoiceScope) (any, error) {
	if scope == nil || scope.Owner == "" {
		return nil, connectionFailure("native_connection_choice_required")
	}
	if !controlUUID(input.ChoiceID) || input.WorkIDs == nil || len(input.WorkIDs) > 500 || len(input.RestoreWorkIDs) > 500 || input.TargetAccountID != "" && !controlUUID(input.TargetAccountID) || input.Enabled && (input.TargetAccountID == "" || len(input.WorkIDs) == 0 && !input.IncludeFutureWork) {
		return nil, connectionFailure("work_sync_input_invalid")
	}
	for _, id := range input.WorkIDs {
		if !validID(id) {
			return nil, connectionFailure("work_sync_input_invalid")
		}
	}
	if input.RestoreWorkIDs == nil {
		input.RestoreWorkIDs = []string{}
	}
	for _, id := range input.RestoreWorkIDs {
		if !connectionIncludes(input.WorkIDs, id) {
			return nil, connectionFailure("work_sync_input_invalid")
		}
	}
	var previous map[string]any
	e := u.queue(ctx, false, scope.Owner, scope, func(db *sql.DB, owner string) error {
		var e error
		previous, e = workUploadChoice(ctx, db, owner, u.runtime.config.Endpoint)
		return e
	})
	if e != nil {
		return nil, e
	}
	same := workChoiceSame(input, previous)
	if previous["choiceId"] == input.ChoiceID {
		restored, _ := connectionStrings(previous["restoreWorkIds"])
		if !same || !connectionEqual(restored, input.RestoreWorkIDs) {
			return nil, connectionFailure("work_sync_original_choice_changed")
		}
		return u.Settings(ctx)
	}
	if same && len(input.RestoreWorkIDs) == 0 {
		return u.Settings(ctx)
	}
	sources := map[string]map[string]any{}
	if input.Enabled {
		privacy, owner, e := u.runtime.ReadUploadPrivacy(ctx, scope)
		if e != nil {
			return nil, e
		}
		if owner != scope.Owner || privacy.Level == "local-only" {
			return nil, connectionFailure("local_upload_type_not_allowed")
		}
		targets, e := u.runtime.Call(ctx, "/v2/account-archives/accounts", map[string]any{}, ConnectionCallOptions{ExpectedScope: scope})
		if e != nil {
			return nil, e
		}
		allowed := false
		if targets["subjectId"] == scope.Owner {
			for _, value := range uploadRows(targets["accounts"]) {
				account := uploadObject(value)
				if account["accountId"] == input.TargetAccountID && account["endpoint"] == u.runtime.config.Endpoint {
					allowed = true
				}
			}
		}
		if !allowed {
			return nil, connectionFailure("account_target_unavailable")
		}
		for _, id := range input.WorkIDs {
			if sources[id] != nil {
				continue
			}
			record, e := u.runtime.store.WorkGet(ctx, WorkQuery{GalaxyID: scope.Owner, WorkID: id, Limit: 1})
			if e != nil {
				return nil, e
			}
			if record == nil {
				return nil, connectionFailure("local_work_unavailable")
			}
			sources[id] = record.(map[string]any)["work"].(map[string]any)
		}
	}
	var out any
	e = u.access(ctx, true, true, scope.Owner, scope, func(db *sql.DB, owner string) error {
		current, e := workUploadChoice(ctx, db, owner, u.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		if !connectionEqual(previous, current) {
			return connectionFailure("work_sync_choice_changed")
		}
		sameTarget := text(previous["targetAccountId"]) == input.TargetAccountID
		excluded, _ := connectionStrings(previous["excludedWorkIds"])
		oldIDs, _ := connectionStrings(previous["workIds"])
		for _, id := range oldIDs {
			if !connectionIncludes(input.WorkIDs, id) && !connectionIncludes(excluded, id) {
				excluded = append(excluded, id)
			}
		}
		kept := []string{}
		for _, id := range excluded {
			if !connectionIncludes(input.WorkIDs, id) {
				kept = append(kept, id)
			}
		}
		selectedAt := any(localNow())
		if sameTarget && previous["enabled"] == true && previous["includeFutureWork"] == true && input.IncludeFutureWork {
			selectedAt = previous["selectedAt"]
		}
		choice := map[string]any{"choiceId": input.ChoiceID, "enabled": input.Enabled, "workIds": input.WorkIDs, "includeExisting": input.IncludeExisting, "includeFutureWork": input.IncludeFutureWork, "restoreWorkIds": input.RestoreWorkIDs, "excludedWorkIds": kept, "selectedAt": selectedAt}
		if input.TargetAccountID != "" {
			choice["targetAccountId"] = input.TargetAccountID
		}
		if _, e = db.ExecContext(ctx, "INSERT INTO work_sync_choices(owner_id,endpoint,body_json) VALUES(?,?,?) ON CONFLICT(owner_id,endpoint) DO UPDATE SET body_json=excluded.body_json", owner, u.runtime.config.Endpoint, jsJSON(choice)); e != nil {
			return e
		}
		if sameTarget && input.IncludeFutureWork && previous["includeFutureWork"] == true {
			rows, e := rowsMaps(ctx, db, "SELECT work_id FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND choice_id=?", owner, u.runtime.config.Endpoint, previous["choiceId"])
			if e != nil {
				return e
			}
			for _, row := range rows {
				if !connectionIncludes(kept, text(row["work_id"])) && !connectionIncludes(oldIDs, text(row["work_id"])) {
					if _, e = db.ExecContext(ctx, "UPDATE work_sync_scopes SET choice_id=? WHERE owner_id=? AND endpoint=? AND work_id=?", input.ChoiceID, owner, u.runtime.config.Endpoint, row["work_id"]); e != nil {
						return e
					}
				}
			}
		}
		processed := map[string]bool{}
		for _, id := range input.WorkIDs {
			source := sources[id]
			if source == nil || processed[id] {
				continue
			}
			processed[id] = true
			old, e := oneMap(ctx, db, "SELECT * FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND work_id=?", owner, u.runtime.config.Endpoint, id)
			if e != nil {
				return e
			}
			unchanged := sameTarget && old != nil && !connectionIncludes(input.RestoreWorkIDs, id) && (integer(old["blocked"]) != 0 || previous["enabled"] == true && connectionIncludes(oldIDs, id) && previous["includeExisting"] == input.IncludeExisting)
			if unchanged {
				if _, e = db.ExecContext(ctx, "UPDATE work_sync_scopes SET choice_id=? WHERE owner_id=? AND endpoint=? AND work_id=?", input.ChoiceID, owner, u.runtime.config.Endpoint, id); e != nil {
					return e
				}
				continue
			}
			baseline, environment, summary := int64(0), int64(0), int64(0)
			if !input.IncludeExisting {
				baseline = integer(source["lastSequence"])
				environment = integer(uploadObject(source["environmentVersion"])["version"])
				summary = integer(source["summaryRevision"])
			}
			if _, e = db.ExecContext(ctx, "INSERT INTO work_sync_scopes(owner_id,endpoint,work_id,choice_id,scope_id,baseline_sequence,baseline_environment,baseline_summary,include_existing,selected_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,endpoint,work_id) DO UPDATE SET choice_id=excluded.choice_id,scope_id=excluded.scope_id,baseline_sequence=excluded.baseline_sequence,baseline_environment=excluded.baseline_environment,baseline_summary=excluded.baseline_summary,include_existing=excluded.include_existing,selected_at=excluded.selected_at,last_token=NULL,blocked=0", owner, u.runtime.config.Endpoint, id, input.ChoiceID, uuid.NewString(), baseline, environment, summary, input.IncludeExisting, localNow()); e != nil {
				return e
			}
		}
		out = map[string]any{"galaxyId": owner, "endpoint": u.runtime.config.Endpoint, "choice": choice, "localOnly": true}
		return nil
	})
	if e == nil {
		u.runtime.wakePrivateSync(ctx)
	}
	return out, e
}
