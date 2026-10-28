package workerconfig

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

func TestExplicitAdoptionIndependentWorkerAndShutdown(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/web-events-interop.mjs"), "setup")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("original schema: %v %s", e, out)
	}
	config := Config{DatabaseURL: dsn, Endpoint: "https://events.invalid"}
	if _, e := Open(ctx, config); fault.Code(e) != "operations_jobs_schema_unavailable" {
		t.Fatalf("constructor migrated or hid absent schema: %v", e)
	}
	var missing bool
	if e := pool.QueryRow(ctx, "SELECT to_regclass('galaxy_go_jobs.control_v1') IS NULL").Scan(&missing); e != nil || !missing {
		t.Fatal("construction created schema")
	}
	for _, name := range []string{"api-role.sql", "worker-role.sql"} {
		b, e := os.ReadFile(filepath.Join(root, "packages/galaxy-official/src/infrastructure", name))
		if e != nil {
			t.Fatal(e)
		}
		if _, e = pool.Exec(ctx, string(b)); e != nil {
			t.Fatal(e)
		}
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = jobs.MigrateWithin(ctx, pool, tx); e != nil {
		t.Fatal(e)
	}
	if e = jobs.ProvisionRolesWithin(ctx, tx); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	// Runtime uses the original restricted worker role, never provisions itself.
	// SET ROLE is confined to this new synthetic cluster's connection options.
	config.DatabaseURL = dsn + "&options=-c%20role%3Dgalaxy_evidence_worker"
	if _, e = Open(ctx, config); fault.Code(e) != "operations_jobs_not_adopted" {
		t.Fatalf("default gate opened: %v", e)
	}
	var count int
	pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.control_v1").Scan(&count)
	if count != 0 {
		t.Fatal("runtime created adoption gate")
	}
	producer, e := jobs.New(pool, nil)
	if e != nil {
		t.Fatal(e)
	}
	task := jobs.Task{ID: uuid.NewString(), Endpoint: config.Endpoint, Action: jobs.FeedbackScan, SourceID: uuid.NewString(), OperationID: uuid.NewString()}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = producer.EnqueueWithin(ctx, tx, task, time.Time{}); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	// The administrator alone records the explicit isolated cutover. Runtime
	// never reads or adopts legacy pg-boss work.
	if _, e = pool.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", config.Endpoint); e != nil {
		t.Fatal(e)
	}
	runtime, e := Open(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	if runtime.Pool == pool {
		t.Fatal("worker reused administrative pool")
	}
	var user string
	if e = runtime.Pool.QueryRow(ctx, "SELECT current_user").Scan(&user); e != nil || user != "galaxy_evidence_worker" {
		t.Fatalf("wrong process identity: %s %v", user, e)
	}
	run, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- runtime.Run(run) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		v, e := producer.Get(ctx, config.Endpoint, task.ID)
		if e == nil && v.State == "deferred" && v.Result["state"] == "paused" {
			break
		}
		if time.Now().After(deadline) {
			stop()
			t.Fatalf("unconfirmed scan gate was not paused: %+v %v", v, e)
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("worker did not stop gracefully")
	}
	var unchanged string
	if e = pool.QueryRow(ctx, "SELECT backend FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1", config.Endpoint).Scan(&unchanged); e != nil || unchanged != "river" {
		t.Fatal("runtime rewrote administrative gate")
	}
}
