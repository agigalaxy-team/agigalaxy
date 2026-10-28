package native

import (
	"context"
	"database/sql"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type UploadCloudQuery struct {
	TargetAccountID string `json:"targetAccountId"`
	ID              string `json:"id,omitempty"`
	WorkID          string `json:"workId,omitempty"`
	After           string `json:"after,omitempty"`
	Limit           int    `json:"limit,omitempty"`
	Sequence        int64  `json:"sequence,omitempty"`
}

func (r *Runtime) uploadDeleteKey(q UploadCloudQuery, kind, owner string) string {
	return "cloud-delete:" + r.config.Endpoint + ":" + owner + ":" + kind + ":" + q.TargetAccountID + ":" + q.WorkID + ":" + q.ID
}
func (r *Runtime) uploadPendingDelete(ctx context.Context, q UploadCloudQuery, kind string, scope *ChoiceScope) (bool, error) {
	pending := false
	e := r.store.With(ctx, false, func(dir string) error {
		if e := r.store.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		var record map[string]any
		if _, e := readJSON(connectionRecordPath(dir, r.uploadDeleteKey(q, kind, scope.Owner)), &record); e != nil {
			return e
		}
		if record != nil && (record["owner"] != scope.Owner || !connectionEqual(record["input"], q)) {
			return connectionFailure("cloud_delete_original_operation_changed")
		}
		pending = record["state"] == "unknown"
		return nil
	})
	return pending, e
}

func uploadCloudValidate(q UploadCloudQuery, kind, action string) error {
	if !controlUUID(q.TargetAccountID) || q.After != "" && (protocol.TextLength(q.After) > 512) || q.Sequence < 0 || q.Sequence > 9007199254740991 {
		return connectionFailure(kind + "_sync_input_invalid")
	}
	if action == "list" {
		maximum := 100
		if kind == "work" {
			maximum = 50
		}
		if q.Limit < 0 || q.Limit > maximum {
			return connectionFailure(kind + "_sync_input_invalid")
		}
	}
	if isOne(action, "get", "export", "delete") {
		if kind == "archive" && !controlUUID(q.ID) || kind == "work" && !validID(q.WorkID) {
			return connectionFailure(kind + "_sync_input_invalid")
		}
	}
	return nil
}
func (r *Runtime) uploadCloudCall(ctx context.Context, q UploadCloudQuery, kind, action string, scope *ChoiceScope) (map[string]any, error) {
	if e := uploadCloudValidate(q, kind, action); e != nil {
		return nil, e
	}
	current, e := uploadChoiceScope(ctx, r.store)
	if e != nil {
		return nil, e
	}
	if scope != nil && current != *scope {
		return nil, connectionFailure("native_connection_selection_changed")
	}
	scope = &current
	input := map[string]any{}
	switch action {
	case "list":
		if q.After != "" {
			input["after"] = q.After
		}
		if q.Limit > 0 {
			input["limit"] = q.Limit
		} else if kind == "work" {
			input["limit"] = 20
		}
	case "get", "status", "delete":
		if kind == "work" {
			input["workId"] = q.WorkID
		} else {
			input["id"] = q.ID
		}
	case "export":
		input["id"], input["sequence"] = q.ID, q.Sequence
	}
	route := "/v2/account-archives/"
	if kind == "work" {
		route = "/v2/account-work/"
	}
	return r.Call(ctx, route+action, input, ConnectionCallOptions{AccountID: q.TargetAccountID, ExpectedScope: scope})
}
func (u *WorkUpload) ListCloud(ctx context.Context, q UploadCloudQuery) (any, error) {
	return u.runtime.uploadCloudCall(ctx, q, "work", "list", nil)
}
func (u *WorkUpload) GetCloud(ctx context.Context, q UploadCloudQuery) (any, error) {
	return u.runtime.uploadCloudCall(ctx, q, "work", "get", nil)
}
func (a *ArchiveUpload) ListCloud(ctx context.Context, q UploadCloudQuery) (any, error) {
	return a.runtime.uploadCloudCall(ctx, q, "archive", "list", nil)
}
func (a *ArchiveUpload) ExportCloud(ctx context.Context, q UploadCloudQuery) (any, error) {
	return a.runtime.uploadCloudCall(ctx, q, "archive", "export", nil)
}
func (a *ArchiveUpload) CleanupCloud(ctx context.Context, q UploadCloudQuery) (any, error) {
	return a.runtime.uploadCloudCall(ctx, q, "archive", "cleanup", nil)
}

// The original delete endpoint has no separate operation ID. Keep its exact
// owner/account/source attempt before dispatch; an unknown result is status-only.
// Local queue cleanup is a separate commit after the verified remote result.
func (r *Runtime) uploadCloudDelete(ctx context.Context, q UploadCloudQuery, kind string, scope *ChoiceScope, reconcileOnly bool, cleanup func() error) (any, error) {
	if e := uploadCloudValidate(q, kind, "delete"); e != nil {
		return nil, e
	}
	if scope == nil || scope.Owner == "" {
		return nil, connectionFailure("native_connection_choice_required")
	}
	key := r.uploadDeleteKey(q, kind, scope.Owner)
	var prior map[string]any
	dispatch := false
	e := r.store.With(ctx, true, func(dir string) error {
		if e := r.store.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		if _, e := readJSON(connectionRecordPath(dir, key), &prior); e != nil {
			return e
		}
		if prior != nil {
			return nil
		}
		if reconcileOnly {
			return connectionFailure("cloud_delete_original_operation_unavailable")
		}
		prior = map[string]any{"state": "unknown", "input": q, "owner": scope.Owner, "createdAt": localNow()}
		if e := uploadNativeRecordWithin(dir, key, prior); e != nil {
			return e
		}
		dispatch = true
		return nil
	})
	if e != nil {
		return nil, e
	}
	if reconcileOnly && prior["state"] == "confirmed" {
		return map[string]any{"state": "superseded"}, nil
	}
	unknown := func(cause error) (any, error) {
		code := runtimeErrorCode(cause)
		return map[string]any{"state": "unknown", "id": q.ID, "workId": q.WorkID, "targetAccountId": q.TargetAccountID, "error": code, "originalOperationRetained": true, "reconciliationRequired": true}, nil
	}
	// An explicitly restored work can occupy the same work ID again. A new
	// reviewed deletion may target it only after the previous attempt is proven
	// complete. An unresolved attempt never takes this dispatch branch.
	if prior["state"] == "confirmed" {
		current, e := r.uploadCloudCall(ctx, q, kind, "status", scope)
		if e != nil {
			return unknown(e)
		}
		if kind == "work" {
			if e = workUploadStatus(current, map[string]any{"target_id": q.TargetAccountID, "work_id": q.WorkID, "owner_id": scope.Owner}, false); e != nil {
				return unknown(e)
			}
		} else if current["id"] != q.ID || !isOne(text(current["state"]), "absent", "uploading", "ready", "deleted", "expired") {
			return unknown(connectionFailure("archive_sync_receipt_mismatch"))
		}
		if isOne(text(current["state"]), "stored", "uploading", "ready") {
			e = r.store.With(ctx, true, func(dir string) error {
				if e := r.store.verifyChoiceWithin(dir, scope); e != nil {
					return e
				}
				var latest map[string]any
				if _, e := readJSON(connectionRecordPath(dir, key), &latest); e != nil {
					return e
				}
				if !connectionEqual(latest, prior) {
					return connectionFailure("cloud_delete_original_operation_changed")
				}
				next := map[string]any{"state": "unknown", "input": q, "owner": scope.Owner, "createdAt": localNow()}
				if e := uploadNativeRecordWithin(dir, key, next); e != nil {
					return e
				}
				prior = next
				dispatch = true
				return nil
			})
			if e != nil {
				return nil, e
			}
		}
	}
	var receipt map[string]any
	if prior["state"] == "confirmed" {
		receipt = uploadObject(prior["receipt"])
	} else if dispatch {
		receipt, e = r.uploadCloudCall(ctx, q, kind, "delete", scope)
		if e != nil {
			return unknown(e)
		}
	} else {
		status, e := r.uploadCloudCall(ctx, q, kind, "status", scope)
		if e != nil {
			return unknown(e)
		}
		if kind == "work" {
			if e = workUploadStatus(status, map[string]any{"target_id": q.TargetAccountID, "work_id": q.WorkID, "owner_id": scope.Owner}, false); e != nil {
				return unknown(e)
			}
		} else if status["id"] != q.ID || !isOne(text(status["state"]), "absent", "uploading", "ready", "deleted", "expired") {
			return unknown(connectionFailure("archive_sync_receipt_mismatch"))
		}
		if !isOne(text(status["state"]), "deleted", "absent", "expired") {
			return unknown(connectionFailure("cloud_delete_result_unresolved"))
		}
		receipt = status
		if kind == "archive" {
			receipt = map[string]any{"id": q.ID, "deleted": status["state"] != "absent"}
		}
	}
	if kind == "work" {
		if e = workUploadStatus(receipt, map[string]any{"target_id": q.TargetAccountID, "work_id": q.WorkID, "owner_id": scope.Owner}, false); e != nil || !isOne(text(receipt["state"]), "absent", "deleted") {
			return unknown(connectionFailure("work_sync_receipt_mismatch"))
		}
	} else {
		if _, ok := receipt["deleted"].(bool); receipt["id"] != q.ID || !ok {
			return unknown(connectionFailure("archive_sync_receipt_mismatch"))
		}
	}
	e = r.store.With(ctx, true, func(dir string) error {
		if e := r.store.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		return uploadNativeRecordWithin(dir, key, map[string]any{"state": "confirmed", "input": q, "owner": scope.Owner, "receipt": receipt})
	})
	if e != nil {
		return nil, e
	}
	if e = cleanup(); e != nil {
		return nil, e
	}
	return receipt, nil
}
func (u *WorkUpload) DeleteCloudReviewed(ctx context.Context, q UploadCloudQuery, scope *ChoiceScope) (any, error) {
	return u.deleteCloud(ctx, q, scope, false)
}
func (u *WorkUpload) deleteCloud(ctx context.Context, q UploadCloudQuery, scope *ChoiceScope, reconcileOnly bool) (any, error) {
	return u.runtime.uploadCloudDelete(ctx, q, "work", scope, reconcileOnly, func() error {
		return u.queue(ctx, true, scope.Owner, scope, func(db *sql.DB, owner string) error {
			if db == nil {
				return nil
			}
			choice, e := workUploadChoice(ctx, db, owner, u.runtime.config.Endpoint)
			if e != nil {
				return e
			}
			if choice["targetAccountId"] == q.TargetAccountID {
				if _, e = db.ExecContext(ctx, "UPDATE work_sync_scopes SET blocked=1 WHERE owner_id=? AND endpoint=? AND work_id=?", owner, u.runtime.config.Endpoint, q.WorkID); e != nil {
					return e
				}
			}
			_, e = db.ExecContext(ctx, "UPDATE work_sync_jobs SET state='deleted',data_json='null' WHERE owner_id=? AND endpoint=? AND work_id=? AND target_id=?", owner, u.runtime.config.Endpoint, q.WorkID, q.TargetAccountID)
			return e
		})
	})
}
func (a *ArchiveUpload) DeleteCloudReviewed(ctx context.Context, q UploadCloudQuery, scope *ChoiceScope) (any, error) {
	return a.deleteCloud(ctx, q, scope, false)
}
func (a *ArchiveUpload) deleteCloud(ctx context.Context, q UploadCloudQuery, scope *ChoiceScope, reconcileOnly bool) (any, error) {
	return a.runtime.uploadCloudDelete(ctx, q, "archive", scope, reconcileOnly, func() error {
		return a.access(ctx, true, false, scope.Owner, scope, func(db *sql.DB, owner string) error {
			if db == nil {
				return nil
			}
			args := []any{q.ID, owner, a.runtime.config.Endpoint, q.TargetAccountID}
			if _, e := db.ExecContext(ctx, "DELETE FROM sync_chunks WHERE job_id IN (SELECT id FROM sync_jobs WHERE id=? AND owner_id=? AND endpoint=? AND target_id=?)", args...); e != nil {
				return e
			}
			_, e := db.ExecContext(ctx, "UPDATE sync_jobs SET state='deleted',updated_at=? WHERE id=? AND owner_id=? AND endpoint=? AND target_id=?", localNow(), q.ID, owner, a.runtime.config.Endpoint, q.TargetAccountID)
			return e
		})
	})
}
