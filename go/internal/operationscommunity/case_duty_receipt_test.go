package operationscommunity_test

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	ops "github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestCaseResolveThroughOpaqueDutyAndOriginalReceiptPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.Principals(t, owner, "https://permissions.example.invalid", map[string]string{"root": "R", "writer": "W", "empty": "E"})
	fixture := seedManagedForum(t, owner, f)
	id := str(obj(fixture["report"])["reportId"])
	automation := f.Automation(t)
	base := autonomyfixture.Setup(t, f, automation)
	duty := &operationsautonomy.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, AIWork: &operationsai.Service{Endpoint: f.Endpoint}, Now: f.Now}
	permissions := &p.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, StoredAuthority: f.Gateway, AIWork: duty.AIWork, Duty: duty, Now: f.Now}
	forum := &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Now: f.Now, OperationsHandling: true}
	content := &ops.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Duty: duty, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, ReadPrincipalWithin: f.Gateway.ReadOperationsPrincipalWithin, Forum: forum, Links: &accountlinks.Service{Endpoint: f.Endpoint}, Now: f.Now}
	actionsService := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: permissions, Autonomy: duty, Content: content, Now: f.Now}
	duty.Permissions, duty.ActionReady, duty.QualifyTargetWithin, duty.ExecuteDutyOperation = permissions, actionsService.ActionReady, actionsService.QualifyTargetWithin, actionsService.ExecuteDutyOperation
	task := uuid.NewString()
	if _, e := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (object, error) {
		return duty.LinkWorkbenchWithin(ctx, tx, operationsautonomy.WorkbenchLink{OperationID: task, Domain: "overview", AIAccountID: str(base["aiAccountId"])})
	}); e != nil {
		t.Fatal(e)
	}
	if _, e := owner.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e := owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',dispatch_started_at=$3,native_run_id='case-original-run' WHERE endpoint=$1 AND id=$2`, f.Endpoint, task, f.Now()); e != nil {
		t.Fatal(e)
	}
	autonomyfixture.Operation(t, owner, f.Endpoint, f.IDs["root"], task, str(base["aiAccountId"]), id, "cases.resolve", false)
	if _, e := owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['autonomy.read','workbench.read','cases.read','cases.resolve'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, base["role"]); e != nil {
		t.Fatal(e)
	}
	request := object{"kind": "case-resolve", "targetId": id, "resolution": "needs-review", "summary": "Controlled public report review"}
	out, e := duty.Tool(ctx, object{"taskId": task, "nativeRunId": "case-original-run", "callId": uuid.NewString(), "tool": "execute-operation", "arguments": request}, false)
	if e != nil || out["state"] != "completed" {
		t.Fatalf("original duty %#v %v", out, e)
	}
	op := str(out["operationId"])
	duty.ReadTargetWithin = func(ctx context.Context, tx pgx.Tx, a p.Actor, domain, kind, target string) (object, error) {
		if kind != "community-report" {
			return object{"availability": "available"}, nil
		}
		_, e := content.CaseReadSourceWithin(ctx, tx, a, target)
		return object{"availability": "available"}, e
	}
	called := false
	duty.OriginalAIReceiptWithin = func(ctx context.Context, tx pgx.Tx, a p.Actor, src businessadmin.OriginalAIReceiptSource) (object, error) {
		called = true
		return content.CaseOriginalAIReceiptWithin(ctx, tx, a, src)
	}
	duty.OriginalAIReceiptQueryWithin = func(ctx context.Context, tx pgx.Tx, a p.Actor, auth p.Authority, src businessadmin.OriginalAIReceiptSource) (object, error) {
		return content.CaseOriginalAIReceiptQueryWithin(ctx, tx, a, auth, src)
	}
	result, e := duty.OriginalAIReceipt(ctx, f.Root, task, op)
	r := obj(result["receipt"])
	if e != nil || r["state"] != "recorded" || r["targetId"] != id || r["action"] != "cases.resolve" || r["version"] == nil {
		var audit, event, original object
		_ = owner.QueryRow(ctx, `SELECT to_jsonb(a) FROM business_admin_audit_v1 a WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op).Scan(&audit)
		_ = owner.QueryRow(ctx, `SELECT to_jsonb(a) FROM forum_operations_events_v1 a WHERE id=$1`, op).Scan(&event)
		_ = owner.QueryRow(ctx, `SELECT to_jsonb(a) FROM operations_ai_duty_operations_v1 a WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op).Scan(&original)
		t.Fatalf("original receipt %#v %v called=%v audit=%#v event=%#v duty=%#v", result, e, called, audit, event, original)
	}
	if _, e = owner.Exec(ctx, `UPDATE forum_operations_events_v1 SET summary='tampered' WHERE id=$1`, op); e != nil {
		t.Fatal(e)
	}
	if _, e = duty.OriginalAIReceipt(ctx, f.Root, task, op); e == nil {
		t.Fatal("changed original event accepted")
	}
}
