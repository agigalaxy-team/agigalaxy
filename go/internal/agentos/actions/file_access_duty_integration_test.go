package actions

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestFileAccessThroughOpaqueDutyOriginalOperation(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	base := autonomyfixture.Setup(t, f, automation)
	if _, e := databaseschema.Migrate(ctx, owner, []string{"worker"}); e != nil {
		t.Fatal(e)
	}
	if _, e := postgres.InTx(ctx, owner, func(tx pgx.Tx) (bool, error) {
		if e := objectremoval.MigrateWithin(ctx, tx); e != nil {
			return false, e
		}
		return true, objectremoval.ProvisionRolesWithin(ctx, tx)
	}); e != nil {
		t.Fatal(e)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	account, e := postgres.InTx(ctx, owner, func(tx pgx.Tx) (accounts.Account, error) {
		return (&accounts.Service{Endpoint: f.Endpoint, Now: now}).EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: f.Issuer, ExternalSubject: uuid.NewString(), VerificationMethod: "external-account", VerifiedAt: now()})
	})
	if e != nil {
		t.Fatal(e)
	}
	fileID := uuid.NewString()
	otherFileID := uuid.NewString()
	hash := identity.Digest([]byte("synthetic"))
	expiry := now().Add(time.Hour)
	if _, e = owner.Exec(ctx, `INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_attempts,scan_result) VALUES($1,$2,$3,'Synthetic','text/plain',9,$3,$4,'fixture-key','available',$5,$6,$5,$6,1,$7)`, fileID, account.ID, hash, "forum-attachments/"+fileID, now(), expiry, Object{"state": "clean", "checkedAt": now().Unix()}); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_attempts,scan_result) VALUES($1,$2,$3,'Synthetic other','text/plain',9,$3,$4,'fixture-key','available',$5,$6,$5,$6,1,$7)`, otherFileID, account.ID, hash, "forum-attachments/"+otherFileID, now(), expiry, Object{"state": "clean", "checkedAt": now().Unix()}); e != nil {
		t.Fatal(e)
	}
	duty := &operationsautonomy.Service{Pool: f.Pool, Endpoint: f.Endpoint, AIWork: &operationsai.Service{Endpoint: f.Endpoint}, Now: now}
	permissions := &operationspermissions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, StoredAuthority: f.Gateway, AIWork: duty.AIWork, Duty: duty, Now: now}
	forum := &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Now: now}
	adapter := (&community.AttachmentService{Forum: forum}).GovernanceAdapter()
	files := &filegovernance.Service{Pool: f.Pool, Endpoint: f.Endpoint, Duty: duty, Authority: f.Gateway, StoredAuthority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, Now: now, Forum: adapter}
	service := &Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: permissions, Autonomy: duty, Files: files, Now: now}
	duty.Permissions, duty.ActionReady, duty.QualifyTargetWithin, duty.ExecuteDutyOperation = permissions, service.ActionReady, service.QualifyTargetWithin, service.ExecuteDutyOperation
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
	policy := autonomyfixture.Operation(t, owner, f.Endpoint, f.IDs["root"], taskID, str(base["aiAccountId"]), fileID, "files.access.stop", false)
	if _, e = owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['autonomy.read','files.read','files.access.stop','files.access.restore'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, base["role"]); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_automation_grants_v1 SET permissions=ARRAY['files.access.stop','files.access.restore'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["grantId"]); e != nil {
		t.Fatal(e)
	}
	var cfg Object
	if e = owner.QueryRow(ctx, `SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["versionId"]).Scan(&cfg); e != nil {
		t.Fatal(e)
	}
	obj(obj(items(cfg["strategies"])[0])["execution"])["actions"] = []any{"files.access.stop", "files.access.restore"}
	if _, e = owner.Exec(ctx, `UPDATE operations_p13_strategy_versions_v1 SET configuration=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["versionId"], cfg); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET configuration=jsonb_set(configuration,'{plan,actions}','["files.access.stop","files.access.restore"]'::jsonb) WHERE endpoint=$1 AND id=$2`, f.Endpoint, taskID); e != nil {
		t.Fatal(e)
	}
	actor, e := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (Actor, error) { return duty.DutyForTaskWithin(ctx, tx, taskID, "query") })
	if e != nil {
		t.Fatal(e)
	}
	request := Object{"kind": "file-access", "targetKind": "forum", "targetId": fileID, "action": "stop", "until": now().Add(30 * time.Minute).Unix(), "reason": "Synthetic authorized file test"}
	outside := Object{"kind": "file-access", "targetKind": "forum", "targetId": otherFileID, "action": "stop", "until": now().Add(30 * time.Minute).Unix(), "reason": "Outside selected grant"}
	outsideID := uuid.NewString()
	_, e = service.ExecuteDutyOperation(ctx, actor, outsideID, outside, false)
	var rejected *operationsautonomy.PreparationRejection
	if !errors.As(e, &rejected) || rejected.Phase() != "bind" {
		t.Fatalf("outside scope did not fail before dispatch: %v", e)
	}
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, outsideID).Scan(&count); e != nil || count != 0 {
		t.Fatalf("rejected operation persisted: count=%d err=%v", count, e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET dispatch_started_at=$3,native_run_id='synthetic-run' WHERE endpoint=$1 AND id=$2`, f.Endpoint, taskID, now()); e != nil {
		t.Fatal(e)
	}
	callID := uuid.NewString()
	result, e := duty.Tool(ctx, Object{"taskId": taskID, "nativeRunId": "synthetic-run", "callId": callID, "tool": "execute-operation", "arguments": request}, false)
	if e != nil {
		t.Fatal(e)
	}
	if result["state"] != "completed" {
		t.Fatalf("stop %#v", result)
	}
	op := str(result["operationId"])
	recovered, e := service.ExecuteDutyOperation(ctx, actor, op, request, true)
	if e != nil || recovered["state"] != "completed" {
		t.Fatalf("original %#v %v", recovered, e)
	}
	duty.Authority = f.Gateway
	duty.ReadTargetWithin = func(ctx context.Context, tx pgx.Tx, a Actor, domain, kind, id string) (Object, error) {
		if kind != "forum-file" {
			t.Fatalf("unexpected target kind %s", kind)
		}
		if _, err := files.ScopeFileAccessWithin(ctx, tx, "forum", id, false); err != nil {
			return nil, err
		}
		return Object{"availability": "available"}, nil
	}
	duty.OriginalAIReceiptWithin = func(ctx context.Context, tx pgx.Tx, a Actor, src businessadmin.OriginalAIReceiptSource) (Object, error) {
		return files.OriginalAIReceiptWithin(ctx, tx, a, src)
	}
	duty.OriginalAIReceiptQueryWithin = func(ctx context.Context, tx pgx.Tx, a Actor, authority operationspermissions.Authority, src businessadmin.OriginalAIReceiptSource) (Object, error) {
		return files.OriginalAIReceiptQueryWithin(ctx, tx, a, authority, src)
	}
	checkReceipt := func(value Object, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("original receipt: %v", err)
		}
		r := obj(value["receipt"])
		if r["state"] != "recorded" || r["operationId"] != op || r["action"] != "files.access.stop" || r["targetType"] != "file-forum" || r["targetId"] != fileID || r["metadataOnly"] != true || r["version"] == nil {
			t.Fatalf("invalid original metadata: %#v", r)
		}
	}
	checkReceipt(duty.OriginalAIReceipt(ctx, f.Root, taskID, op))
	queryReceipt := func() (Object, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (Object, error) {
			queryActor, err := permissions.HumanAIAccountReadWithin(ctx, tx, f.Root, "overview", str(base["aiAccountId"]), "query", "autonomy.read")
			if err != nil {
				return nil, err
			}
			return permissions.WithOriginalAIReceiptReadWithin(ctx, tx, queryActor, "files.read", func(a Actor, auth operationspermissions.Authority) (Object, error) {
				return duty.OriginalAIReceiptWithQueryWithin(ctx, tx, a, auth, taskID, op)
			})
		})
	}
	checkReceipt(queryReceipt())
	// A changed frozen request must not be accepted as the original operation.
	if _, e = owner.Exec(ctx, `UPDATE operations_ai_duty_operations_v1 SET request=jsonb_set(request,'{reason}',to_jsonb('tampered'::text)) WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3`, f.Endpoint, taskID, op); e != nil {
		t.Fatal(e)
	}
	if _, e = duty.OriginalAIReceipt(ctx, f.Root, taskID, op); e == nil {
		t.Fatal("tampered original request accepted")
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_ai_duty_operations_v1 SET request=jsonb_set(request,'{reason}',to_jsonb('Synthetic authorized file test'::text)) WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3`, f.Endpoint, taskID, op); e != nil {
		t.Fatal(e)
	}
	checkReceipt(duty.OriginalAIReceipt(ctx, f.Root, taskID, op))
	if _, err := duty.OriginalAIReceipt(ctx, f.Root, uuid.NewString(), op); err == nil {
		t.Fatal("cross-task receipt accepted")
	}
	restore := Object{"kind": "file-access", "targetKind": "forum", "targetId": fileID, "action": "restore", "reason": "Synthetic original restore"}
	// Model a prior decision from a different grant or AI in this isolated DB;
	// neither may be overwritten by the current duty's automatic restore.
	otherGrant := uuid.NewString()
	if _, e = owner.Exec(ctx, `INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at,ai_account_id,resource_scope_kind) SELECT $3,endpoint,'Other isolated grant',executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at,ai_account_id,resource_scope_kind FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["grantId"], otherGrant); e != nil {
		t.Fatal(e)
	}
	denyOverride := func(label string) {
		t.Helper()
		var before, after int
		if e = owner.QueryRow(ctx, `SELECT count(*) FROM operations_file_access_events_v1 WHERE endpoint=$1 AND file_id=$2`, f.Endpoint, fileID).Scan(&before); e != nil {
			t.Fatal(e)
		}
		value, err := service.ExecuteDutyOperation(ctx, actor, uuid.NewString(), restore, false)
		if err == nil && value["state"] == "completed" {
			t.Fatalf("%s decision overwritten: %#v", label, value)
		}
		if e = owner.QueryRow(ctx, `SELECT count(*) FROM operations_file_access_events_v1 WHERE endpoint=$1 AND file_id=$2`, f.Endpoint, fileID).Scan(&after); e != nil {
			t.Fatal(e)
		}
		if before != after {
			t.Fatalf("%s wrote an event", label)
		}
	}
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET grant_id=$3::uuid,actor_context=jsonb_set(actor_context,'{grantId}',to_jsonb(($3::uuid)::text)) WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, otherGrant); e != nil {
		t.Fatal(e)
	}
	denyOverride("other grant")
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET grant_id=$3::uuid,actor_context=jsonb_set(actor_context,'{grantId}',to_jsonb(($3::uuid)::text)) WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, policy["grantId"]); e != nil {
		t.Fatal(e)
	}
	otherAI := automation["accounts"].(map[string]any)["governance"].(string)
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET operator_id='ai:'||$3::text,actor_context=jsonb_set(actor_context,'{aiAccountId}',to_jsonb($3::text)) WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, otherAI); e != nil {
		t.Fatal(e)
	}
	denyOverride("other AI")
	if _, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET operator_id='ai:'||$3::text,actor_context=jsonb_set(actor_context,'{aiAccountId}',to_jsonb($3::text)) WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, base["aiAccountId"]); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE forum_attachments_v1 SET expires_at=$2 WHERE id=$1`, fileID, now().Add(-time.Second)); e != nil {
		t.Fatal(e)
	}
	denyOverride("expired source")
	if _, e = owner.Exec(ctx, `UPDATE forum_attachments_v1 SET expires_at=$2 WHERE id=$1`, fileID, expiry); e != nil {
		t.Fatal(e)
	}
	out, e := service.ExecuteDutyOperation(ctx, actor, uuid.NewString(), restore, false)
	if e != nil || out["state"] != "completed" {
		t.Fatalf("restore %#v %v", out, e)
	}
	// The human card uses the same frozen request but requires the original
	// currently authorized portal principal to explicitly confirm it.
	permissions.Authority, permissions.StoredAuthority = f.Gateway, f.Gateway
	staleOp := uuid.NewString()
	staleProposal, e := service.Prepare(ctx, f.Root, "overview", request, staleOp)
	if e != nil {
		t.Fatal("stale version prepare", e)
	}
	if _, e = owner.Exec(ctx, `UPDATE forum_attachments_v1 SET scan_attempts=scan_attempts+1 WHERE id=$1`, fileID); e != nil {
		t.Fatal(e)
	}
	var eventCountBefore, eventCountAfter int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM operations_file_access_events_v1 WHERE endpoint=$1 AND file_id=$2`, f.Endpoint, fileID).Scan(&eventCountBefore); e != nil {
		t.Fatal(e)
	}
	staleResult, staleErr := service.ExecutePrepared(ctx, f.Root, staleProposal, staleOp, func(context.Context, pgx.Tx) (Actor, error) { return f.Root, nil })
	if staleErr == nil && staleResult["state"] == "completed" {
		t.Fatalf("changed file version accepted %#v", staleResult)
	}
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM operations_file_access_events_v1 WHERE endpoint=$1 AND file_id=$2`, f.Endpoint, fileID).Scan(&eventCountAfter); e != nil {
		t.Fatal(e)
	}
	if eventCountBefore != eventCountAfter {
		t.Fatal("changed file version produced an event")
	}
	if _, e = owner.Exec(ctx, `UPDATE forum_attachments_v1 SET scan_attempts=scan_attempts-1 WHERE id=$1`, fileID); e != nil {
		t.Fatal(e)
	}
	humanOp := uuid.NewString()
	proposal, e := service.Prepare(ctx, f.Root, "overview", request, humanOp)
	if e != nil {
		t.Fatal("human prepare", e)
	}
	human, e := service.ExecutePrepared(ctx, f.Root, proposal, humanOp, func(context.Context, pgx.Tx) (Actor, error) { return f.Root, nil })
	if e != nil || human["state"] != "completed" {
		t.Fatalf("human confirmed %#v %v", human, e)
	}
	denyOverride("human")
	humanRestoreOp := uuid.NewString()
	humanRestore, e := service.Prepare(ctx, f.Root, "overview", restore, humanRestoreOp)
	if e != nil {
		t.Fatal("human restore prepare", e)
	}
	humanRestored, e := service.ExecutePrepared(ctx, f.Root, humanRestore, humanRestoreOp, func(context.Context, pgx.Tx) (Actor, error) { return f.Root, nil })
	if e != nil || humanRestored["state"] != "completed" {
		t.Fatalf("human restored %#v %v", humanRestored, e)
	}
	// Historical metadata remains readable after the original grant is disabled.
	if _, e = owner.Exec(ctx, `UPDATE operations_automation_grants_v1 SET enabled=false WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["grantId"]); e != nil {
		t.Fatal(e)
	}
	checkReceipt(queryReceipt())
	if _, e = owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['autonomy.read','files.access.stop','files.access.restore'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, base["role"]); e != nil {
		t.Fatal(e)
	}
	if _, e = queryReceipt(); e == nil {
		t.Fatal("receipt exposed after fixed AI files.read revoked")
	}
}
