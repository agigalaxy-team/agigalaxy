package native

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"sort"
)

type ArchiveUpload struct{ runtime *Runtime }

func NewArchiveUpload(runtime *Runtime) *ArchiveUpload { return &ArchiveUpload{runtime: runtime} }

const archiveSyncDDL = `CREATE TABLE IF NOT EXISTS sync_choices(owner_id TEXT NOT NULL,endpoint TEXT NOT NULL,body_json TEXT NOT NULL,PRIMARY KEY(owner_id,endpoint));
CREATE TABLE IF NOT EXISTS sync_jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,endpoint TEXT NOT NULL,target_id TEXT NOT NULL,archive_id TEXT NOT NULL,source_revision INTEGER NOT NULL,scope_id TEXT NOT NULL,choice_id TEXT NOT NULL,title TEXT NOT NULL,selection_json TEXT NOT NULL,state TEXT NOT NULL,chunk_count INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error_code TEXT,UNIQUE(owner_id,endpoint,target_id,archive_id,source_revision,scope_id));
CREATE TABLE IF NOT EXISTS sync_chunks(job_id TEXT NOT NULL,sequence INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(job_id,sequence));`

func (a *ArchiveUpload) access(ctx context.Context, write, create bool, owner string, expected *ChoiceScope, run func(*sql.DB, string) error) error {
	return a.runtime.store.With(ctx, write, func(dir string) error {
		if e := a.runtime.store.verifyChoiceWithin(dir, expected); e != nil {
			return e
		}
		current, e := a.runtime.store.ownerWithin(dir, owner)
		if e != nil {
			return e
		}
		if current == "" && write {
			return connectionFailure("local_identity_required")
		}
		path := filepath.Join(dir, "conversation-archive", "sync.sqlite")
		present, e := exists(path)
		if e != nil {
			return e
		}
		if current == "" || !present && !create {
			return run(nil, current)
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
				if _, e = db.ExecContext(ctx, archiveSyncDDL); e != nil {
					return e
				}
			}
			if _, e = db.ExecContext(ctx, "BEGIN IMMEDIATE"); e != nil {
				return e
			}
			defer db.ExecContext(context.Background(), "ROLLBACK")
		}
		if e = run(db, current); e != nil {
			return e
		}
		if write {
			_, e = db.ExecContext(ctx, "COMMIT")
		}
		return e
	})
}
func archiveUploadChoice(ctx context.Context, db *sql.DB, owner, endpoint string) (map[string]any, error) {
	defaults := map[string]any{"enabled": false, "choiceId": nil, "targetAccountId": nil, "archiveSessionIds": []any{}, "scopeIds": map[string]any{}, "revision": 0}
	if db == nil {
		return defaults, nil
	}
	row, e := oneMap(ctx, db, "SELECT body_json FROM sync_choices WHERE owner_id=? AND endpoint=?", owner, endpoint)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return defaults, nil
	}
	value, ok := decoded(row["body_json"]).(map[string]any)
	if !ok {
		return nil, connectionFailure("archive_sync_choice_invalid")
	}
	return value, nil
}
func archiveUploadView(row map[string]any) map[string]any {
	return map[string]any{"id": row["id"], "archiveSessionId": row["archive_id"], "sourceRevision": row["source_revision"], "targetAccountId": row["target_id"], "scopeId": row["scope_id"], "state": row["state"], "chunkCount": row["chunk_count"], "updatedAt": row["updated_at"], "error": row["error_code"]}
}
func (a *ArchiveUpload) Settings(ctx context.Context) (any, error) {
	var out any
	e := a.access(ctx, false, false, "", nil, func(db *sql.DB, owner string) error {
		choice, e := archiveUploadChoice(ctx, db, owner, a.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		stopped := []string{}
		queue := []any{}
		if db != nil {
			for id, scope := range uploadObject(choice["scopeIds"]) {
				row, e := oneMap(ctx, db, "SELECT 1 FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state='deleted' LIMIT 1", owner, a.runtime.config.Endpoint, id, scope)
				if e != nil {
					return e
				}
				if row != nil {
					stopped = append(stopped, id)
				}
			}
			rows, e := rowsMaps(ctx, db, "SELECT * FROM sync_jobs WHERE owner_id=? AND endpoint=? ORDER BY created_at DESC LIMIT 100", owner, a.runtime.config.Endpoint)
			if e != nil {
				return e
			}
			for _, row := range rows {
				queue = append(queue, archiveUploadView(row))
			}
		}
		sort.Strings(stopped)
		out = map[string]any{"galaxyId": nullableText(owner), "endpoint": a.runtime.config.Endpoint, "choice": choice, "stoppedArchiveSessionIds": stopped, "queue": queue, "localOnly": true}
		return nil
	})
	return out, e
}
func (a *ArchiveUpload) job(ctx context.Context, id string, scope *ChoiceScope) (map[string]any, error) {
	var out map[string]any
	e := a.access(ctx, false, false, scope.Owner, scope, func(db *sql.DB, owner string) error {
		if db == nil {
			return connectionFailure("archive_sync_original_snapshot_unavailable")
		}
		var e error
		out, e = oneMap(ctx, db, "SELECT * FROM sync_jobs WHERE id=? AND owner_id=? AND endpoint=?", id, owner, a.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		if out == nil {
			return connectionFailure("archive_sync_original_snapshot_unavailable")
		}
		return nil
	})
	return out, e
}
func (a *ArchiveUpload) allowed(ctx context.Context, job map[string]any, scope *ChoiceScope) error {
	if pending, e := a.runtime.uploadPendingDelete(ctx, UploadCloudQuery{TargetAccountID: text(job["target_id"]), ID: text(job["id"])}, "archive", scope); e != nil {
		return e
	} else if pending {
		return connectionFailure("cloud_delete_result_unresolved")
	}
	privacy, owner, e := a.runtime.ReadUploadPrivacy(ctx, scope)
	if e != nil {
		return e
	}
	if owner != job["owner_id"] || !privacy.IncludeFullConversations || !connectionIncludes(privacy.SessionIDs, text(job["archive_id"])) {
		return connectionFailure("upload_privacy_conversation_scope_not_allowed")
	}
	return a.access(ctx, false, false, scope.Owner, scope, func(db *sql.DB, owner string) error {
		if db == nil {
			return connectionFailure("archive_sync_original_snapshot_unavailable")
		}
		choice, e := archiveUploadChoice(ctx, db, owner, a.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		ids, _ := connectionStrings(choice["archiveSessionIds"])
		if choice["enabled"] != true || choice["targetAccountId"] != job["target_id"] || uploadObject(choice["scopeIds"])[text(job["archive_id"])] != job["scope_id"] || !connectionIncludes(ids, text(job["archive_id"])) {
			return connectionFailure("archive_sync_scope_changed")
		}
		current, e := oneMap(ctx, db, "SELECT state FROM sync_jobs WHERE id=? AND owner_id=? AND endpoint=?", job["id"], owner, a.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		if current == nil || isOne(text(current["state"]), "deleted", "expired", "local-deleted") {
			return connectionFailure("archive_sync_scope_changed")
		}
		return nil
	})
}
func (a *ArchiveUpload) mark(ctx context.Context, job map[string]any, scope *ChoiceScope, state string, code any) (map[string]any, error) {
	var out map[string]any
	e := a.access(ctx, true, false, scope.Owner, scope, func(db *sql.DB, owner string) error {
		if db == nil {
			return connectionFailure("archive_sync_original_snapshot_unavailable")
		}
		row, e := oneMap(ctx, db, "SELECT * FROM sync_jobs WHERE id=? AND owner_id=? AND endpoint=?", job["id"], owner, a.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		if row == nil {
			return connectionFailure("archive_sync_original_snapshot_unavailable")
		}
		if isOne(text(row["state"]), "deleted", "expired", "local-deleted") || row["state"] == "ready" && state == "unknown" {
			out = archiveUploadView(row)
			return nil
		}
		stamp := localNow()
		if _, e = db.ExecContext(ctx, "UPDATE sync_jobs SET state=?,error_code=?,updated_at=? WHERE id=? AND owner_id=? AND endpoint=?", state, code, stamp, job["id"], owner, a.runtime.config.Endpoint); e != nil {
			return e
		}
		if isOne(state, "ready", "deleted", "expired") {
			if _, e = db.ExecContext(ctx, "DELETE FROM sync_chunks WHERE job_id=?", job["id"]); e != nil {
				return e
			}
		}
		row["state"], row["error_code"], row["updated_at"] = state, code, stamp
		out = archiveUploadView(row)
		return nil
	})
	return out, e
}
