package operationsqueries

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWorkbenchSummaryUsesRealDutyReadAuthorityPG(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	fixture := f.Automation(t)
	accounts := fixture["accounts"].(map[string]any)
	config, _ := pgxpool.ParseConfig(dsn)
	config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, "SET ROLE galaxy_api")
		return err
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(2000000000, 0) }
	duty := &operationsautonomy.Service{Pool: pool, Endpoint: f.Endpoint, AIWork: &operationsai.Service{Endpoint: f.Endpoint}, Now: now}
	authority := &operationspermissions.BusinessAuthority{Duty: duty}
	workbench := &Workbench{Domain: &businessadmin.Domain{Pool: pool, Endpoint: f.Endpoint, Authority: authority, Duty: duty, Now: now}}
	task := uuid.NewString()
	_, err = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return duty.LinkWorkbenchWithin(ctx, tx, operationsautonomy.WorkbenchLink{OperationID: task, Domain: "governance", AIAccountID: accounts["governance"].(string)})
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='governance'`, f.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',mode='ai',state='running',lease_until=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task, time.Unix(2000000600, 0)); err != nil {
		t.Fatal(err)
	}
	actor, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) { return duty.DutyForTaskWithin(ctx, tx, task, "query") })
	if err != nil {
		t.Fatal(err)
	}
	result, err := workbench.SummaryWithAuthority(ctx, actor, Object{"publicActivity": "deferred"}, authority)
	if err != nil {
		t.Fatalf("real duty summary: %v", err)
	}
	availability := object(result["availability"])
	if availability["feedback"] != "available" || result["feedback"] == nil {
		t.Fatalf("authorized counts missing: %v", availability)
	}
	if availability["communityReports"] != "not-authorized" || object(result["communityReports"]) != nil {
		t.Fatal("ungranted report counts were not excluded")
	}
	var auditCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='operations-summary-read' AND actor_kind='operations-ai-service'`, f.Endpoint).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("original read audit: %d %v", auditCount, err)
	}
	forged := actor
	forged.Proof = nil
	if _, err = workbench.SummaryWithAuthority(ctx, forged, Object{}, authority); err == nil {
		t.Fatal("forged duty accepted")
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='stopped' WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); err != nil {
		t.Fatal(err)
	}
	if _, err = workbench.SummaryWithAuthority(ctx, actor, Object{}, authority); err == nil {
		t.Fatal("stopped duty accepted")
	}
}
