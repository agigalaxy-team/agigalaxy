package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestDurableScheduleAtomicRollbackRestartSkipConcurrencyAndGate(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = MigrateWithin(ctx, pool, tx); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	endpoint := "https://schedule.example.invalid"
	var calls atomic.Int32
	q, e := NewWithQueues(pool, func(_ context.Context, task Task) (Outcome, error) {
		if task.Action != MessagingRun || task.PlanVersion != 7 {
			t.Errorf("wrong task %+v", task)
		}
		calls.Add(1)
		return Outcome{Result: map[string]any{"scheduled": true}}, nil
	}, map[string]int{MessagingRun: 2})
	if e != nil {
		t.Fatal(e)
	}
	s := &ScheduleQueue{Pool: pool, Queue: q, Endpoint: endpoint}
	task := Task{Endpoint: endpoint, Action: MessagingRun, SourceID: uuid.NewString(), PlanVersion: 7}
	save := func(key, cron string, commit bool) {
		t.Helper()
		tx, e := pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(ctx)
		if e = s.ScheduleWithin(ctx, tx, MessagingRun, cron, "UTC", key, task, "skip"); e != nil {
			t.Fatal(e)
		}
		if commit {
			if e = tx.Commit(ctx); e != nil {
				t.Fatal(e)
			}
		}
	}
	save("rolled-back", "* * * * * *", false)
	var count int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.schedules_v1").Scan(&count); e != nil || count != 0 {
		t.Fatalf("rollback %d %v", count, e)
	}
	save("recurring", "* * * * * *", true)
	if n, e := s.Tick(ctx, 100); e != nil || n != 0 {
		t.Fatalf("absent gate executed %d %v", n, e)
	}
	if _, e = pool.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", endpoint); e != nil {
		t.Fatal(e)
	}
	// Force the insert itself to fail inside the shared tx; next_at must not move.
	if _, e = pool.Exec(ctx, `ALTER TABLE galaxy_go_jobs.executions_v1 ADD CONSTRAINT controlled_schedule_failure CHECK(action<>'messaging-run')`); e != nil {
		t.Fatal(e)
	}
	var before, after time.Time
	if e = pool.QueryRow(ctx, "SELECT next_at FROM galaxy_go_jobs.schedules_v1 WHERE key='recurring'").Scan(&before); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Tick(ctx, 1); e == nil {
		t.Fatal("controlled enqueue unexpectedly succeeded")
	}
	if e = pool.QueryRow(ctx, "SELECT next_at FROM galaxy_go_jobs.schedules_v1 WHERE key='recurring'").Scan(&after); e != nil || !after.Equal(before) {
		t.Fatalf("failed tick advanced %v %v %v", before, after, e)
	}
	if _, e = pool.Exec(ctx, "ALTER TABLE galaxy_go_jobs.executions_v1 DROP CONSTRAINT controlled_schedule_failure"); e != nil {
		t.Fatal(e)
	}
	// Independent scheduler instances/processes share the row and stable minute ID.
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			other := &ScheduleQueue{Pool: pool, Queue: q, Endpoint: endpoint}
			if _, e := other.Tick(ctx, 10); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1").Scan(&count); e != nil || count != 1 {
		t.Fatalf("concurrent slot count %d %v", count, e)
	}
	// Recreated instances and overdue next_at do not replay the same minute.
	if _, e = pool.Exec(ctx, "UPDATE galaxy_go_jobs.schedules_v1 SET next_at=now()-interval '2 days'"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Tick(ctx, 10); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1").Scan(&count); e != nil || count != 1 {
		t.Fatalf("restarted slot replay %d %v", count, e)
	}
	var payload []byte
	if e = pool.QueryRow(ctx, "SELECT args FROM galaxy_river.river_job LIMIT 1").Scan(&payload); e != nil {
		t.Fatal(e)
	}
	var delivered Task
	if e = json.Unmarshal(payload, &delivered); e != nil || !delivered.valid() || delivered.SourceID != task.SourceID || delivered.PlanVersion != 7 {
		t.Fatalf("pinned task %+v %v", delivered, e)
	}
	// A yearly expression overdue since a shutdown skips earlier windows. Select a
	// month on the opposite side of the current year so it cannot accidentally be due.
	var now time.Time
	_ = pool.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now)
	month := (int(now.Month())+5)%12 + 1
	save("missed", "0 0 1 "+time.Month(month).String()[:3]+" *", true)
	if _, e = pool.Exec(ctx, "UPDATE galaxy_go_jobs.schedules_v1 SET next_at=now()-interval '400 days' WHERE key='missed'"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Tick(ctx, 10); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1").Scan(&count); e != nil || count != 1 {
		t.Fatalf("missed backlog %d %v", count, e)
	}
	// Gate removal leaves even next_at unchanged and emits no work.
	if _, e = pool.Exec(ctx, "UPDATE galaxy_go_jobs.control_v1 SET backend='disabled';UPDATE galaxy_go_jobs.schedules_v1 SET next_at=now()-interval '2 days'"); e != nil {
		t.Fatal(e)
	}
	if n, e := s.Tick(ctx, 10); e != nil || n != 0 {
		t.Fatalf("revoked gate %d %v", n, e)
	}
	if _, e = pool.Exec(ctx, "UPDATE galaxy_go_jobs.control_v1 SET backend='river'"); e != nil {
		t.Fatal(e)
	}
	// Real River consumer executes the persisted task identity, not a new operation.
	if e = q.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer q.Stop(context.Background())
	eventually(t, func() bool { return calls.Load() == 1 })
	stopCtx, stop := context.WithCancel(ctx)
	stop()
	if _, e = s.Tick(stopCtx, 10); !errors.Is(e, context.Canceled) {
		t.Fatalf("cancelled tick %v", e)
	}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.UnscheduleWithin(ctx, tx, MessagingRun, "recurring"); e != nil {
		t.Fatal(e)
	}
	_ = tx.Rollback(ctx)
	var key string
	if e = pool.QueryRow(ctx, "SELECT key FROM galaxy_go_jobs.schedules_v1 WHERE key='recurring'").Scan(&key); errors.Is(e, pgx.ErrNoRows) {
		t.Fatal("rollback lost schedule")
	}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.UnscheduleWithin(ctx, tx, MessagingRun, "recurring"); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, "SELECT key FROM galaxy_go_jobs.schedules_v1 WHERE key='recurring'").Scan(&key); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatalf("unschedule %v", e)
	}
}
