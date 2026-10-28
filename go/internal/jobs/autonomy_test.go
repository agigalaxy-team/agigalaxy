package jobs

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

func TestAutonomyExclusiveKeysAllowNewTerminalGenerationAndPreserveTask(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = MigrateWithin(ctx, pool, tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	endpoint := "https://autonomy.queue.invalid"
	taskID := uuid.NewString()
	if _, err = pool.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", endpoint); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	queue, err := NewWithQueues(pool, func(_ context.Context, task Task) (Outcome, error) {
		if task.Action != AutonomyTask || task.SourceID != taskID || task.Payload["taskId"] != taskID || task.ID == taskID {
			t.Error("technical queue ID replaced the durable business identity")
		}
		calls.Add(1)
		return Outcome{Result: map[string]any{"transported": true}}, nil
	}, map[string]int{AutonomyTask: 1, AutonomyTick: 1})
	if err != nil {
		t.Fatal(err)
	}
	enqueue := func(key string, commit bool) error {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(context.Background())
		if err = queue.EnqueueAutonomyWithin(ctx, tx, endpoint, AutonomyTask, map[string]any{"taskId": taskID, "reconcile": true}, key, nil); err != nil {
			return err
		}
		if commit {
			return tx.Commit(ctx)
		}
		return nil
	}
	if err = enqueue("rollback", false); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1").Scan(&count); err != nil || count != 0 {
		t.Fatal("rolled-back intent left a transport execution", count, err)
	}
	var concurrent sync.WaitGroup
	failures := make(chan error, 6)
	for range 6 {
		concurrent.Add(1)
		go func() { defer concurrent.Done(); failures <- enqueue("same-health-slot", true) }()
	}
	concurrent.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1").Scan(&count); err != nil || count != 1 {
		t.Fatal("in-flight singleton duplicate", count, err)
	}
	if err = queue.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() {
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = queue.Stop(shutdown)
	}()
	eventually(t, func() bool {
		var count int
		err := pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_river.river_job WHERE state='completed'").Scan(&count)
		return err == nil && count == 1
	})
	if err = enqueue("same-health-slot", true); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return calls.Load() == 2 })
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1").Scan(&count); err != nil || count != 2 {
		t.Fatal("terminal singleton swallowed a later explicit check", count, err)
	}
	if _, err = pool.Exec(ctx, "UPDATE galaxy_go_jobs.control_v1 SET backend='disabled' WHERE endpoint=$1", endpoint); err != nil {
		t.Fatal(err)
	}
	if err = enqueue("after-withdrawal", true); err == nil {
		t.Fatal("withdrawn backend accepted another intent")
	}
}
