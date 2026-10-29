package operationsautonomy_test

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	files "github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// A program rule must reach the actual file scheduling ledger under its own
// current task authority. A model status cannot supply that receipt.
func TestCodeRuleSchedulesRealFileWithCurrentProgramGrant(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, admin)
	automation := f.Automation(t)
	setup := autonomyfixture.Setup(t, f, automation)
	endpoint, aiID := f.Endpoint, setup["aiAccountId"].(string)
	if _, e := databaseschema.Migrate(ctx, admin, []string{"worker"}); e != nil {
		t.Fatal(e)
	}
	if _, e := postgres.InTx(ctx, admin, func(tx pgx.Tx) (bool, error) {
		if e := objectremoval.MigrateWithin(ctx, tx); e != nil {
			return false, e
		}
		return true, objectremoval.ProvisionRolesWithin(ctx, tx)
	}); e != nil {
		t.Fatal(e)
	}
	at := time.Unix(2000000000, 0)
	accountService := &accounts.Service{Endpoint: endpoint, Now: func() time.Time { return at }}
	account, e := postgres.InTx(ctx, admin, func(tx pgx.Tx) (accounts.Account, error) {
		return accountService.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: f.Issuer, ExternalSubject: uuid.NewString(), VerificationMethod: "external-account", VerifiedAt: at})
	})
	if e != nil {
		t.Fatal(e)
	}
	target := uuid.NewString()
	bytes := []byte("Synthetic managed bytes " + target)
	hash := identity.Digest(bytes)
	if _, e = admin.Exec(ctx, `INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_attempts,scan_result,last_error) VALUES($1,$2,$3,'Synthetic scan','text/plain',$4,$3,$5,'isolated-managed-key','scan-pending',$6,$7,$6,$7,1,NULL,'attachment_scan_failed')`, target, account.ID, hash, len(bytes), "forum-attachments/"+target, at, at.Add(time.Hour)); e != nil {
		t.Fatal(e)
	}
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(2000000000, 0) }
	s := &a.Service{Pool: pool, Endpoint: endpoint, AIWork: &operationsai.Service{Endpoint: endpoint}, Now: now}
	task := uuid.NewString()
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (a.Object, error) {
		return s.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: task, Domain: "overview", AIAccountID: aiID})
	})
	if e != nil {
		t.Fatal(e)
	}
	autonomyfixture.Operation(t, admin, endpoint, f.IDs["root"], task, aiID, target, "files.scan.retry", true)
	if _, e = admin.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['files.read','files.scan.retry'] WHERE id=$1;`, setup["role"]); e != nil {
		t.Fatal(e)
	}
	if _, e = admin.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e = admin.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',target_type='file-forum',target_id=$3 WHERE endpoint=$1 AND id=$2`, endpoint, task, target); e != nil {
		t.Fatal(e)
	}
	fileService := &files.Service{Pool: pool, Endpoint: endpoint, Authority: &p.BusinessAuthority{Duty: s}, Duty: s, Forum: &files.FileAdapter{Available: func() bool { return true }}, Now: now}
	s.ActionReady = func(code string) bool { return code == "files.scan.retry" }
	s.QueryTool = func(ctx context.Context, actor p.Actor, domain, tool string, input a.Object) (a.Object, error) {
		read, e := fileService.Get(ctx, actor, "forum", input["id"].(string))
		if e != nil {
			return nil, e
		}
		return a.Object{"availability": "available", "data": read}, nil
	}
	calls := 0
	s.ExecuteDutyOperation = func(ctx context.Context, actor p.Actor, operation string, args a.Object, reconcile bool) (a.Object, error) {
		calls++
		if reconcile {
			t.Fatal("new intent treated as recovery")
		}
		read, e := fileService.Get(ctx, actor, "forum", target)
		if e != nil {
			return nil, e
		}
		command := a.Object{"operationId": operation, "kind": "scan", "expectedVersion": read["version"], "reason": args["reason"]}
		bound, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (p.Actor, error) {
			return s.BindDutyOperationWithin(ctx, tx, actor, a.DutyOperation{Permission: "files.scan.retry", TargetID: target, OperationID: operation, Request: args, Command: command})
		})
		if e != nil {
			return nil, e
		}
		receipt, e := fileService.Retry(ctx, bound, "forum", target, command)
		if e != nil {
			return nil, e
		}
		return a.Object{"operationId": operation, "state": "completed", "effectState": "completed", "basis": "persisted-domain-operation-receipt", "receipt": receipt, "target": a.Object{"kind": "forum-file", "id": target}}, nil
	}
	result, e := s.RunCodeTask(ctx, a.Object{"taskId": task})
	if e != nil || result["state"] != "completed" {
		t.Fatalf("program %v %#v", e, result)
	}
	result, e = s.RunCodeTask(ctx, a.Object{"taskId": task})
	if e != nil || result["state"] != "completed" || calls != 1 {
		t.Fatalf("terminal reexecution calls%d %v %#v", calls, e, result)
	}
	var receipts int
	var kind string
	var role *string
	var audit a.Object
	if e = admin.QueryRow(ctx, `SELECT count(*) FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 AND state='completed'`, endpoint, task).Scan(&receipts); e != nil || receipts != 1 {
		t.Fatalf("real business receipt %d %v", receipts, e)
	}
	if e = admin.QueryRow(ctx, `SELECT actor_kind,operator_role,actor_context FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='file-retry' AND selection->>'id'=$2`, endpoint, target).Scan(&kind, &role, &audit); e != nil || kind != "operations-ai-service" || role != nil || audit["taskId"] != task || audit["judgmentKind"] != "code" {
		t.Fatalf("program authority attribution %s %v %#v %v", kind, role, audit, e)
	}
}
