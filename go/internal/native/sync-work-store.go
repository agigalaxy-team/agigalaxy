package native

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
)

// WorkUpload resumes the existing immutable owner/account/work queue. It has
// no timer, automatic model, target inference or new synchronization preference.
type WorkUpload struct{ runtime *Runtime }

func NewWorkUpload(runtime *Runtime) *WorkUpload { return &WorkUpload{runtime: runtime} }
func (u *WorkUpload) queue(ctx context.Context, write bool, owner string, expected *ChoiceScope, run func(*sql.DB, string) error) error {
	return u.access(ctx, write, false, owner, expected, run)
}

const workSyncDDL = `CREATE TABLE IF NOT EXISTS work_sync_choices(owner_id TEXT NOT NULL,endpoint TEXT NOT NULL,body_json TEXT NOT NULL,PRIMARY KEY(owner_id,endpoint));
CREATE TABLE IF NOT EXISTS work_sync_scopes(owner_id TEXT NOT NULL,endpoint TEXT NOT NULL,work_id TEXT NOT NULL,choice_id TEXT NOT NULL,scope_id TEXT NOT NULL,baseline_sequence INTEGER NOT NULL,baseline_environment INTEGER NOT NULL,baseline_summary INTEGER NOT NULL,include_existing INTEGER NOT NULL,selected_at TEXT NOT NULL,last_token TEXT,blocked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,endpoint,work_id));
CREATE TABLE IF NOT EXISTS work_sync_jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,endpoint TEXT NOT NULL,target_id TEXT NOT NULL,work_id TEXT NOT NULL,choice_id TEXT NOT NULL,scope_id TEXT NOT NULL,source_token TEXT NOT NULL,data_json TEXT NOT NULL,expected_revision INTEGER,revision INTEGER,state TEXT NOT NULL,error_code TEXT,updated_at TEXT NOT NULL);`

func (u *WorkUpload) access(ctx context.Context, write, create bool, owner string, expected *ChoiceScope, run func(*sql.DB, string) error) error {
	return u.runtime.store.With(ctx, write, func(dir string) error {
		if e := u.runtime.store.verifyChoiceWithin(dir, expected); e != nil {
			return e
		}
		id, e := u.runtime.store.ownerWithin(dir, owner)
		if e != nil {
			return e
		}
		path := filepath.Join(dir, "work-history", "sync.sqlite")
		present, e := exists(path)
		if e != nil {
			return e
		}
		if id == "" && write {
			return connectionFailure("local_identity_required")
		}
		if !present && !create || id == "" {
			return run(nil, id)
		}
		if write {
			if create {
				if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
					return e
				}
				file, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
				if e != nil {
					return e
				}
				if e = file.Close(); e != nil {
					return e
				}
			}
			if e = os.Chmod(path, 0600); e != nil {
				return e
			}
		}
		db, e := openSQLite(path, write)
		if e != nil {
			return e
		}
		defer db.Close()
		if write {
			if create {
				if _, e = db.ExecContext(ctx, workSyncDDL); e != nil {
					return e
				}
			}
			if _, e = db.ExecContext(ctx, "BEGIN IMMEDIATE"); e != nil {
				return e
			}
			defer db.ExecContext(context.Background(), "ROLLBACK")
		}
		if e = run(db, id); e != nil {
			return e
		}
		if write {
			_, e = db.ExecContext(ctx, "COMMIT")
		}
		return e
	})
}
func workUploadChoice(ctx context.Context, db *sql.DB, owner, endpoint string) (map[string]any, error) {
	if db == nil {
		return map[string]any{"enabled": false, "targetAccountId": nil, "choiceId": nil, "workIds": []any{}, "includeExisting": false, "includeFutureWork": false, "restoreWorkIds": []any{}, "excludedWorkIds": []any{}, "selectedAt": nil}, nil
	}
	row, e := oneMap(ctx, db, "SELECT body_json FROM work_sync_choices WHERE owner_id=? AND endpoint=?", owner, endpoint)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return workUploadChoice(ctx, nil, owner, endpoint)
	}
	value, ok := decoded(row["body_json"]).(map[string]any)
	if !ok {
		return nil, connectionFailure("work_sync_choice_invalid")
	}
	return value, nil
}
func workUploadView(row map[string]any) map[string]any {
	return map[string]any{"operationId": row["id"], "workId": row["work_id"], "targetAccountId": row["target_id"], "scopeId": row["scope_id"], "revision": row["revision"], "state": row["state"], "error": row["error_code"], "updatedAt": row["updated_at"]}
}
func (u *WorkUpload) Settings(ctx context.Context) (any, error) {
	var out any
	e := u.queue(ctx, false, "", nil, func(db *sql.DB, owner string) error {
		choice, e := workUploadChoice(ctx, db, owner, u.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		sources := []any{}
		queue := []any{}
		if db != nil {
			rows, e := rowsMaps(ctx, db, "SELECT work_id AS workId,blocked FROM work_sync_scopes WHERE owner_id=? AND endpoint=?", owner, u.runtime.config.Endpoint)
			if e != nil {
				return e
			}
			for _, row := range rows {
				row["blocked"] = integer(row["blocked"]) != 0
				sources = append(sources, row)
			}
			jobs, e := rowsMaps(ctx, db, "SELECT * FROM work_sync_jobs WHERE owner_id=? AND endpoint=? ORDER BY updated_at DESC LIMIT 100", owner, u.runtime.config.Endpoint)
			if e != nil {
				return e
			}
			for _, row := range jobs {
				queue = append(queue, workUploadView(row))
			}
		}
		out = map[string]any{"galaxyId": nullableText(owner), "endpoint": u.runtime.config.Endpoint, "choice": choice, "sources": sources, "queue": queue, "localOnly": true}
		return nil
	})
	return out, e
}
func (u *WorkUpload) job(ctx context.Context, id, owner string, expected *ChoiceScope) (map[string]any, error) {
	var out map[string]any
	e := u.queue(ctx, false, owner, expected, func(db *sql.DB, current string) error {
		if db == nil {
			return connectionFailure("work_sync_original_operation_unavailable")
		}
		var e error
		out, e = oneMap(ctx, db, "SELECT * FROM work_sync_jobs WHERE id=? AND owner_id=? AND endpoint=?", id, current, u.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		if out == nil {
			return connectionFailure("work_sync_original_operation_unavailable")
		}
		return nil
	})
	return out, e
}
func (u *WorkUpload) allowed(ctx context.Context, job map[string]any, scope *ChoiceScope) error {
	if pending, e := u.runtime.uploadPendingDelete(ctx, UploadCloudQuery{TargetAccountID: text(job["target_id"]), WorkID: text(job["work_id"])}, "work", scope); e != nil {
		return e
	} else if pending {
		return connectionFailure("cloud_delete_result_unresolved")
	}
	return u.queue(ctx, false, text(job["owner_id"]), scope, func(db *sql.DB, owner string) error {
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
		current, e := oneMap(ctx, db, "SELECT * FROM work_sync_jobs WHERE id=? AND owner_id=? AND endpoint=?", job["id"], owner, u.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		if source == nil || current == nil || choice["enabled"] != true || choice["targetAccountId"] != job["target_id"] || source["scope_id"] != job["scope_id"] || source["choice_id"] != choice["choiceId"] || integer(source["blocked"]) != 0 || isOne(text(current["state"]), "local-deleted", "deleted", "superseded", "blocked-size") {
			return connectionFailure("work_sync_scope_changed")
		}
		if current["data_json"] != job["data_json"] || current["scope_id"] != job["scope_id"] || current["target_id"] != job["target_id"] {
			return connectionFailure("work_sync_original_operation_changed")
		}
		return nil
	})
}
func (u *WorkUpload) mark(ctx context.Context, job map[string]any, scope *ChoiceScope, state string, code any) (map[string]any, error) {
	var out map[string]any
	e := u.queue(ctx, true, text(job["owner_id"]), scope, func(db *sql.DB, owner string) error {
		if db == nil {
			return connectionFailure("work_sync_original_operation_unavailable")
		}
		row, e := oneMap(ctx, db, "SELECT * FROM work_sync_jobs WHERE id=? AND owner_id=? AND endpoint=?", job["id"], owner, u.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		if row == nil {
			return connectionFailure("work_sync_original_operation_unavailable")
		}
		if isOne(text(row["state"]), "local-deleted", "deleted") || row["state"] == "stored" && state != "deleted" {
			out = workUploadView(row)
			return nil
		}
		if _, e = db.ExecContext(ctx, "UPDATE work_sync_jobs SET state=?,error_code=?,updated_at=? WHERE id=? AND owner_id=? AND endpoint=?", state, code, localNow(), job["id"], owner, u.runtime.config.Endpoint); e != nil {
			return e
		}
		if state == "stored" {
			if _, e = db.ExecContext(ctx, "UPDATE work_sync_scopes SET last_token=? WHERE owner_id=? AND endpoint=? AND work_id=? AND scope_id=?", job["source_token"], owner, u.runtime.config.Endpoint, job["work_id"], job["scope_id"]); e != nil {
				return e
			}
		}
		if state == "deleted" {
			if _, e = db.ExecContext(ctx, "UPDATE work_sync_scopes SET blocked=1 WHERE owner_id=? AND endpoint=? AND work_id=? AND scope_id=?", owner, u.runtime.config.Endpoint, job["work_id"], job["scope_id"]); e != nil {
				return e
			}
		}
		row["state"], row["error_code"], row["updated_at"] = state, code, localNow()
		out = workUploadView(row)
		return nil
	})
	return out, e
}
