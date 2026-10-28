package native

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func workUploadStatus(status, job map[string]any, accepted bool) error {
	if status["accountId"] != job["target_id"] || status["workId"] != job["work_id"] || status["audience"] != "owner-only" || !connectionSafeInteger(status["revision"]) || !isOne(text(status["state"]), "absent", "stored", "deleted") {
		return connectionFailure("work_sync_receipt_mismatch")
	}
	if status["state"] != "absent" && status["originSubjectId"] != job["owner_id"] {
		return connectionFailure("work_sync_receipt_mismatch")
	}
	if accepted && (status["state"] != "stored" || status["scopeId"] != job["scope_id"] || status["lastOperationId"] != job["id"] || status["operationId"] != job["id"] || integer(status["revision"]) != integer(job["revision"]) || integer(status["acceptedRevision"]) != integer(job["revision"]) || status["completeConversation"] != false) {
		return connectionFailure("work_sync_receipt_mismatch")
	}
	return nil
}
func (u *WorkUpload) unknown(ctx context.Context, job map[string]any, scope *ChoiceScope, cause error) (any, error) {
	code := fault.Code(cause)
	if code == "internal_error" {
		code = "work_sync_unavailable"
	}
	state := "unknown"
	if job["expected_revision"] == nil && job["state"] == "prepared" {
		state = "prepared"
	}
	view, e := u.mark(ctx, job, scope, state, code)
	if e != nil {
		return nil, e
	}
	if view["state"] == "unknown" {
		view["originalOperationRetained"] = true
	}
	return view, nil
}
func (u *WorkUpload) claim(ctx context.Context, job map[string]any, scope *ChoiceScope, revision int64) (map[string]any, bool, error) {
	var out map[string]any
	claimed := false
	e := u.queue(ctx, true, text(job["owner_id"]), scope, func(db *sql.DB, owner string) error {
		if db == nil {
			return connectionFailure("work_sync_original_operation_unavailable")
		}
		choice, e := workUploadChoice(ctx, db, owner, u.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		source, e := oneMap(ctx, db, "SELECT * FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND work_id=?", owner, u.runtime.config.Endpoint, job["work_id"])
		if e != nil {
			return e
		}
		out, e = oneMap(ctx, db, "SELECT * FROM work_sync_jobs WHERE id=? AND owner_id=? AND endpoint=?", job["id"], owner, u.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		if out == nil || source == nil || choice["enabled"] != true || choice["targetAccountId"] != job["target_id"] || source["scope_id"] != job["scope_id"] || source["choice_id"] != choice["choiceId"] || integer(source["blocked"]) != 0 || out["data_json"] != job["data_json"] {
			return connectionFailure("work_sync_scope_changed")
		}
		if !isOne(text(out["state"]), "prepared", "unknown") || out["expected_revision"] != nil {
			return nil
		}
		prior, e := oneMap(ctx, db, "SELECT id FROM work_sync_jobs WHERE owner_id=? AND endpoint=? AND work_id=? AND scope_id=? AND id<>? AND state='unknown' LIMIT 1", owner, u.runtime.config.Endpoint, job["work_id"], job["scope_id"], job["id"])
		if e != nil {
			return e
		}
		if prior != nil {
			return connectionFailure("work_sync_prior_operation_unresolved")
		}
		if _, e = db.ExecContext(ctx, "UPDATE work_sync_jobs SET expected_revision=?,revision=?,state='unknown',error_code=NULL,updated_at=? WHERE id=? AND owner_id=? AND endpoint=?", revision, revision+1, localNow(), job["id"], owner, u.runtime.config.Endpoint); e != nil {
			return e
		}
		out["expected_revision"], out["revision"], out["state"] = revision, revision+1, "unknown"
		claimed = true
		return nil
	})
	return out, claimed, e
}

// Resume resumes one exact existing immutable queue operation. An uncertain
// operation is status-only: current account-work status cannot prove an older
// operation absent once another operation has superseded its head.
func (u *WorkUpload) Resume(ctx context.Context, operationID string) (any, error) {
	if !controlUUID(operationID) {
		return nil, connectionFailure("work_sync_input_invalid")
	}
	scope, e := uploadChoiceScope(ctx, u.runtime.store)
	if e != nil {
		return nil, e
	}
	job, e := u.job(ctx, operationID, scope.Owner, &scope)
	if e != nil {
		return nil, e
	}
	deletion := UploadCloudQuery{TargetAccountID: text(job["target_id"]), WorkID: text(job["work_id"])}
	pending, e := u.runtime.uploadPendingDelete(ctx, deletion, "work", &scope)
	if e != nil {
		return nil, e
	}
	if pending {
		result, e := u.deleteCloud(ctx, deletion, &scope, true)
		if e != nil {
			return nil, e
		}
		if uploadObject(result)["state"] == "unknown" {
			view := workUploadView(job)
			view["state"], view["error"], view["reconciliationRequired"] = "unknown", "cloud_delete_result_unresolved", true
			return view, nil
		}
		job, e = u.job(ctx, operationID, scope.Owner, &scope)
		if e != nil {
			return nil, e
		}
	}
	if isOne(text(job["state"]), "stored", "blocked-size", "local-deleted", "superseded", "deleted") {
		return workUploadView(job), nil
	}
	if e = u.allowed(ctx, job, &scope); e != nil {
		return nil, e
	}
	options := ConnectionCallOptions{AccountID: text(job["target_id"]), ExpectedScope: &scope}
	status, e := u.runtime.Call(ctx, "/v2/account-work/status", map[string]any{"workId": job["work_id"]}, options)
	if e != nil {
		return u.unknown(ctx, job, &scope, e)
	}
	if e = workUploadStatus(status, job, false); e != nil {
		return u.unknown(ctx, job, &scope, e)
	}
	if status["state"] == "stored" && status["lastOperationId"] == job["id"] {
		if status["scopeId"] != job["scope_id"] || job["revision"] != nil && integer(status["revision"]) != integer(job["revision"]) {
			return u.unknown(ctx, job, &scope, connectionFailure("work_sync_receipt_mismatch"))
		}
		view, e := u.mark(ctx, job, &scope, "stored", nil)
		if e != nil {
			return nil, e
		}
		view["revision"] = status["revision"]
		return view, nil
	}
	if status["state"] == "deleted" && status["scopeId"] == job["scope_id"] {
		return u.mark(ctx, job, &scope, "deleted", nil)
	}
	if !isOne(text(job["state"]), "prepared", "unknown") || job["expected_revision"] != nil {
		view, e := u.mark(ctx, job, &scope, "unknown", "work_sync_original_receipt_unresolved")
		if e != nil {
			return nil, e
		}
		view["originalOperationRetained"] = true
		view["reconciliationRequired"] = true
		return view, nil
	}
	if integer(status["revision"]) >= 9007199254740991 {
		return nil, connectionFailure("work_sync_revision_invalid")
	}
	job, claimed, e := u.claim(ctx, job, &scope, integer(status["revision"]))
	if e != nil {
		return nil, e
	}
	if !claimed {
		view := workUploadView(job)
		view["reconciliationRequired"] = true
		return view, nil
	}
	if e = u.allowed(ctx, job, &scope); e != nil {
		return u.unknown(ctx, job, &scope, e)
	}
	var data map[string]any
	decoder := json.NewDecoder(strings.NewReader(text(job["data_json"])))
	decoder.UseNumber()
	if e = decoder.Decode(&data); e != nil || data == nil || data["galaxyId"] != job["owner_id"] || data["workId"] != job["work_id"] {
		return u.unknown(ctx, job, &scope, connectionFailure("work_sync_original_operation_changed"))
	}
	types := []string{"history-metadata", "environment-versions"}
	if data["uploadLevel"] != "history-overview" {
		types = append(types, "work-summary", "work-content")
	}
	options.LocalUpload = ConnectionLocalUpload{DataTypes: types}
	payload := struct {
		OperationID      any             `json:"operationId"`
		WorkID           any             `json:"workId"`
		ScopeID          any             `json:"scopeId"`
		Revision         any             `json:"revision"`
		ExpectedRevision any             `json:"expectedRevision"`
		Data             json.RawMessage `json:"data"`
	}{job["id"], job["work_id"], job["scope_id"], job["revision"], job["expected_revision"], json.RawMessage(text(job["data_json"]))}
	result, e := u.runtime.Call(ctx, "/v2/account-work/put", payload, options)
	if e != nil {
		if fault.Code(e) == "account_work_owner_deleted" {
			return u.mark(ctx, job, &scope, "deleted", "account_work_owner_deleted")
		}
		return u.unknown(ctx, job, &scope, e)
	}
	if e = workUploadStatus(result, job, true); e != nil {
		return u.unknown(ctx, job, &scope, e)
	}
	return u.mark(ctx, job, &scope, "stored", nil)
}
