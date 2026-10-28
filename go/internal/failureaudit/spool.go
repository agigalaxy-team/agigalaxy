package failureaudit

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Writer func(context.Context, Event) (Result, error)

// Diagnostic deliberately excludes error values, request bodies and headers.
type Diagnostic struct {
	Event     string `json:"event"`
	Stage     string `json:"stage,omitempty"`
	Code      string `json:"code,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	Delivery  string `json:"delivery,omitempty"`
	Pending   *int   `json:"pending,omitempty"`
}
type SpoolOptions struct {
	Path, Endpoint string
	Write          Writer
	MaxEvents      int
	Interval       time.Duration
	BatchSize      int
	Logger         func(Diagnostic)
}
type Status struct {
	Ready    bool   `json:"ready"`
	Closed   bool   `json:"closed,omitempty"`
	Pending  *int   `json:"pending"`
	Delivery string `json:"delivery"`
}
type Spool struct {
	mu                       sync.Mutex
	db                       *sql.DB
	options                  SpoolOptions
	closed, storageAvailable bool
	delivery                 string
	active                   chan struct{}
	stop                     chan struct{}
	timerDone                chan struct{}
	closeDone                chan struct{}
	closeErr                 error
}

func NewSpool(options SpoolOptions) (*Spool, error) {
	if options.MaxEvents == 0 {
		options.MaxEvents = 10000
	}
	if options.Interval == 0 {
		options.Interval = time.Second
	}
	if options.BatchSize == 0 {
		options.BatchSize = 32
	}
	if !filepath.IsAbs(options.Path) || options.Write == nil || options.MaxEvents < 1 || options.MaxEvents > 10000 || options.Interval < 10*time.Millisecond || options.Interval > 60*time.Second || options.BatchSize < 1 || options.BatchSize > 100 {
		return nil, safeError("failure_audit_spool_configuration_invalid")
	}
	f, e := os.OpenFile(options.Path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e == nil {
		e = f.Close()
	} else if os.IsExist(e) {
		e = nil
	}
	if e != nil {
		return nil, safeError("failure_audit_spool_file_invalid")
	}
	info, e := os.Lstat(options.Path)
	if e != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return nil, safeError("failure_audit_spool_file_invalid")
	}
	db, e := sql.Open("sqlite", options.Path)
	if e != nil {
		return nil, safeError("failure_audit_spool_unavailable")
	}
	db.SetMaxOpenConns(1)
	fail := func() (*Spool, error) { _ = db.Close(); return nil, safeError("failure_audit_spool_unavailable") }
	if _, e = db.Exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=8192; PRAGMA wal_autocheckpoint=128;`); e != nil {
		return fail()
	}
	var version int
	if e = db.QueryRow("PRAGMA user_version").Scan(&version); e != nil || version < 0 || version > 2 {
		return fail()
	}
	if _, e = db.Exec(`CREATE TABLE IF NOT EXISTS metadata(endpoint TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS pending(request_id TEXT PRIMARY KEY,event_json TEXT NOT NULL);`); e != nil {
		return fail()
	}
	rows, e := db.Query("SELECT endpoint FROM metadata")
	if e != nil {
		return fail()
	}
	var endpoints []string
	for rows.Next() {
		var v string
		if e = rows.Scan(&v); e != nil {
			break
		}
		endpoints = append(endpoints, v)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return fail()
	}
	if len(endpoints) > 1 || (len(endpoints) == 1 && endpoints[0] != options.Endpoint) {
		return fail()
	}
	if len(endpoints) == 0 {
		if _, e = db.Exec("INSERT INTO metadata(endpoint) VALUES (?)", options.Endpoint); e != nil {
			return fail()
		}
	}
	if _, e = db.Exec("PRAGMA user_version=2"); e != nil {
		return fail()
	}
	s := &Spool{db: db, options: options, storageAvailable: true, delivery: "idle", stop: make(chan struct{}), timerDone: make(chan struct{}), closeDone: make(chan struct{})}
	s.startFlush()
	go func() {
		defer close(s.timerDone)
		ticker := time.NewTicker(options.Interval)
		defer ticker.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-ticker.C:
				s.startFlush()
			}
		}
	}()
	return s, nil
}
func (s *Spool) log(d Diagnostic) {
	if s.options.Logger != nil {
		func() { defer func() { _ = recover() }(); s.options.Logger(d) }()
	}
}
func (s *Spool) count() (int, error) {
	var n int
	e := s.db.QueryRow("SELECT count(*) FROM pending").Scan(&n)
	return n, e
}
func (s *Spool) Status() Status {
	s.mu.Lock()
	if s.closed {
		v := Status{Closed: true, Delivery: s.delivery}
		s.mu.Unlock()
		return v
	}
	n, e := s.count()
	if e != nil {
		s.storageAvailable = false
		v := Status{Delivery: s.delivery}
		s.mu.Unlock()
		s.log(Diagnostic{Event: "failure_audit_spool_failed", Stage: "audit-spool-status", Code: "failure_audit_spool_status_failed"})
		return v
	}
	v := Status{Ready: s.storageAvailable && n < s.options.MaxEvents, Pending: &n, Delivery: s.delivery}
	s.mu.Unlock()
	return v
}

// Record returns queued only after the FULL-synchronous local commit. The caller
// receives no backend error text. Cancellation does not undo a committed event.
func (s *Spool) Record(ctx context.Context, input Event) string {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return "closed"
	}
	event, e := normalize(input, time.Now())
	if e == nil {
		e = ctx.Err()
	}
	out := "failed"
	if e == nil {
		raw := encode(event)
		var conn *sql.Conn
		conn, e = s.db.Conn(ctx)
		if e == nil {
			func() {
				defer conn.Close()
				if _, e = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); e != nil {
					return
				}
				defer conn.ExecContext(context.Background(), "ROLLBACK")
				var prior string
				e = conn.QueryRowContext(ctx, "SELECT event_json FROM pending WHERE request_id=?", event.RequestID).Scan(&prior)
				if e == sql.ErrNoRows {
					e = nil
					var n int
					e = conn.QueryRowContext(ctx, "SELECT count(*) FROM pending").Scan(&n)
					if e != nil {
						return
					}
					if n >= s.options.MaxEvents {
						out = "capacity"
						return
					}
					_, e = conn.ExecContext(ctx, "INSERT INTO pending(request_id,event_json) VALUES (?,?)", event.RequestID, raw)
				} else if e == nil && prior != raw {
					e = safeError("failure_audit_event_conflict")
				}
				if e != nil {
					return
				}
				_, e = conn.ExecContext(ctx, "COMMIT")
				if e == nil {
					out = "queued"
				}
			}()
		}
	}
	if out == "queued" {
		s.storageAvailable = true
	} else if out == "failed" {
		s.storageAvailable = false
	}
	s.mu.Unlock()
	if out == "failed" {
		id := ""
		if eventUUID.MatchString(input.RequestID) {
			id = input.RequestID
		}
		s.log(Diagnostic{Event: "failure_audit_spool_failed", Stage: "audit-spool-record", Code: "failure_audit_spool_record_failed", RequestID: id})
	}
	if out == "queued" {
		s.startFlush()
	}
	return out
}
func (s *Spool) startFlush() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != nil {
		return s.active
	}
	done := make(chan struct{})
	if s.closed {
		close(done)
		return done
	}
	s.active = done
	go s.deliver(done)
	return done
}
func (s *Spool) Flush(ctx context.Context) error {
	done := s.startFlush()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *Spool) deliver(done chan struct{}) {
	defer func() { s.mu.Lock(); s.active = nil; close(done); s.mu.Unlock() }()
	type row struct{ id, raw string }
	var batch []row
	s.mu.Lock()
	rows, e := s.db.Query("SELECT request_id,event_json FROM pending ORDER BY rowid LIMIT ?", s.options.BatchSize)
	if e == nil {
		for rows.Next() {
			var r row
			if e = rows.Scan(&r.id, &r.raw); e != nil {
				break
			}
			batch = append(batch, r)
		}
		if e == nil {
			e = rows.Err()
		}
		rows.Close()
	}
	if e != nil {
		s.storageAvailable = false
	}
	s.mu.Unlock()
	if e != nil {
		s.log(Diagnostic{Event: "failure_audit_spool_failed", Stage: "audit-spool-read", Code: "failure_audit_spool_read_failed"})
		return
	}
	for _, r := range batch {
		event, e := decodeEvent(r.raw)
		var result Result
		if e == nil {
			result, e = invokeWriter(s.options.Write, event)
		}
		s.mu.Lock()
		if e == nil {
			_, e = s.db.Exec("DELETE FROM pending WHERE request_id=? AND event_json=?", r.id, r.raw)
		}
		if e == nil {
			s.storageAvailable = true
			s.delivery = "recorded"
			if result.State == "suppressed-by-deletion" {
				s.delivery = result.State
			}
		} else {
			s.delivery = "retry-pending"
		}
		s.mu.Unlock()
		if e != nil {
			id := ""
			if eventUUID.MatchString(r.id) {
				id = r.id
			}
			s.log(Diagnostic{Event: "failure_audit_delivery", Stage: "audit-delivery", Code: "failure_audit_delivery_failed", RequestID: id, Delivery: "retry-pending"})
			break
		}
	}
	if len(batch) > 0 {
		v := s.Status()
		s.log(Diagnostic{Event: "failure_audit_delivery", Delivery: v.Delivery, Pending: v.Pending})
	}
}

// Close stops scheduling and waits for a write already in progress. It never
// starts an extra drain or discards a pending/unknown-delivery event.
func (s *Spool) Close() error {
	s.mu.Lock()
	if s.closed {
		done := s.closeDone
		s.mu.Unlock()
		<-done
		return s.closeErr
	}
	s.closed = true
	close(s.stop)
	active := s.active
	s.mu.Unlock()
	<-s.timerDone
	if active != nil {
		<-active
	}
	s.mu.Lock()
	s.closeErr = s.db.Close()
	close(s.closeDone)
	s.mu.Unlock()
	return s.closeErr
}

func invokeWriter(write Writer, event Event) (out Result, err error) {
	defer func() {
		if recover() != nil {
			err = safeError("failure_audit_delivery_failed")
		}
	}()
	return write(context.Background(), event)
}
