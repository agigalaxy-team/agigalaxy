package jobs

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

func TestRiverCurrentSummaryUsesActualStatesAndEndpoint(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = MigrateWithin(ctx, pool, tx); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `CREATE ROLE galaxy_api NOLOGIN; CREATE ROLE galaxy_evidence_worker NOLOGIN`); err != nil {
		t.Fatal(err)
	}
	if err = ProvisionRolesWithin(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	q, err := New(pool, nil)
	if err != nil {
		t.Fatal(err)
	}
	const endpoint = "https://summary.example.invalid"
	if _, err = q.Snapshot(ctx, endpoint); fault.Code(err) != "operations_job_backend_not_adopted" {
		t.Fatal("unadopted transport shown as zero", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')`, endpoint); err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"available", "scheduled", "pending", "retryable", "running", "completed", "cancelled", "discarded"} {
		id := uuid.NewString()
		task := Task{ID: id, Endpoint: endpoint, Action: AutonomyTick, SourceID: id, OperationID: id}
		tx, _ := pool.Begin(ctx)
		defer tx.Rollback(ctx)
		if _, err = q.EnqueueWithin(ctx, tx, task, time.Time{}); err != nil {
			t.Fatal(err)
		}
		// Controlled source states exercise the read projection without running
		// consumers or manufacturing completed business effects.
		if _, err = tx.Exec(ctx, `UPDATE galaxy_river.river_job SET state=$2::galaxy_river.river_job_state,
 finalized_at=CASE WHEN $2 IN ('completed','cancelled','discarded') THEN now() ELSE NULL END
 WHERE id=(SELECT river_id FROM galaxy_go_jobs.executions_v1 WHERE id=$1)`, id, state); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	foreign := uuid.NewString()
	tx, _ = pool.Begin(ctx)
	defer tx.Rollback(ctx)
	if _, err = q.EnqueueWithin(ctx, tx, Task{ID: foreign, Endpoint: "https://other.example.invalid", Action: AutonomyTick, SourceID: foreign, OperationID: foreign}, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, _ = pool.Begin(ctx)
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SET LOCAL ROLE galaxy_api`); err != nil {
		t.Fatal(err)
	}
	snapshot, err := q.SnapshotWithin(ctx, tx, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	items := snapshot["items"].([]any)
	if len(items) != 1 || snapshot["includesAllPlatformQueues"] != false {
		t.Fatal("transport scope inflated", snapshot)
	}
	counts := items[0].(map[string]any)["counts"].(map[string]any)
	for key, want := range map[string]int{"created": 3, "retry": 1, "active": 1, "completed": 1, "cancelled": 1, "failed": 1} {
		if counts[key] != want {
			t.Fatal("actual River state projection", key, counts)
		}
	}
	summary, err := q.SummaryWithin(ctx, tx, endpoint)
	if err != nil || summary["failed"] != 1 || len(summary["byQueue"].([]any)) != 4 {
		t.Fatal("overview diverged", summary, err)
	}
}
