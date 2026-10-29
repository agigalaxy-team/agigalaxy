package actions

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaccounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"testing"
	"time"
)

func TestAccountDutyOriginalReceiptAndCurrentRead(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	base := autonomyfixture.Setup(t, f, automation)
	now := func() time.Time { return time.Unix(2000000000, 0) }
	accountService := &accounts.Service{Endpoint: f.Endpoint, Now: now}
	account, e := postgres.InTx(ctx, owner, func(tx pgx.Tx) (accounts.Account, error) {
		a, err := accountService.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: f.Issuer, ExternalSubject: uuid.NewString(), VerificationMethod: "external-account", VerifiedAt: now()})
		if err != nil {
			return a, err
		}
		kind := "person"
		_, err = accountService.EnsureProfileWithin(ctx, tx, a.ID, &kind)
		return a, err
	})
	if e != nil {
		t.Fatal(e)
	}
	duty := &operationsautonomy.Service{Pool: f.Pool, Endpoint: f.Endpoint, AIWork: &operationsai.Service{Endpoint: f.Endpoint}, Authority: f.Gateway, Now: now}
	perms := &operationspermissions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, StoredAuthority: f.Gateway, AIWork: duty.AIWork, Duty: duty, Now: now}
	domain := &businessadmin.Domain{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Duty: duty, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, Now: now}
	gov := &operationsaccounts.Service{Domain: domain, Accounts: accountService}
	svc := &Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: perms, Autonomy: duty, AccountGovernance: gov, Now: now}
	duty.Permissions, duty.ActionReady, duty.QualifyTargetWithin, duty.ExecuteDutyOperation = perms, svc.ActionReady, svc.QualifyTargetWithin, svc.ExecuteDutyOperation
	duty.ReadTargetWithin = func(ctx context.Context, tx pgx.Tx, a Actor, domain, kind, id string) (Object, error) {
		if kind != "account" {
			t.Fatalf("unexpected target %s", kind)
		}
		v, err := gov.AccountWithin(ctx, tx, id, false)
		if err != nil {
			return nil, err
		}
		if v["id"] != id {
			t.Fatal("account mismatch")
		}
		return Object{"availability": "available"}, nil
	}
	duty.OriginalAIReceiptWithin = func(ctx context.Context, tx pgx.Tx, a Actor, src businessadmin.OriginalAIReceiptSource) (Object, error) {
		return gov.OriginalAIReceiptWithin(ctx, tx, a, src)
	}
	duty.OriginalAIReceiptQueryWithin = func(ctx context.Context, tx pgx.Tx, a Actor, auth operationspermissions.Authority, src businessadmin.OriginalAIReceiptSource) (Object, error) {
		return gov.OriginalAIReceiptQueryWithin(ctx, tx, a, auth, src)
	}
	taskID := uuid.NewString()
	if _, e = postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (Object, error) {
		return duty.LinkWorkbenchWithin(ctx, tx, operationsautonomy.WorkbenchLink{OperationID: taskID, Domain: "overview", AIAccountID: str(base["aiAccountId"])})
	}); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine' WHERE endpoint=$1 AND id=$2`, f.Endpoint, taskID); e != nil {
		t.Fatal(e)
	}
	policy := autonomyfixture.Operation(t, owner, f.Endpoint, f.IDs["root"], taskID, str(base["aiAccountId"]), account.ID, "accounts.restriction.apply", false)
	if _, e = owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['autonomy.read','accounts.read','accounts.restriction.apply','accounts.restriction.release'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, base["role"]); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_automation_grants_v1 SET permissions=ARRAY['accounts.restriction.apply','accounts.restriction.release'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["grantId"]); e != nil {
		t.Fatal(e)
	}
	var cfg Object
	if e = owner.QueryRow(ctx, `SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["versionId"]).Scan(&cfg); e != nil {
		t.Fatal(e)
	}
	obj(obj(items(cfg["strategies"])[0])["execution"])["actions"] = []any{"accounts.restriction.apply", "accounts.restriction.release"}
	if _, e = owner.Exec(ctx, `UPDATE operations_p13_strategy_versions_v1 SET configuration=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["versionId"], cfg); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET configuration=jsonb_set(configuration,'{plan,actions}','["accounts.restriction.apply","accounts.restriction.release"]'::jsonb),dispatch_started_at=$3,native_run_id='synthetic-run' WHERE endpoint=$1 AND id=$2`, f.Endpoint, taskID, now()); e != nil {
		t.Fatal(e)
	}
	apply := Object{"kind": "account-restriction", "targetId": account.ID, "action": "apply", "until": now().Add(time.Hour).Format(time.RFC3339), "reason": "  Synthetic short restriction  "}
	result, e := duty.Tool(ctx, Object{"taskId": taskID, "nativeRunId": "synthetic-run", "callId": uuid.NewString(), "tool": "execute-operation", "arguments": apply}, false)
	if e != nil {
		t.Fatal(e)
	}
	if result["state"] != "completed" {
		t.Fatalf("apply %v", result)
	}
	op := str(result["operationId"])
	if _, e = duty.GetTask(ctx, f.Root, taskID); e != nil {
		t.Fatal("task source", e)
	}
	check := func(v Object, err error) {
		t.Helper()
		if err != nil {
			t.Fatal("receipt", err)
		}
		r := obj(v["receipt"])
		if r["state"] != "recorded" || r["operationId"] != op || r["action"] != "accounts.restriction.apply" || r["targetType"] != "account" || r["targetId"] != account.ID || r["metadataOnly"] != true {
			t.Fatalf("receipt metadata %v", r)
		}
	}
	check(duty.OriginalAIReceipt(ctx, f.Root, taskID, op))
	query := func() (Object, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (Object, error) {
			a, err := perms.HumanAIAccountReadWithin(ctx, tx, f.Root, "overview", str(base["aiAccountId"]), "query", "autonomy.read")
			if err != nil {
				return nil, err
			}
			return perms.WithOriginalAIReceiptReadWithin(ctx, tx, a, "accounts.read", func(a Actor, auth operationspermissions.Authority) (Object, error) {
				return duty.OriginalAIReceiptWithQueryWithin(ctx, tx, a, auth, taskID, op)
			})
		})
	}
	check(query())
	if _, err := duty.OriginalAIReceipt(ctx, f.Root, uuid.NewString(), op); err == nil {
		t.Fatal("wrong task accepted")
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_ai_duty_operations_v1 SET request=jsonb_set(request,'{reason}',to_jsonb('tampered'::text)) WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3`, f.Endpoint, taskID, op); e != nil {
		t.Fatal(e)
	}
	if _, err := duty.OriginalAIReceipt(ctx, f.Root, taskID, op); err == nil {
		t.Fatal("tampered request accepted")
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_ai_duty_operations_v1 SET request=jsonb_set(request,'{reason}',to_jsonb('Synthetic short restriction'::text)) WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3`, f.Endpoint, taskID, op); e != nil {
		t.Fatal(e)
	}
	// Only the same AI and grant may replace a prior automated restriction.
	actor, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (Actor, error) { return duty.DutyForTaskWithin(ctx, tx, taskID, "query") })
	if err != nil {
		t.Fatal(err)
	}
	var originalContext Object
	if e = owner.QueryRow(ctx, `SELECT actor_context FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op).Scan(&originalContext); e != nil {
		t.Fatal(e)
	}
	otherGrant := uuid.NewString()
	if _, e = owner.Exec(ctx, `INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at,ai_account_id,resource_scope_kind) SELECT $3,endpoint,'Other isolated account grant',executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at,ai_account_id,resource_scope_kind FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["grantId"], otherGrant); e != nil {
		t.Fatal(e)
	}
	denyOverride := func(label string) {
		t.Helper()
		var before, after int
		var revBefore, revAfter int
		if err := owner.QueryRow(ctx, `SELECT count(*) FROM business_admin_audit_v1 WHERE endpoint=$1 AND account_id=$2 AND action IN ('restriction-set','restriction-release')`, f.Endpoint, account.ID).Scan(&before); err != nil {
			t.Fatal(err)
		}
		if err := owner.QueryRow(ctx, `SELECT restriction_revision FROM community_accounts WHERE id=$1`, account.ID).Scan(&revBefore); err != nil {
			t.Fatal(err)
		}
		for _, request := range []Object{{"kind": "account-restriction", "targetId": account.ID, "action": "release", "reason": "Synthetic denial"}, apply} {
			v, err := svc.ExecuteDutyOperation(ctx, actor, uuid.NewString(), request, false)
			if err == nil && v["state"] == "completed" {
				t.Fatalf("%s overwrite accepted", label)
			}
		}
		if err := owner.QueryRow(ctx, `SELECT count(*) FROM business_admin_audit_v1 WHERE endpoint=$1 AND account_id=$2 AND action IN ('restriction-set','restriction-release')`, f.Endpoint, account.ID).Scan(&after); err != nil {
			t.Fatal(err)
		}
		if err := owner.QueryRow(ctx, `SELECT restriction_revision FROM community_accounts WHERE id=$1`, account.ID).Scan(&revAfter); err != nil {
			t.Fatal(err)
		}
		if before != after || revBefore != revAfter {
			t.Fatalf("%s changed original restriction: audit %d -> %d, revision %d -> %d", label, before, after, revBefore, revAfter)
		}
	}
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET grant_id=$3::uuid,actor_context=jsonb_set(actor_context,'{grantId}',to_jsonb(($3::uuid)::text)) WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, otherGrant); e != nil {
		t.Fatal(e)
	}
	denyOverride("other grant")
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET grant_id=$3::uuid,actor_context=$4 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, policy["grantId"], originalContext); e != nil {
		t.Fatal(e)
	}
	otherAI := automation["accounts"].(map[string]any)["governance"].(string)
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET operator_id='ai:'||$3::text,actor_context=jsonb_set(actor_context,'{aiAccountId}',to_jsonb($3::text)) WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, otherAI); e != nil {
		t.Fatal(e)
	}
	denyOverride("other AI")
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET operator_id='ai:'||$3::text,actor_context=$4 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, base["aiAccountId"], originalContext); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET actor_context=jsonb_set(actor_context,'{toolCallId}',to_jsonb($3::text)) WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, uuid.NewString()); e != nil {
		t.Fatal(e)
	}
	denyOverride("wrong original tool call")
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET actor_context=$3 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, originalContext); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET actor_context=actor_context-'toolCallId'-'toolOperationId'-'judgmentKind' WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op); e != nil {
		t.Fatal(e)
	}
	denyOverride("missing original call binding")
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET actor_context=$3 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, originalContext); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET actor_kind='business-operator',operator_id=$3,operator_role='administrator',grant_id=NULL,actor_context=NULL WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, f.IDs["root"]); e != nil {
		t.Fatal(e)
	}
	denyOverride("human decision")
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET actor_kind='operations-ai-service',operator_id='ai:'||$3::text,operator_role=NULL,grant_id=$4::uuid,actor_context=$5 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, base["aiAccountId"], policy["grantId"], originalContext); e != nil {
		t.Fatal(e)
	}
	release := Object{"kind": "account-restriction", "targetId": account.ID, "action": "release", "reason": "Synthetic short restriction ended"}
	released, err := duty.Tool(ctx, Object{"taskId": taskID, "nativeRunId": "synthetic-run", "callId": uuid.NewString(), "tool": "execute-operation", "arguments": release}, false)
	if err != nil || released["state"] != "completed" {
		t.Fatalf("same grant restore: %v %v", released, err)
	}
	releaseID := str(released["operationId"])
	readRelease, err := duty.OriginalAIReceipt(ctx, f.Root, taskID, releaseID)
	if err != nil || obj(readRelease["receipt"])["action"] != "accounts.restriction.release" || obj(readRelease["receipt"])["state"] != "recorded" {
		t.Fatalf("release original receipt: %v %v", readRelease, err)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_automation_grants_v1 SET enabled=false WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["grantId"]); e != nil {
		t.Fatal(e)
	}
	check(query())
	if _, e = owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['autonomy.read','accounts.restriction.apply','accounts.restriction.release'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, base["role"]); e != nil {
		t.Fatal(e)
	}
	if _, err := query(); err == nil {
		t.Fatal("AI without current accounts.read accepted")
	}
}
