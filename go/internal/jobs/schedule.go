package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ScheduleQueue persists definitions in the business transaction. Tick locks a
// definition and inserts its transport job in that same transaction; no in-memory
// recurring registration is authoritative. The caller owns polling and shutdown.
type ScheduleQueue struct {
	Pool     *pgxpool.Pool
	Queue    *Queue
	Endpoint string
}

func (s *ScheduleQueue) PreviewSchedule(ctx context.Context, expression, zone string, from time.Time, count int) ([]time.Time, error) {
	p, e := parseSchedule(expression, zone)
	if e != nil {
		return nil, e
	}
	if from.IsZero() || count < 1 || count > 1000 {
		return nil, scheduleInvalid()
	}
	out := make([]time.Time, 0, count)
	deadline := time.Now().Add(time.Second)
	for len(out) < count {
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		n := p.next(from)
		if n.IsZero() {
			return nil, scheduleInvalid()
		}
		out = append(out, n)
		from = n
		if time.Now().After(deadline) && len(out) < count {
			return nil, fault.New("operations_messaging_schedule_unavailable", 503)
		}
	}
	return out, nil
}
func scheduleInvalid() error { return fault.New("operations_messaging_schedule_invalid", 400) }
func (s *ScheduleQueue) validKey(queue, key string) bool {
	return s.Endpoint != "" && queue == MessagingRun && strings.TrimSpace(key) != "" && utf8.RuneCountInString(key) <= 300
}
func (s *ScheduleQueue) ScheduleWithin(ctx context.Context, tx pgx.Tx, queue, expression, zone, key string, task Task, missed string) error {
	if !s.validKey(queue, key) || missed != "skip" || task.Endpoint != s.Endpoint || task.Action != queue || task.ID != "" || task.OperationID != "" {
		return scheduleInvalid()
	}
	probe := task
	probe.ID = uuid.NewString()
	probe.OperationID = probe.ID
	if !probe.valid() {
		return scheduleInvalid()
	}
	var now time.Time
	if e := tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); e != nil {
		return e
	}
	next, e := s.PreviewSchedule(ctx, expression, zone, now, 1)
	if e != nil {
		return e
	}
	p, _ := parseSchedule(expression, zone)
	if p.previous(now).After(now.Add(-time.Minute)) {
		next[0] = now
	}
	if strings.Contains(expression, "H") && next[0].After(now.Add(30*time.Second)) {
		next[0] = now.Add(30 * time.Second)
	}
	raw, e := json.Marshal(task)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `INSERT INTO galaxy_go_jobs.schedules_v1(endpoint,queue,key,cron,timezone,payload,missed,next_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1) ON CONFLICT(endpoint,queue,key) DO UPDATE SET cron=excluded.cron,timezone=excluded.timezone,payload=excluded.payload,missed=excluded.missed,next_at=excluded.next_at,revision=schedules_v1.revision+1,updated_at=clock_timestamp()`, s.Endpoint, queue, key, expression, zone, raw, missed, next[0])
	return e
}
func (s *ScheduleQueue) UnscheduleWithin(ctx context.Context, tx pgx.Tx, queue, key string) error {
	if !s.validKey(queue, key) {
		return scheduleInvalid()
	}
	_, e := tx.Exec(ctx, "DELETE FROM galaxy_go_jobs.schedules_v1 WHERE endpoint=$1 AND queue=$2 AND key=$3", s.Endpoint, queue, key)
	return e
}

// Tick processes at most limit definitions. PostgreSQL supplies the clock, and
// competing processes skip locked rows. Cron's original latest occurrence in
// (now-60s,now], filed under its UTC minute, is retained (including second fields).
// A restart skips earlier missed slots rather than generating a backlog.
func (s *ScheduleQueue) Tick(ctx context.Context, limit int) (int, error) {
	if s.Pool == nil || s.Queue == nil || s.Endpoint == "" || limit < 1 || limit > 1000 {
		return 0, fault.New("operations_job_consumer_unavailable", 503)
	}
	count := 0
	for i := 0; i < limit; i++ {
		n, e := s.tickOne(ctx)
		if e != nil {
			return count, e
		}
		if !n {
			break
		}
		count++
	}
	return count, nil
}
func (s *ScheduleQueue) tickOne(ctx context.Context) (bool, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(context.Background())
	var backend string
	e = tx.QueryRow(ctx, "SELECT backend FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 FOR SHARE", s.Endpoint).Scan(&backend)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && backend != "river" {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	var queue, key, expression, zone, missed string
	var raw []byte
	var now, created time.Time
	e = tx.QueryRow(ctx, `SELECT queue,key,cron,timezone,payload,missed,clock_timestamp(),created_at FROM galaxy_go_jobs.schedules_v1 WHERE endpoint=$1 AND next_at<=clock_timestamp() ORDER BY next_at,key FOR UPDATE SKIP LOCKED LIMIT 1`, s.Endpoint).Scan(&queue, &key, &expression, &zone, &raw, &missed, &now, &created)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	reject := func(cause error) (bool, error) {
		// A corrupt/unsupported row must not monopolize the first due lock and
		// starve every other schedule. Revisit it on the next bounded pass;
		// callers still receive its safe code. No job or business data is changed.
		if _, updateError := tx.Exec(ctx, `UPDATE galaxy_go_jobs.schedules_v1 SET next_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp() WHERE endpoint=$1 AND queue=$2 AND key=$3`, s.Endpoint, queue, key); updateError != nil {
			return false, updateError
		}
		if commitError := tx.Commit(ctx); commitError != nil {
			return false, commitError
		}
		return true, cause
	}
	p, e := parseSchedule(expression, zone)
	if e != nil {
		return reject(e)
	}
	if !s.validKey(queue, key) || missed != "skip" {
		return reject(scheduleInvalid())
	}
	var task Task
	if e = json.Unmarshal(raw, &task); e != nil {
		return reject(scheduleInvalid())
	}
	if task.Endpoint != s.Endpoint || task.Action != queue || task.ID != "" || task.OperationID != "" {
		return reject(scheduleInvalid())
	}
	probe := task
	probe.ID = uuid.Nil.String()
	probe.OperationID = probe.ID
	if !probe.valid() {
		return reject(scheduleInvalid())
	}
	// The original cron pass reads only the most recent occurrence, not every
	// second in its window. Advancing next_at also prevents a hot polling loop.
	last := p.previous(now)
	next := p.next(now)
	if next.IsZero() || last.IsZero() {
		return reject(scheduleInvalid())
	}
	if strings.Contains(expression, "H") && next.After(now.Add(30*time.Second)) {
		next = now.Add(30 * time.Second)
	}
	if last.After(now.Add(-time.Minute)) {
		slot := last.UTC().Truncate(time.Minute)
		identity, _ := json.Marshal([]string{s.Endpoint, queue, key, slot.Format(time.RFC3339)})
		task.ID = uuid.NewSHA1(uuid.NameSpaceURL, identity).String()
		task.OperationID = task.ID
		if _, e = s.Queue.EnqueueWithin(ctx, tx, task, now); e != nil {
			return false, e
		}
	}
	if _, e = tx.Exec(ctx, `UPDATE galaxy_go_jobs.schedules_v1 SET next_at=$4,updated_at=clock_timestamp() WHERE endpoint=$1 AND queue=$2 AND key=$3`, s.Endpoint, queue, key, next); e != nil {
		return false, e
	}
	return true, tx.Commit(ctx)
}
