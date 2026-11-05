package native

import (
	"context"
	"database/sql"
)

const workLearningDDL = `CREATE TABLE IF NOT EXISTS work_review_cursor(work_id TEXT PRIMARY KEY,through_sequence INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS work_review_lease(work_id TEXT PRIMARY KEY,review_id TEXT NOT NULL,owner_id TEXT NOT NULL,after_sequence INTEGER NOT NULL,through_sequence INTEGER NOT NULL,expected_revision INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS work_review_experience(review_id TEXT NOT NULL,owner_id TEXT NOT NULL,experience_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(review_id,experience_id));
CREATE TABLE IF NOT EXISTS work_experience(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,conditions TEXT NOT NULL,method TEXT NOT NULL,limitations TEXT NOT NULL,outcome TEXT NOT NULL,source_work_id TEXT NOT NULL,through_sequence INTEGER NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_experience_revision(id TEXT NOT NULL,revision INTEGER NOT NULL,owner_id TEXT NOT NULL,source_work_id TEXT NOT NULL,through_sequence INTEGER NOT NULL,value_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE VIRTUAL TABLE IF NOT EXISTS work_experience_search USING fts5(id UNINDEXED,owner_id UNINDEXED,title,conditions,method,limitations,tokenize='trigram');
CREATE TABLE IF NOT EXISTS work_experience_sources(id TEXT NOT NULL,revision INTEGER NOT NULL,owner_id TEXT NOT NULL,work_id TEXT NOT NULL,PRIMARY KEY(id,revision,work_id));
CREATE TABLE IF NOT EXISTS work_experience_retired(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL);`

func ensureWorkLearning(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, workLearningDDL)
	return err
}

func deleteWorkLearningWithin(ctx context.Context, db *sql.DB, owner, workID string) error {
	table, err := oneMap(ctx, db, "SELECT name FROM sqlite_schema WHERE name='work_experience_sources'")
	if err != nil {
		return err
	}
	if table == nil {
		return nil
	}
	// Keep independently sourced revisions, but never restore one as current.
	_, err = db.ExecContext(ctx, "INSERT OR IGNORE INTO work_experience_retired(id,owner_id) SELECT e.id,e.owner_id FROM work_experience e JOIN work_experience_sources s ON s.id=e.id AND s.revision=e.revision AND s.owner_id=e.owner_id WHERE s.owner_id=? AND s.work_id=?", owner, workID)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "DELETE FROM work_experience_search WHERE id IN (SELECT id FROM work_experience_retired WHERE owner_id=?) AND owner_id=?", owner, owner)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "UPDATE work_experience SET title='',conditions='',method='',limitations='',outcome='',source_work_id='',through_sequence=0 WHERE owner_id=? AND id IN (SELECT id FROM work_experience_retired WHERE owner_id=?)", owner, owner)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "DELETE FROM work_experience_revision WHERE owner_id=? AND (id,revision) IN (SELECT id,revision FROM work_experience_sources WHERE owner_id=? AND work_id=?)", owner, owner, workID)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "DELETE FROM work_experience_sources WHERE owner_id=? AND NOT EXISTS (SELECT 1 FROM work_experience_revision r WHERE r.id=work_experience_sources.id AND r.revision=work_experience_sources.revision AND r.owner_id=work_experience_sources.owner_id)", owner)
	if err != nil {
		return err
	}
	if _, err = db.ExecContext(ctx, "DELETE FROM work_review_experience WHERE review_id IN (SELECT review_id FROM work_review_lease WHERE work_id=?)", workID); err != nil {
		return err
	}
	if _, err = db.ExecContext(ctx, "DELETE FROM work_review_cursor WHERE work_id=?", workID); err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "DELETE FROM work_review_lease WHERE work_id=?", workID)
	return err
}

// Older history databases may not have opted into local learning yet.
func reviewedSequenceWithin(ctx context.Context, db *sql.DB, workID any) (int64, error) {
	table, e := oneMap(ctx, db, "SELECT name FROM sqlite_schema WHERE name='work_review_cursor'")
	if e != nil || table == nil {
		return 0, e
	}
	row, e := oneMap(ctx, db, "SELECT through_sequence FROM work_review_cursor WHERE work_id=?", workID)
	if e != nil {
		return 0, e
	}
	return integer(row["through_sequence"]), nil
}
