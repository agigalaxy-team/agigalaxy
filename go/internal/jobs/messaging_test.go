package jobs

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

func TestMessageTaskExtensionPreservesExistingBytes(t *testing.T) {
	base := Task{ID: "11111111-1111-4111-8111-111111111111", Endpoint: "https://queue.example.invalid", Action: FeedbackScan, SourceID: "22222222-2222-4222-8222-222222222222", OperationID: "33333333-3333-4333-8333-333333333333"}
	raw, err := json.Marshal(base)
	if err != nil || string(raw) != `{"id":"11111111-1111-4111-8111-111111111111","endpoint":"https://queue.example.invalid","action":"feedback-scan","sourceId":"22222222-2222-4222-8222-222222222222","operationId":"33333333-3333-4333-8333-333333333333"}` {
		t.Fatal("existing task request bytes changed")
	}
	for _, version := range []int64{0, -1, 2147483647} {
		current := base
		current.Action = MessagingRun
		current.PlanVersion = version
		if current.valid() {
			t.Fatal("invalid plan version accepted")
		}
	}
	base.PlanVersion = 1
	if base.valid() {
		t.Fatal("unrelated action accepted a plan version")
	}
}

func TestMessageConsumersPersistExactSourceAndPlanVersion(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = MigrateWithin(ctx, pool, tx); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	endpoint := "https://messaging.queue.invalid"
	seen := make(chan Task, 3)
	queue, err := NewWithQueues(pool, func(_ context.Context, task Task) (Outcome, error) {
		seen <- task
		return Outcome{Result: map[string]any{"sourceId": task.SourceID, "planVersion": task.PlanVersion}}, nil
	}, map[string]int{AccountNotice: 1, MessagingRun: 1, MessagingDelivery: 1})
	if err != nil {
		t.Fatal(err)
	}
	var tasks []Task
	for _, action := range []string{AccountNotice, MessagingRun, MessagingDelivery} {
		task := Task{ID: uuid.NewString(), Endpoint: endpoint, Action: action, SourceID: uuid.NewString(), OperationID: uuid.NewString()}
		if action == MessagingRun {
			task.PlanVersion = 7
		}
		tasks = append(tasks, task)
		tx, err = pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = queue.EnqueueWithin(ctx, tx, task, time.Time{}); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	// Changing only a plan version cannot repurpose an already recorded job.
	changed := tasks[1]
	changed.PlanVersion++
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = queue.EnqueueWithin(ctx, tx, changed, time.Time{})
	_ = tx.Rollback(ctx)
	if fault.Code(err) != "operations_job_operation_conflict" {
		t.Fatal("version conflict was not retained")
	}
	if _, err = pool.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", endpoint); err != nil {
		t.Fatal(err)
	}
	if err = queue.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer queue.Stop(context.Background())
	want := map[string]Task{}
	for _, task := range tasks {
		want[task.ID] = task
	}
	for range tasks {
		select {
		case actual := <-seen:
			if expected, ok := want[actual.ID]; !ok || !reflect.DeepEqual(actual, expected) {
				t.Fatal("queue source changed")
			}
			delete(want, actual.ID)
		case <-ctx.Done():
			t.Fatal("message consumer did not run")
		}
	}
	for _, task := range tasks {
		eventually(t, func() bool {
			view, err := queue.Get(ctx, endpoint, task.ID)
			return err == nil && view.State == "succeeded"
		})
	}
}
