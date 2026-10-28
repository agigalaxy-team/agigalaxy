package jobs

import (
	"context"
	"errors"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func eventually(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("bounded River result wait expired")
}
func TestRiverTransactionalUUIDMappingAndSameSourceRecovery(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = MigrateWithin(ctx, pool, tx); e != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	task := Task{ID: uuid.NewString(), Endpoint: "https://queue.example.invalid", Action: FeedbackScan, SourceID: uuid.NewString(), OperationID: uuid.NewString()}
	var calls atomic.Int32
	q, e := New(pool, func(_ context.Context, got Task) (Outcome, error) {
		if !reflect.DeepEqual(got, task) {
			t.Errorf("source identity changed: %v", got)
		}
		if calls.Add(1) == 1 {
			return Outcome{}, fault.New("controlled_transport_failure", 503)
		}
		return Outcome{Result: map[string]any{"sourceId": got.SourceID, "operationId": got.OperationID}}, nil
	})
	if e != nil {
		t.Fatal(e)
	}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = q.EnqueueWithin(ctx, tx, task, time.Time{}); e != nil {
		t.Fatal(e)
	}
	_ = tx.Rollback(ctx)
	if _, e = q.Get(ctx, task.Endpoint, task.ID); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatalf("rolled-back mapping exists: %v", e)
	}
	var count int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_river.river_job").Scan(&count); e != nil || count != 0 {
		t.Fatalf("rolled-back River job remains %d %v", count, e)
	}
	tx, _ = pool.Begin(ctx)
	if _, e = q.EnqueueWithin(ctx, tx, task, time.Time{}); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	tx, _ = pool.Begin(ctx)
	if id, e := q.EnqueueWithin(ctx, tx, task, time.Time{}); e != nil || id != task.ID {
		t.Fatalf("same UUID enqueue %s %v", id, e)
	}
	_ = tx.Commit(ctx)
	changed := task
	changed.SourceID = uuid.NewString()
	tx, _ = pool.Begin(ctx)
	_, e = q.EnqueueWithin(ctx, tx, changed, time.Time{})
	if fault.Code(e) != "operations_job_operation_conflict" {
		t.Fatal(e)
	}
	_ = tx.Rollback(ctx)
	// Default gate is closed, even when someone starts the worker transport.
	if e = q.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer q.Stop(context.Background())
	eventually(t, func() bool {
		var scheduled int
		_ = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_river.river_job WHERE state IN('available','scheduled') AND scheduled_at>created_at+interval '0.1 seconds'").Scan(&scheduled)
		return scheduled == 1
	})
	if calls.Load() != 0 {
		t.Fatal("disabled gate allowed a domain effect")
	}
	if _, e = pool.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", task.Endpoint); e != nil {
		t.Fatal(e)
	}
	resume := func() {
		t.Helper()
		eventually(t, func() bool {
			tx, e := pool.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			e = q.ResumeWithin(ctx, tx, task.Endpoint, task.ID)
			if fault.Code(e) == "operations_job_in_progress" {
				_ = tx.Rollback(ctx)
				return false
			}
			if e != nil {
				_ = tx.Rollback(ctx)
				t.Fatal(e)
			}
			if e = tx.Commit(ctx); e != nil {
				t.Fatal(e)
			}
			return true
		})
	}
	resume()
	eventually(t, func() bool {
		var state, domain string
		_ = pool.QueryRow(ctx, "SELECT j.state::text,e.state FROM galaxy_river.river_job j JOIN galaxy_go_jobs.executions_v1 e ON e.river_id=j.id WHERE e.id=$1", task.ID).Scan(&state, &domain)
		return domain == "failed" && state != "running"
	})
	view, e := q.Get(ctx, task.Endpoint, task.ID)
	if e != nil || view.State != "failed" || view.ErrorCode == nil || *view.ErrorCode != "controlled_transport_failure" {
		t.Fatalf("failure receipt %v %v", view, e)
	}
	resume()
	eventually(t, func() bool { v, e := q.Get(ctx, task.Endpoint, task.ID); return e == nil && v.State == "succeeded" })
	if calls.Load() != 2 {
		t.Fatalf("same-source resume calls %d", calls.Load())
	}
	var riverID int64
	eventually(t, func() bool {
		var state string
		_ = pool.QueryRow(ctx, "SELECT j.id,j.state FROM galaxy_river.river_job j JOIN galaxy_go_jobs.executions_v1 e ON e.river_id=j.id WHERE e.id=$1", task.ID).Scan(&riverID, &state)
		return state == "completed"
	})
	// Simulate a transport acknowledgement replay without replacing either ID.
	if _, e = q.client.JobRetry(ctx, riverID); e != nil {
		t.Fatal(e)
	}
	eventually(t, func() bool { j, e := q.client.JobGet(ctx, riverID); return e == nil && string(j.State) == "completed" })
	if calls.Load() != 2 {
		t.Fatal("completed transport replay repeated source execution")
	}
	// Transport args cannot silently point the same public operation at another
	// source. Corrupt it before commit so the real worker is the first reader.
	corrupt := task
	corrupt.ID = uuid.NewString()
	corrupt.SourceID = uuid.NewString()
	tx, _ = pool.Begin(ctx)
	if _, e = q.EnqueueWithin(ctx, tx, corrupt, time.Time{}); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, "UPDATE galaxy_river.river_job SET args=jsonb_set(args,'{sourceId}',to_jsonb($2::text)) WHERE id=(SELECT river_id FROM galaxy_go_jobs.executions_v1 WHERE id=$1)", corrupt.ID, uuid.NewString()); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	eventually(t, func() bool {
		v, e := q.Get(ctx, corrupt.Endpoint, corrupt.ID)
		return e == nil && v.State == "failed" && v.ErrorCode != nil && *v.ErrorCode == "operations_job_source_changed"
	})
	if calls.Load() != 2 {
		t.Fatal("corrupted transport args reached the source consumer")
	}
}
