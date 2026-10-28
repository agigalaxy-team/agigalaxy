package native

import (
	"context"
	"database/sql"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"os"
	"path/filepath"
	"time"
)

type ArchiveSession struct {
	Host      string `json:"host"`
	SessionID string `json:"sessionId"`
}
type ArchiveSettings struct {
	Enabled            bool             `json:"enabled"`
	Sessions           []ArchiveSession `json:"sessions"`
	AutoCleanAfterDays *int             `json:"autoCleanAfterDays"`
}
type ArchiveInput struct {
	GalaxyID           string           `json:"galaxyId,omitempty"`
	Enabled            *bool            `json:"enabled"`
	Sessions           []ArchiveSession `json:"sessions"`
	AutoCleanAfterDays *int             `json:"autoCleanAfterDays,omitempty"`
}

const archiveDDL = `CREATE TABLE IF NOT EXISTS archive_preferences(owner_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS archive_sessions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,host TEXT NOT NULL,session_id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,workspace_id TEXT,revision INTEGER NOT NULL DEFAULT 0,UNIQUE(owner_id,host,session_id));
CREATE TABLE IF NOT EXISTS archive_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,message_id TEXT NOT NULL,captured_at TEXT NOT NULL,body_json TEXT NOT NULL,UNIQUE(session_id,message_id));`

func (s *Store) archive(ctx context.Context, write bool, requested string, expected *ChoiceScope, run func(*sql.DB, string) error) error {
	return s.With(ctx, write, func(dir string) error {
		if e := s.verifyChoiceWithin(dir, expected); e != nil {
			return e
		}
		owner, e := s.ownerWithin(dir, requested)
		if e != nil {
			return e
		}
		if owner == "" {
			if write {
				return fault.New("local_archive_identity_required", 409)
			}
			return run(nil, "")
		}
		folder := filepath.Join(dir, "conversation-archive")
		path := filepath.Join(folder, "private.sqlite")
		present, e := exists(path)
		if e != nil {
			return e
		}
		if !write && !present {
			return run(nil, owner)
		}
		if write {
			if e = os.MkdirAll(folder, 0700); e != nil {
				return e
			}
			f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
			if e != nil {
				return e
			}
			f.Close()
		}
		db, e := openSQLite(path, write)
		if e != nil {
			return e
		}
		defer db.Close()
		if write {
			if _, e = db.ExecContext(ctx, archiveDDL); e != nil {
				return e
			}
			columns, e := rowsMaps(ctx, db, "PRAGMA table_info(archive_sessions)")
			if e != nil {
				return e
			}
			have := map[string]bool{}
			for _, c := range columns {
				have[text(c["name"])] = true
			}
			for _, c := range []struct{ name, sql string }{{"revision", "ALTER TABLE archive_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"}, {"workspace_id", "ALTER TABLE archive_sessions ADD COLUMN workspace_id TEXT"}} {
				if !have[c.name] {
					if _, e = db.ExecContext(ctx, c.sql); e != nil {
						return e
					}
				}
			}
			if _, e = db.ExecContext(ctx, "BEGIN IMMEDIATE"); e != nil {
				return e
			}
			defer db.ExecContext(context.Background(), "ROLLBACK")
		}
		if e = run(db, owner); e != nil {
			return e
		}
		if write {
			_, e = db.ExecContext(ctx, "COMMIT")
		}
		return e
	})
}
func archivePreferences(ctx context.Context, db *sql.DB, owner string) (ArchiveSettings, error) {
	p := ArchiveSettings{Sessions: []ArchiveSession{}}
	if db == nil {
		return p, nil
	}
	r, e := oneMap(ctx, db, "SELECT settings_json FROM archive_preferences WHERE owner_id=?", owner)
	if e != nil {
		return p, e
	}
	if r != nil {
		if e = protocol.Decode([]byte(text(r["settings_json"])), &p); e != nil {
			return p, e
		}
	}
	return p, nil
}
func (s *Store) ArchiveSettings(ctx context.Context) (any, error) {
	var out any
	e := s.archive(ctx, false, "", nil, func(db *sql.DB, owner string) error {
		p, e := archivePreferences(ctx, db, owner)
		if e != nil {
			return e
		}
		var id any
		if owner != "" {
			id = owner
		}
		out = map[string]any{"galaxyId": id, "settings": p, "localOnly": true, "uploadStarted": false}
		return nil
	})
	return out, e
}
func ValidateArchive(x ArchiveInput) error {
	if x.Enabled == nil || x.Sessions == nil || len(x.Sessions) > 500 || protocol.TextLength(x.GalaxyID) > 512 {
		return fault.New("local_archive_input_invalid", 400)
	}
	if x.AutoCleanAfterDays != nil && (*x.AutoCleanAfterDays < 1 || *x.AutoCleanAfterDays > 36500) {
		return fault.New("local_archive_input_invalid", 400)
	}
	for _, p := range x.Sessions {
		if p.Host == "" || p.SessionID == "" || protocol.TextLength(p.Host) > 512 || protocol.TextLength(p.SessionID) > 512 {
			return fault.New("local_archive_input_invalid", 400)
		}
	}
	if *x.Enabled && len(x.Sessions) == 0 {
		return fault.New("local_archive_session_scope_required", 400)
	}
	return nil
}
func (s *Store) ConfigureArchive(ctx context.Context, x ArchiveInput) (any, error) {
	return s.configureArchive(ctx, x, nil)
}
func (s *Store) configureArchive(ctx context.Context, x ArchiveInput, scope *ChoiceScope) (any, error) {
	if e := ValidateArchive(x); e != nil {
		return nil, e
	}
	var out any
	e := s.archive(ctx, true, x.GalaxyID, scope, func(db *sql.DB, owner string) error {
		sessions := []ArchiveSession{}
		seen := map[ArchiveSession]bool{}
		for _, v := range x.Sessions {
			if !seen[v] {
				seen[v] = true
				sessions = append(sessions, v)
			}
		}
		p := ArchiveSettings{*x.Enabled, sessions, x.AutoCleanAfterDays}
		raw, e := protocol.Encode(p)
		if e != nil {
			return e
		}
		if _, e = db.ExecContext(ctx, "INSERT INTO archive_preferences(owner_id,settings_json) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET settings_json=excluded.settings_json", owner, string(raw)); e != nil {
			return e
		}
		now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		for _, v := range sessions {
			if _, e = db.ExecContext(ctx, "INSERT OR IGNORE INTO archive_sessions(id,owner_id,host,session_id,created_at,updated_at) VALUES(?,?,?,?,?,?)", uuid.NewString(), owner, v.Host, v.SessionID, now, now); e != nil {
				return e
			}
		}
		var deleted int64
		if p.AutoCleanAfterDays != nil {
			cutoff := time.Now().UTC().AddDate(0, 0, -*p.AutoCleanAfterDays).Format("2006-01-02T15:04:05.000Z")
			r, e := db.ExecContext(ctx, "DELETE FROM archive_messages WHERE session_id IN (SELECT id FROM archive_sessions WHERE owner_id=?) AND captured_at<?", owner, cutoff)
			if e != nil {
				return e
			}
			deleted, _ = r.RowsAffected()
		}
		out = map[string]any{"galaxyId": owner, "settings": p, "deletedMessages": deleted, "uploadStarted": false, "localOnly": true}
		return nil
	})
	return out, e
}
