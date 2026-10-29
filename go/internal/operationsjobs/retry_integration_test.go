package operationsjobs

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestRetryPreservesOriginalMessagingJobAndRiverRow(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	_, err := postgres.InTx(ctx, owner, func(tx pgx.Tx) (bool, error) {
		if err := jobs.MigrateWithin(ctx, owner, tx); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='galaxy_evidence_worker') THEN CREATE ROLE galaxy_evidence_worker NOLOGIN; END IF; END $$`); err != nil {
			return false, err
		}
		return true, jobs.ProvisionRolesWithin(ctx, tx)
	})
	if err != nil {
		t.Fatal(err)
	}
	q, err := jobs.New(f.Pool, nil)
	if err != nil {
		t.Fatal(err)
	}
	task := jobs.Task{ID: uuid.NewString(), Endpoint: f.Endpoint, Action: jobs.MessagingDelivery, SourceID: uuid.NewString(), OperationID: uuid.NewString()}
	_, err = postgres.InTx(ctx, owner, func(tx pgx.Tx) (bool, error) {
		_, err := q.EnqueueWithin(ctx, tx, task, time.Time{})
		return err == nil, err
	})
	if err != nil {
		t.Fatal(err)
	}
	var riverID int64
	if err = owner.QueryRow(ctx, `SELECT river_id FROM galaxy_go_jobs.executions_v1 WHERE id=$1`, task.ID).Scan(&riverID); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river') ON CONFLICT(endpoint) DO UPDATE SET backend='river'`, f.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE galaxy_go_jobs.executions_v1 SET state='failed',error_code='synthetic_failure' WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE galaxy_river.river_job SET state='discarded',attempt=5,max_attempts=5,finalized_at=now() WHERE id=$1`, riverID); err != nil {
		t.Fatal(err)
	}
	service := &Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Queue: q, Now: f.Now}
	request := Object{"queue": jobs.MessagingDelivery, "targetId": task.ID}
	command := Object{"operationId": uuid.NewString(), "expectedState": "failed", "expectedRetryCount": float64(3), "reason": "Synthetic retry check"}
	if _, err = service.Command(ctx, f.Root, "job-retry", request, command, nil); fault.Code(err) != "operations_job_changed" {
		t.Fatalf("different retry count must reject: %v", err)
	}
	command["expectedRetryCount"] = float64(4)
	result, err := service.Command(ctx, f.Root, "job-retry", request, command, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result["jobId"] != task.ID || result["previousState"] != "failed" || result["state"] != "created" {
		t.Fatalf("unexpected receipt %#v", result)
	}
	var actualRiver int64
	var rowCount int
	if err = owner.QueryRow(ctx, `SELECT river_id FROM galaxy_go_jobs.executions_v1 WHERE id=$1`, task.ID).Scan(&actualRiver); err != nil {
		t.Fatal(err)
	}
	if err = owner.QueryRow(ctx, `SELECT count(*) FROM galaxy_river.river_job WHERE id=$1`, riverID).Scan(&rowCount); err != nil {
		t.Fatal(err)
	}
	if actualRiver != riverID || rowCount != 1 {
		t.Fatalf("original River identity changed: %d -> %d, rows=%d", riverID, actualRiver, rowCount)
	}
	original, err := service.Operation(ctx, f.Root, "job-retry", request, command, command["operationId"].(string))
	if err != nil || original["jobId"] != task.ID {
		t.Fatalf("original receipt %#v %v", original, err)
	}
}
