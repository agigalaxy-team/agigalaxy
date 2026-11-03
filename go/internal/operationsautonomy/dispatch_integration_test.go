package operationsautonomy_test

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"testing"
	"time"

	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWorkbenchDispatchIndependentPlanAndOriginalReceipt(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	if _, err := databaseschema.Migrate(ctx, owner, []string{"worker"}); err != nil {
		t.Fatal(err)
	}
	automation := f.Automation(t)
	autonomyfixture.Setup(t, f, automation)
	now := f.Now()
	clock := func() time.Time { return now }
	s := &a.Service{Pool: owner, Endpoint: f.Endpoint, Authority: f.Gateway, Permissions: f.Permissions, AIWork: f.Permissions.AIWork, Now: clock,
		RuntimeStatus: func(context.Context) (a.Object, error) {
			return a.Object{"state": "connected", "modelState": "configured", "configuredDomains": []any{"overview"}}, nil
		},
		EnqueueWithin: func(context.Context, pgx.Tx, string, a.Object, string, *time.Time) error { return nil }}
	if _, e := owner.Exec(ctx, `INSERT INTO operations_autonomy_health_v1(endpoint,started_at,checked_at,last_tick_at,native_configured,native_checked_at) VALUES($1,$2,$2,$2,true,$2)`, f.Endpoint, now); e != nil {
		t.Fatal(e)
	}
	before, e := s.GetConfig(ctx, f.Root, "overview")
	if e != nil {
		t.Fatal(e)
	}
	poolFor := func(role string) *pgxpool.Pool {
		config, err := pgxpool.ParseConfig(dsn)
		if err != nil {
			t.Fatal(err)
		}
		config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, err := c.Exec(ctx, "SET ROLE "+role); return err }
		pool, err := pgxpool.NewWithConfig(ctx, config)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		return pool
	}
	s.Pool = poolFor("galaxy_api")
	request := a.Object{"kind": "task-dispatch", "targetDomain": "overview", "title": "Review unresolved feedback", "goal": "Read unresolved feedback and compare recurring needs; do not change feedback states.", "trigger": a.Object{"kind": "interval", "minutes": 37}, "startNow": true}
	op := uuid.NewString()
	proposal, e := s.PrepareDispatch(ctx, f.Root, "overview", request, op)
	if e != nil {
		t.Fatal(e)
	}
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM operations_autonomy_dispatches_v1 WHERE endpoint=$1`, f.Endpoint).Scan(&count); e != nil || count != 0 {
		t.Fatalf("preparation wrote assignment: %d %v", count, e)
	}
	confirmed, e := s.ConfirmDispatch(ctx, f.Root, "overview", proposal, op, nil)
	if e != nil {
		t.Fatal(e)
	}
	replay, e := s.ConfirmDispatch(ctx, f.Root, "overview", proposal, op, nil)
	if e != nil || replay["replayed"] != true {
		t.Fatalf("original dispatch replay: %#v %v", replay, e)
	}
	after, e := s.GetConfig(ctx, f.Root, "overview")
	if e != nil {
		t.Fatal(e)
	}
	bc, ac := before["config"].(map[string]any), after["config"].(map[string]any)
	if ac["enabled"] != false || bc["revision"] != ac["revision"] || bc["promptVersion"] != ac["promptVersion"] || bc["goal"] != ac["goal"] {
		t.Fatal("dispatch changed routine configuration")
	}
	taskID := confirmed["taskId"].(string)
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND configuration->'dispatch'->>'id'=$2`, f.Endpoint, op).Scan(&count); e != nil || count != 1 {
		t.Fatalf("duplicate task: %d %v", count, e)
	}
	// The worker's service actor uses only the target role, with routine duty off.
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='running',lease_until=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, taskID, now.Add(time.Minute)); e != nil {
		t.Fatal(e)
	}
	actor, e := postgres.InTx(ctx, owner, func(tx pgx.Tx) (a.Actor, error) { return s.DutyForTaskWithin(ctx, tx, taskID, "query") })
	if e != nil {
		t.Fatal(e)
	}
	if len(actor.Permissions) == 0 || actor.ID == f.Root.ID {
		t.Fatal("task borrowed owner authority")
	}
	read, e := s.ReadDispatch(ctx, f.Root, "overview", a.Object{"dispatchId": op})
	if e != nil || read["enabled"] != true || read["latestTask"].(map[string]any)["state"] != "running" {
		t.Fatalf("actual dispatch read: %#v %v", read, e)
	}
	// Finishing a round does not stop the recurring assignment. One later due
	// time produces one new task, even if scheduler wakeups repeat.
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='completed',lease_until=NULL WHERE endpoint=$1 AND id=$2`, f.Endpoint, taskID); e != nil {
		t.Fatal(e)
	}
	now = now.Add(38 * time.Minute)
	s.Pool = poolFor("galaxy_evidence_worker")
	worker := a.NewWorker(s)
	if _, e = worker.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = worker.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND configuration->'dispatch'->>'id'=$2`, f.Endpoint, op).Scan(&count); e != nil || count != 2 {
		t.Fatalf("due task dedup: %d %v", count, e)
	}
}
