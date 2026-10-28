package native

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

// Called only while the source Store transaction owns the coordination write
// lock. Queue and source remain separate databases: queue COMMIT happens before
// source COMMIT. Queue failure rolls the source back; source failure can leave a
// retained source with its queue safely stopped, and the same deletion can retry.
func (s *Store) cancelDeletedSourceQueueWithin(ctx context.Context, owner, source string, archive bool) (err error) {
	area, domain := "work-history", "work"
	if archive {
		area, domain = "conversation-archive", "archive"
	}
	defer func() {
		if err != nil {
			err = fmt.Errorf("%w: %w", fault.New("local_"+domain+"_queue_cancel_failed", 409), err)
		}
	}()
	path := filepath.Join(s.Directory, area, "sync.sqlite")
	present, e := exists(path)
	if e != nil {
		return e
	}
	if !present {
		return nil
	}
	if e = os.Chmod(path, 0600); e != nil {
		return e
	}
	db, e := openSQLite(path, true)
	if e != nil {
		return e
	}
	defer db.Close()
	if _, e = db.ExecContext(ctx, "BEGIN IMMEDIATE"); e != nil {
		return e
	}
	defer db.ExecContext(context.Background(), "ROLLBACK")
	if archive {
		if _, e = db.ExecContext(ctx, "DELETE FROM sync_chunks WHERE job_id IN (SELECT id FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=?)", owner, s.Endpoint, source); e != nil {
			return e
		}
		if _, e = db.ExecContext(ctx, "UPDATE sync_jobs SET state='local-deleted',updated_at=? WHERE owner_id=? AND endpoint=? AND archive_id=?", localNow(), owner, s.Endpoint, source); e != nil {
			return e
		}
	} else {
		if _, e = db.ExecContext(ctx, "UPDATE work_sync_jobs SET state='local-deleted',data_json='null' WHERE owner_id=? AND endpoint=? AND work_id=?", owner, s.Endpoint, source); e != nil {
			return e
		}
		if _, e = db.ExecContext(ctx, "UPDATE work_sync_scopes SET blocked=1 WHERE owner_id=? AND endpoint=? AND work_id=?", owner, s.Endpoint, source); e != nil {
			return e
		}
	}
	_, e = db.ExecContext(ctx, "COMMIT")
	return e
}
