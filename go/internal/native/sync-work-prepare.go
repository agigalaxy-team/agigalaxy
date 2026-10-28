package native

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/google/uuid"
)

func uploadTime(value any) (time.Time, bool) {
	stamp, e := time.Parse(time.RFC3339Nano, text(value))
	return stamp, e == nil
}
func uploadAfter(value, cutoff any) bool {
	a, ok := uploadTime(value)
	b, valid := uploadTime(cutoff)
	return ok && valid && !a.Before(b)
}
func workUploadToken(work map[string]any, privacy UploadPrivacySettings) string {
	return fmt.Sprintf("window-v1:%d:%d:%d:%d", integer(work["lastSequence"]), integer(work["summaryRevision"]), integer(uploadObject(work["environmentVersion"])["version"]), privacy.Revision)
}
func (u *WorkUpload) scopeFor(ctx context.Context, work, choice map[string]any, expected *ChoiceScope) (map[string]any, error) {
	var out map[string]any
	e := u.queue(ctx, true, expected.Owner, expected, func(db *sql.DB, owner string) error {
		if db == nil {
			return connectionFailure("work_sync_scope_changed")
		}
		current, e := workUploadChoice(ctx, db, owner, u.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		if current["choiceId"] != choice["choiceId"] || current["enabled"] != true {
			return connectionFailure("work_sync_scope_changed")
		}
		excluded, _ := connectionStrings(current["excludedWorkIds"])
		if connectionIncludes(excluded, text(work["workId"])) {
			return nil
		}
		scope, e := oneMap(ctx, db, "SELECT * FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND work_id=?", owner, u.runtime.config.Endpoint, work["workId"])
		if e != nil {
			return e
		}
		if scope != nil && scope["choice_id"] == current["choiceId"] {
			out = scope
			return nil
		}
		if current["includeFutureWork"] != true || !uploadAfter(work["startedAt"], current["selectedAt"]) {
			return nil
		}
		if _, e = db.ExecContext(ctx, "INSERT INTO work_sync_scopes(owner_id,endpoint,work_id,choice_id,scope_id,baseline_sequence,baseline_environment,baseline_summary,include_existing,selected_at) VALUES(?,?,?,?,?,0,0,0,0,?) ON CONFLICT(owner_id,endpoint,work_id) DO UPDATE SET choice_id=excluded.choice_id,scope_id=excluded.scope_id,baseline_sequence=0,baseline_environment=0,baseline_summary=0,include_existing=0,selected_at=excluded.selected_at,last_token=NULL,blocked=0", owner, u.runtime.config.Endpoint, work["workId"], current["choiceId"], uuid.NewString(), current["selectedAt"]); e != nil {
			return e
		}
		out, e = oneMap(ctx, db, "SELECT * FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND work_id=?", owner, u.runtime.config.Endpoint, work["workId"])
		return e
	})
	return out, e
}
func uploadManagedObservation(value any, endpoint string) any {
	item := uploadObject(value)
	details := uploadObject(item["details"])
	source := uploadObject(item["source"])
	locator := text(source["locator"])
	managed := runtimeTruthy(details["managedSourceRef"]) || strings.HasPrefix(locator, "galaxy:") || source["kind"] == "external-material" && strings.HasPrefix(locator, endpoint+"/")
	if !managed {
		return item
	}
	reference := details["managedSourceRef"]
	if reference == nil {
		reference = source["locator"]
	}
	if _, ok := reference.(string); !ok {
		original := uploadObject(reference)
		reduced := map[string]any{}
		for _, key := range []string{"kind", "id", "version", "endpoint", "locator"} {
			if value, ok := original[key]; ok {
				reduced[key] = value
			}
		}
		reference = reduced
	}
	copy := map[string]any{}
	for key, value := range item {
		copy[key] = value
	}
	copy["content"] = nil
	copy["details"] = map[string]any{"managedSourceRef": reference, "bodyExcluded": true}
	return copy
}

// Prepare freezes only a source already included by the saved private choice.
// It performs no HTTP upload; callers resume the returned original operation ID.
func (u *WorkUpload) Prepare(ctx context.Context, workID string) (any, error) {
	if !validID(workID) {
		return nil, connectionFailure("work_sync_input_invalid")
	}
	expected, e := uploadChoiceScope(ctx, u.runtime.store)
	if e != nil {
		return nil, e
	}
	var choice map[string]any
	e = u.queue(ctx, false, expected.Owner, &expected, func(db *sql.DB, owner string) error {
		var e error
		choice, e = workUploadChoice(ctx, db, owner, u.runtime.config.Endpoint)
		return e
	})
	if e != nil {
		return nil, e
	}
	if choice["enabled"] != true {
		return map[string]any{"state": "not-selected", "networkStarted": false}, nil
	}
	recordValue, e := u.runtime.store.WorkGet(ctx, WorkQuery{GalaxyID: expected.Owner, WorkID: workID, Limit: 1})
	if e != nil {
		return nil, e
	}
	if recordValue == nil {
		return nil, connectionFailure("local_work_unavailable")
	}
	record := recordValue.(map[string]any)
	work := record["work"].(map[string]any)
	scope, e := u.scopeFor(ctx, work, choice, &expected)
	if e != nil {
		return nil, e
	}
	if scope == nil {
		return map[string]any{"state": "not-selected", "networkStarted": false}, nil
	}
	if integer(scope["blocked"]) != 0 {
		return map[string]any{"state": "owner-deleted", "workId": workID, "networkStarted": false}, nil
	}
	var pending map[string]any
	e = u.queue(ctx, false, expected.Owner, &expected, func(db *sql.DB, owner string) error {
		var e error
		pending, e = oneMap(ctx, db, "SELECT * FROM work_sync_jobs WHERE owner_id=? AND endpoint=? AND work_id=? AND scope_id=? AND state IN ('unknown','prepared') ORDER BY updated_at LIMIT 1", owner, u.runtime.config.Endpoint, workID, scope["scope_id"])
		return e
	})
	if e != nil {
		return nil, e
	}
	if pending != nil {
		return workUploadView(pending), nil
	}
	privacy, owner, e := u.runtime.ReadUploadPrivacy(ctx, &expected)
	if e != nil {
		return nil, e
	}
	if owner != expected.Owner {
		return nil, connectionFailure("work_sync_identity_changed")
	}
	if privacy.Level == "local-only" {
		return map[string]any{"state": "local-only", "networkStarted": false}, nil
	}
	token := workUploadToken(work, privacy)
	if scope["last_token"] == token || integer(scope["include_existing"]) == 0 && integer(work["lastSequence"]) <= integer(scope["baseline_sequence"]) && integer(uploadObject(work["environmentVersion"])["version"]) <= integer(scope["baseline_environment"]) && integer(work["summaryRevision"]) <= integer(scope["baseline_summary"]) {
		return map[string]any{"state": "current", "workId": workID, "networkStarted": false}, nil
	}
	if privacy.Level != "history-overview" {
		exported, e := u.runtime.store.WorkExport(ctx, WorkQuery{GalaxyID: expected.Owner, WorkID: workID})
		if e != nil {
			return nil, e
		}
		record = exported.(map[string]any)
		work = record["work"].(map[string]any)
		token = workUploadToken(work, privacy)
	}
	observations := []any{}
	for _, value := range uploadRows(record["observations"]) {
		item := uploadObject(value)
		if integer(item["sequence"]) > integer(work["lastSequence"]) {
			continue
		}
		if integer(scope["include_existing"]) == 0 {
			stamp := item["occurredAt"]
			if stamp == nil {
				stamp = item["observedAt"]
			}
			if integer(item["sequence"]) <= integer(scope["baseline_sequence"]) || !uploadAfter(stamp, scope["selected_at"]) {
				continue
			}
		}
		observations = append(observations, uploadManagedObservation(item, u.runtime.config.Endpoint))
	}
	record["observations"] = observations
	if integer(scope["include_existing"]) == 0 {
		environments := []any{}
		for _, value := range uploadRows(record["environments"]) {
			environment := uploadObject(value)
			if integer(environment["version"]) > integer(scope["baseline_environment"]) && uploadAfter(environment["observedAt"], scope["selected_at"]) {
				environments = append(environments, value)
			}
		}
		record["environments"] = environments
	}
	projected, e := ProjectWorkForUpload(privacy, record)
	if e != nil {
		return nil, e
	}
	data := projected["data"].(map[string]any)
	if integer(scope["include_existing"]) == 0 {
		delete(data, "summary")
		if start, ok := uploadTime(data["startedAt"]); ok {
			if selected, valid := uploadTime(scope["selected_at"]); valid && start.Before(selected) {
				delete(data, "startedAt")
			}
		}
	}
	data, e = boundWorkProjection(data)
	if e != nil {
		return nil, e
	}
	encoded, e := localdata.Encode(data)
	if e != nil {
		return nil, e
	}
	if len(encoded) > 524288 {
		return nil, connectionFailure("local_work_projection_too_large")
	}
	var out any
	e = u.queue(ctx, true, expected.Owner, &expected, func(db *sql.DB, currentOwner string) error {
		current, e := workUploadChoice(ctx, db, currentOwner, u.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		currentScope, e := oneMap(ctx, db, "SELECT * FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND work_id=?", currentOwner, u.runtime.config.Endpoint, workID)
		if e != nil {
			return e
		}
		if current["enabled"] != true || current["choiceId"] != choice["choiceId"] || current["targetAccountId"] != choice["targetAccountId"] || currentScope == nil || currentScope["scope_id"] != scope["scope_id"] || integer(currentScope["blocked"]) != 0 {
			return connectionFailure("work_sync_scope_changed")
		}
		old, e := oneMap(ctx, db, "SELECT * FROM work_sync_jobs WHERE owner_id=? AND endpoint=? AND work_id=? AND scope_id=? AND source_token=?", currentOwner, u.runtime.config.Endpoint, workID, scope["scope_id"], token)
		if e != nil {
			return e
		}
		if old != nil {
			out = workUploadView(old)
			return nil
		}
		id := uuid.NewString()
		if _, e = db.ExecContext(ctx, "INSERT INTO work_sync_jobs(id,owner_id,endpoint,target_id,work_id,choice_id,scope_id,source_token,data_json,state,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'prepared',?)", id, currentOwner, u.runtime.config.Endpoint, choice["targetAccountId"], workID, choice["choiceId"], scope["scope_id"], token, string(encoded), localNow()); e != nil {
			return e
		}
		row, e := oneMap(ctx, db, "SELECT * FROM work_sync_jobs WHERE id=?", id)
		if e != nil {
			return e
		}
		out = workUploadView(row)
		return nil
	})
	return out, e
}
