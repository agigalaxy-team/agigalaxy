package native

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"io"
	_ "modernc.org/sqlite"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const CoordinationFile = ".galaxy-coordination.sqlite"

type Store struct{ Directory, Endpoint string }

func NewStore(directory, endpoint string) (*Store, error) {
	if !filepath.IsAbs(directory) {
		return nil, fault.New("native_data_directory_must_be_absolute", 400)
	}
	return &Store{filepath.Clean(directory), endpoint}, nil
}
func exists(path string) (bool, error) {
	_, e := os.Stat(path)
	if errors.Is(e, os.ErrNotExist) {
		return false, nil
	}
	return e == nil, e
}
func readJSON(path string, v any) (bool, error) {
	b, e := os.ReadFile(path)
	if errors.Is(e, os.ErrNotExist) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if len(b) > 8<<20 {
		return false, fault.New("native_record_invalid", 409)
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.UseNumber()
	if e = d.Decode(v); e != nil {
		return false, e
	}
	var tail any
	if d.Decode(&tail) != io.EOF {
		return false, fault.New("native_record_invalid", 409)
	}
	return true, nil
}
func readFallback(directory, canonical, legacy string, v any) error {
	ok, e := readJSON(filepath.Join(directory, canonical), v)
	if e != nil || ok {
		return e
	}
	_, e = readJSON(filepath.Join(directory, legacy), v)
	return e
}
func openSQLite(path string, write bool) (*sql.DB, error) {
	q := url.Values{}
	if write {
		q.Set("mode", "rw")
	} else {
		q.Set("mode", "ro")
	}
	uriPath := filepath.ToSlash(path)
	if filepath.VolumeName(path) != "" && !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	u := url.URL{Scheme: "file", Path: uriPath, RawQuery: q.Encode()}
	db, e := sql.Open("sqlite", u.String())
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	return db, nil
}
func busy(err error) bool {
	var c interface{ Code() int }
	return errors.As(err, &c) && (c.Code()&255 == 5 || c.Code()&255 == 6)
}

// Uses the same SQLite transaction lock as Node/Bun, not a process-only mutex.
// Read-only calls never create a directory, key, database or migrated record.
func (s *Store) With(ctx context.Context, write bool, operation func(string) error) error {
	dir := s.Directory
	if write {
		if e := os.MkdirAll(dir, 0700); e != nil {
			return e
		}
		resolved, e := filepath.EvalSymlinks(dir)
		if e != nil {
			return e
		}
		dir = resolved
		legacy, e := exists(filepath.Join(dir, ".galaxy-write.lock"))
		if e != nil {
			return e
		}
		if legacy {
			return fault.New("native_legacy_write_lock_exists", 409)
		}
		f, e := os.OpenFile(filepath.Join(dir, CoordinationFile), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		if e = f.Close(); e != nil {
			return e
		}
	}
	path := filepath.Join(dir, CoordinationFile)
	for {
		present, e := exists(path)
		if e != nil {
			return e
		}
		if present {
			return coordinate(ctx, path, write, func() error { return operation(dir) })
		}
		if e = operation(dir); e != nil {
			return e
		}
		present, e = exists(path)
		if e != nil {
			return e
		}
		if !present {
			return nil
		}
	}
}
func coordinate(ctx context.Context, path string, write bool, operation func() error) error {
	deadline := time.Now().Add(10 * time.Second)
	for {
		db, e := openSQLite(path, write)
		if e != nil {
			return e
		}
		conn, e := db.Conn(ctx)
		if e != nil {
			db.Close()
			return e
		}
		_, e = conn.ExecContext(ctx, "PRAGMA busy_timeout=0")
		if e == nil {
			if write {
				_, e = conn.ExecContext(ctx, "BEGIN EXCLUSIVE")
			} else {
				_, e = conn.ExecContext(ctx, "BEGIN; SELECT count(*) FROM sqlite_schema")
			}
		}
		if e == nil {
			e = operation()
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
			conn.Close()
			db.Close()
			return e
		}
		conn.Close()
		db.Close()
		if !busy(e) {
			return e
		}
		if !time.Now().Before(deadline) {
			return fault.New("local_storage_busy", 409)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}
func (s *Store) ownerWithin(dir, requested string) (string, error) {
	for _, name := range []string{".galaxy-initialization.json", ".galaxy-reset.json"} {
		yes, e := exists(filepath.Join(dir, name))
		if e != nil {
			return "", e
		}
		if yes {
			return "", fault.New("local_work_identity_recovery_required", 409)
		}
	}
	var local map[string]any
	if e := readFallback(dir, "galaxy-id.json", "node.json", &local); e != nil {
		return "", e
	}
	owner, _ := local["id"].(string)
	if s.Endpoint != "" {
		var selection struct {
			Version    int             `json:"version"`
			Revision   int64           `json:"revision"`
			Active     json.RawMessage `json:"active"`
			Permission json.RawMessage `json:"permission"`
		}
		key := "native-selection:" + s.Endpoint
		ok, e := readJSON(filepath.Join(dir, "native-v2", "records", identity.Digest([]byte(key))+".json"), &selection)
		if e != nil {
			return "", e
		}
		if ok {
			if selection.Version != 1 || selection.Revision < 1 || selection.Revision > 9007199254740991 || selection.Active == nil || selection.Permission == nil {
				return "", fault.New("native_selection_invalid", 409)
			}
			if string(selection.Active) != "null" {
				var active struct {
					SubjectID string `json:"subjectId"`
				}
				if json.Unmarshal(selection.Active, &active) != nil {
					return "", fault.New("native_selection_invalid", 409)
				}
				owner = active.SubjectID
			} else {
				owner = ""
			}
		}
		if !ok {
			var active struct {
				SubjectID string `json:"subjectId"`
			}
			_, e = readJSON(filepath.Join(dir, "native-v2", "records", identity.Digest([]byte("native-active:"+s.Endpoint))+".json"), &active)
			if e != nil {
				return "", e
			}
			if active.SubjectID != "" {
				owner = active.SubjectID
			}
		}
	}
	if owner == "" {
		owner, _ = local["id"].(string)
	}
	if requested != "" && requested != owner {
		return "", fault.New("local_work_identity_changed", 409)
	}
	return owner, nil
}
func (s *Store) Identity(ctx context.Context) (map[string]any, error) {
	var result map[string]any
	e := s.With(ctx, false, func(dir string) error {
		var v map[string]any
		if e := readFallback(dir, "galaxy-id.json", "node.json", &v); e != nil {
			return e
		}
		result = v
		return nil
	})
	return result, e
}
func (s *Store) Owner(ctx context.Context) (string, error) {
	var owner string
	e := s.With(ctx, false, func(dir string) error { var e error; owner, e = s.ownerWithin(dir, ""); return e })
	return owner, e
}
func writeJSON(path string, value any) error {
	b, e := protocol.Encode(value)
	if e != nil {
		return e
	}
	b = append(b, '\n')
	f, e := os.CreateTemp(filepath.Dir(path), ".galaxy-*.tmp")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	if e = os.Rename(name, path); e != nil {
		return fmt.Errorf("native_atomic_save: %w", e)
	}
	return nil
}

func rowsMaps(ctx context.Context, db interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, query string, args ...any) ([]map[string]any, error) {
	rows, e := db.QueryContext(ctx, query, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	cols, e := rows.Columns()
	if e != nil {
		return nil, e
	}
	result := []map[string]any{}
	for rows.Next() {
		v := make([]any, len(cols))
		ptr := make([]any, len(cols))
		for i := range v {
			ptr[i] = &v[i]
		}
		if e = rows.Scan(ptr...); e != nil {
			return nil, e
		}
		m := map[string]any{}
		for i, k := range cols {
			if b, ok := v[i].([]byte); ok {
				v[i] = string(b)
			}
			if strings.HasSuffix(k, "_json") && v[i] != nil && !json.Valid([]byte(fmt.Sprint(v[i]))) {
				return nil, fault.New("native_record_invalid", 409)
			}
			m[k] = v[i]
		}
		result = append(result, m)
	}
	return result, rows.Err()
}
func oneMap(ctx context.Context, db *sql.DB, q string, args ...any) (map[string]any, error) {
	r, e := rowsMaps(ctx, db, q, args...)
	if e != nil || len(r) == 0 {
		return nil, e
	}
	return r[0], nil
}
func decoded(v any) any {
	if v == nil {
		return nil
	}
	var out any
	d := json.NewDecoder(strings.NewReader(fmt.Sprint(v)))
	d.UseNumber()
	if d.Decode(&out) != nil {
		return nil
	}
	return out
}
func array(v any) any {
	a := decoded(v)
	if a == nil {
		return []any{}
	}
	return a
}
func integer(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case json.Number:
		r, _ := n.Int64()
		return r
	case int:
		return int64(n)
	}
	return 0
}
func text(v any) string {
	if v == nil {
		return ""
	}
	s, _ := v.(string)
	return s
}
