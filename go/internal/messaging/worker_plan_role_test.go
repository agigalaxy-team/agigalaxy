package messaging

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWorkerPlanRoleExecution(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, owner, []string{"api", "worker"}); e != nil {
		t.Fatal(e)
	}
	tx, e := owner.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = jobs.MigrateWithin(ctx, owner, tx); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	root, _ := filepath.Abs("../../..")
	b, e := os.ReadFile(filepath.Join(root, "go/internal/databaseschema/sql/worker-role.sql"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, string(b)); e != nil {
		t.Fatal(e)
	}
	roles, e := os.ReadFile(filepath.Join(root, "go/internal/jobs/migrations/002_roles.sql"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, string(roles)); e != nil {
		t.Fatal(e)
	}
	endpoint := "https://worker-messaging.example.invalid"
	operator := "synthetic-worker-operator"
	account := uuid.NewString()
	if _, e = owner.Exec(ctx, `INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.example.invalid','worker-test','Synthetic',now(),now())`, operator, endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,'https://accounts.example.invalid','worker-test','external-account',now(),now())`, account, endpoint); e != nil {
		t.Fatal(e)
	}
	q, e := jobs.New(owner, nil)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Unix(2000000000, 0)
	auth := &domainAuthority{actor: Actor{ID: operator, Role: "administrator", Endpoint: endpoint, Permissions: []string{"notices.read", "notices.create", "notices.update", "notices.publish"}}}
	s := &Service{Pool: owner, Endpoint: endpoint, Authority: auth, Approver: auth, Jobs: q, Now: func() time.Time { return now }}
	created, e := s.Create(ctx, auth.actor, Object{"operationId": uuid.NewString(), "config": Object{"channels": []any{"inapp"}, "content": Object{"purpose": "service-update", "title": "Synthetic", "body": "Synthetic", "expiresAt": iso(now.Add(time.Hour))}, "audience": Object{"kind": "accounts", "accountIds": []any{account}}, "schedule": Object{"kind": "immediate"}}})
	if e != nil {
		t.Fatal("create", e)
	}
	id := str(obj(created["plan"])["id"])
	active, e := s.Action(ctx, auth.actor, id, "activate", Object{"operationId": uuid.NewString(), "expectedVersion": 1, "expectedRevision": 1})
	if e != nil {
		t.Fatal("activate", e)
	}
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	worker, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	wq, e := jobs.New(worker, nil)
	if e != nil {
		t.Fatal(e)
	}
	ws := &Service{Pool: worker, Endpoint: endpoint, Approver: auth, Jobs: wq, PlanLockWithin: WorkerPlanLockWithin, Now: func() time.Time { return now }}
	probe, e := worker.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	initial, e := ws.planWithin(ctx, probe, id, false)
	if e != nil {
		t.Fatalf("initial plan read: %v", e)
	}
	if _, e = ws.approvalWithin(ctx, probe, initial); e != nil {
		t.Fatalf("approval: %v", e)
	}
	if _, e = ws.planWithin(ctx, probe, id, true); e != nil {
		var p *pgconn.PgError
		if errors.As(e, &p) {
			t.Fatalf("plan lock SQLSTATE %s", p.Code)
		}
		t.Fatalf("plan lock error %T", e)
	}
	_ = probe.Rollback(ctx)
	jobID := str(obj(active["plan"])["jobId"])
	result, e := ws.ExecutePlan(ctx, jobs.Task{ID: jobID, Endpoint: endpoint, Action: jobs.MessagingRun, SourceID: id, OperationID: jobID, PlanVersion: 1})
	if e != nil {
		var p *pgconn.PgError
		if errors.As(e, &p) {
			match := regexp.MustCompile(`^permission denied for (?:table|sequence|function|schema|column) ([a-z0-9_]+)$`).FindStringSubmatch(p.Message)
			resource := "unknown"
			if len(match) == 2 {
				resource = match[1]
			}
			t.Fatalf("worker execution SQLSTATE %s closed-resource=%s", p.Code, resource)
		}
		t.Fatalf("worker execution error %T", e)
	}
	runID := str(obj(result["run"])["id"])
	if runID == "" || num(obj(obj(result["run"])["audience"])["accountCount"]) != 1 {
		t.Fatal("worker did not freeze one recipient")
	}
	var notices, recipients, deliveryJobs int
	if e = owner.QueryRow(ctx, `SELECT (SELECT count(*) FROM operations_notices_v1 WHERE id=$1), (SELECT count(*) FROM operations_messaging_recipients_v1 WHERE run_id=$1 AND account_id=$2 AND channel='inapp'), (SELECT count(*) FROM galaxy_go_jobs.executions_v1 WHERE source_id=$1 AND action='messaging-delivery')`, runID, account).Scan(&notices, &recipients, &deliveryJobs); e != nil {
		t.Fatal(e)
	}
	if notices != 1 || recipients != 1 || deliveryJobs != 1 {
		t.Fatalf("notice=%d recipients=%d deliveryJobs=%d", notices, recipients, deliveryJobs)
	}
	check, e := worker.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer check.Rollback(ctx)
	run, e := ws.runWithin(ctx, check, runID, false)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = ws.runtimeWithin(ctx, check, run); e != nil {
		t.Fatalf("runtimeWithin: %v", e)
	}
	if e = WorkerPlanLockWithin(ctx, check, id, "https://other.example.invalid"); fault.Code(e) != "operations_messaging_plan_not_found" {
		t.Fatal("foreign endpoint lock accepted")
	}
	if e = WorkerPlanLockWithin(ctx, check, uuid.NewString(), endpoint); fault.Code(e) != "operations_messaging_plan_not_found" {
		t.Fatal("missing plan lock accepted")
	}
}
