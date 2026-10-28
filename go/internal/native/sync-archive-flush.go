package native

import (
	"context"
	"database/sql"
	"fmt"
)

// Flush reconciles saved original jobs before preparing the current selected
// source window. Unknown delivery stops that source; it never rotates its ID.
func (a *ArchiveUpload) Flush(ctx context.Context, archiveID string) (any, error) {
	if archiveID != "" && !controlUUID(archiveID) {
		return nil, connectionFailure("archive_sync_input_invalid")
	}
	expected, e := uploadChoiceScope(ctx, a.runtime.store)
	if e != nil {
		return nil, e
	}
	ctx = uploadScopeContext(ctx, expected)
	settings, e := a.Settings(ctx)
	if e != nil {
		return nil, e
	}
	state := settings.(map[string]any)
	if state["galaxyId"] != expected.Owner {
		return nil, connectionFailure("archive_sync_identity_changed")
	}
	choice := uploadObject(state["choice"])
	items := []any{}
	if choice["enabled"] != true {
		return map[string]any{"state": "not-selected", "items": items, "networkStarted": false}, nil
	}
	ids, _ := connectionStrings(choice["archiveSessionIds"])
	if archiveID != "" {
		ids = []string{archiveID}
	}
	for _, id := range ids {
		if !connectionIncludes(mustUploadStrings(choice["archiveSessionIds"]), id) {
			continue
		}
		description, e := a.runtime.store.ArchiveDescribe(ctx, ArchiveQuery{GalaxyID: expected.Owner, ArchiveSessionID: id})
		if e != nil {
			return nil, e
		}
		if description == nil {
			e = a.access(ctx, true, false, expected.Owner, &expected, func(db *sql.DB, owner string) error {
				if db == nil {
					return nil
				}
				if _, e := db.ExecContext(ctx, "DELETE FROM sync_chunks WHERE job_id IN (SELECT id FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=?)", owner, a.runtime.config.Endpoint, id); e != nil {
					return e
				}
				_, e := db.ExecContext(ctx, "UPDATE sync_jobs SET state='local-deleted',updated_at=? WHERE owner_id=? AND endpoint=? AND archive_id=?", localNow(), owner, a.runtime.config.Endpoint, id)
				return e
			})
			if e != nil {
				return nil, e
			}
			continue
		}
		var prior []map[string]any
		e = a.access(ctx, false, false, expected.Owner, &expected, func(db *sql.DB, owner string) error {
			if db == nil {
				return nil
			}
			var e error
			args := []any{owner, a.runtime.config.Endpoint, id, uploadObject(choice["scopeIds"])[id]}
			ready, e := oneMap(ctx, db, "SELECT * FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state='ready' ORDER BY created_at DESC LIMIT 1", args...)
			if e != nil {
				return e
			}
			prior, e = rowsMaps(ctx, db, "SELECT * FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state NOT IN ('ready','deleted','expired','local-deleted') ORDER BY created_at", args...)
			if ready != nil {
				prior = append([]map[string]any{ready}, prior...)
			}
			return e
		})
		if e != nil {
			return nil, e
		}
		stop := false
		seen := map[string]bool{}
		for _, job := range prior {
			operation := text(job["id"])
			seen[operation] = true
			result, e := a.Resume(ctx, operation)
			if e != nil {
				items = append(items, map[string]any{"archiveSessionId": id, "state": "not-synced", "error": runtimeErrorCode(e)})
				stop = true
				break
			}
			items = append(items, result)
			if isOne(text(uploadObject(result)["state"]), "unknown", "deleted") {
				stop = true
				break
			}
		}
		if stop {
			continue
		}
		var saved bool
		e = a.access(ctx, false, false, expected.Owner, &expected, func(db *sql.DB, owner string) error {
			if db == nil {
				return nil
			}
			row, e := oneMap(ctx, db, "SELECT 1 FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state='ready' AND (source_revision=? OR CAST(source_revision AS TEXT) LIKE ?) LIMIT 1", owner, a.runtime.config.Endpoint, id, uploadObject(choice["scopeIds"])[id], uploadObject(description)["revision"], fmt.Sprintf("%d:%%:done", integer(uploadObject(description)["revision"])))
			saved = row != nil
			return e
		})
		if e != nil {
			return nil, e
		}
		if saved {
			continue
		}
		after := int64(0)
		for {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			prepared, e := a.Prepare(ctx, id, after)
			if e != nil {
				items = append(items, map[string]any{"archiveSessionId": id, "state": "not-synced", "error": runtimeErrorCode(e)})
				break
			}
			view := uploadObject(prepared)
			job := uploadObject(view["job"])
			operation := text(job["id"])
			if operation == "" {
				break
			}
			if !seen[operation] {
				seen[operation] = true
				result, e := a.Resume(ctx, operation)
				if e != nil {
					items = append(items, map[string]any{"archiveSessionId": id, "state": "not-synced", "error": runtimeErrorCode(e)})
					break
				}
				items = append(items, result)
				if isOne(text(uploadObject(result)["state"]), "unknown", "deleted") {
					break
				}
			}
			if view["nextAfter"] == nil {
				break
			}
			next := integer(view["nextAfter"])
			if next <= after {
				return nil, connectionFailure("archive_sync_original_snapshot_unavailable")
			}
			after = next
		}
	}
	return map[string]any{"state": "processed", "items": items}, nil
}
func mustUploadStrings(value any) []string { ids, _ := connectionStrings(value); return ids }
