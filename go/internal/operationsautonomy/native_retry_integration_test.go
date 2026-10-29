package operationsautonomy_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type retryNative struct {
	task, run, session string
	omitUsage          bool
}

func (n *retryNative) Run(context.Context, a.Object) (a.Object, error) { return nil, nil }
func (n *retryNative) Read(context.Context, a.Object) (a.Object, error) {
	if n.omitUsage {
		return a.Object{"taskId": n.task, "nativeRunId": n.run, "sessionId": n.session, "status": "ERROR"}, nil
	}
	return a.Object{"taskId": n.task, "nativeRunId": n.run, "sessionId": n.session, "status": "ERROR", "run": a.Object{"runId": n.run, "calls": 29, "tokens": a.Object{"input": 1432518, "output": 10852, "total": 1443370}, "durationMs": 223831.4}}, nil
}
func (n *retryNative) Cancel(context.Context, a.Object) (a.Object, error)   { return nil, nil }
func (n *retryNative) Continue(context.Context, a.Object) (a.Object, error) { return nil, nil }

func TestRetryNativeAttemptPreservesOriginalAndRejectsStale(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	base := autonomyfixture.Setup(t, f, f.Automation(t))
	now := func() time.Time { return time.Unix(2000000000, 0) }
	task := uuid.NewString()
	native := &retryNative{task: task, run: uuid.NewString(), session: uuid.NewString()}
	jobs := []a.Object{}
	svc := &a.Service{Pool: f.Pool, Endpoint: f.Endpoint, AIWork: &operationsai.Service{Endpoint: f.Endpoint}, Authority: f.Gateway, Now: now, Native: native,
		EnqueueWithin: func(_ context.Context, _ pgx.Tx, _ string, v a.Object, _ string, _ *time.Time) error {
			jobs = append(jobs, v)
			return nil
		}}
	svc.Permissions = &operationspermissions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, StoredAuthority: f.Gateway, AIWork: svc.AIWork, Duty: svc, Now: now}
	if _, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (a.Object, error) {
		return svc.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: task, Domain: "overview", AIAccountID: base["aiAccountId"].(string)})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',mode='ai',state='unknown',model_state='failed',session_id=$3,native_run_id=$4,dispatch_started_at=$5 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task, native.session, native.run, now()); err != nil {
		t.Fatal(err)
	}
	// Ordinary progress changes the task revision but not its control identity.
	if _, err := owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='running',model_state='running',revision=revision+1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); err != nil {
		t.Fatal(err)
	}
	pause := a.Object{"kind": "pause", "operationId": uuid.NewString(), "expectedControlRevision": 1, "expectedNativeRunId": native.run, "expectedNativeAttemptId": nil}
	if _, err := svc.Control(ctx, f.Root, task, pause, nil); err != nil {
		t.Fatalf("progress incorrectly blocked pause: %v", err)
	}
	if _, err := owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='unknown',model_state='failed',control_state=NULL WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); err != nil {
		t.Fatal(err)
	}
	pause["operationId"] = uuid.NewString()
	if _, err := svc.Control(ctx, f.Root, task, pause, nil); err == nil {
		t.Fatal("stale control revision accepted")
	}
	pause["operationId"], pause["expectedControlRevision"] = uuid.NewString(), 2
	ended, err := svc.Control(ctx, f.Root, task, pause, nil)
	if err != nil || ended["applied"] != false || ended["outcome"] != "native-ended" {
		t.Fatalf("terminal pause not resolved: %v %v", ended, err)
	}
	svc.ValidateDutyRequest = func(input a.Object) (a.Object, error) { return input, nil }
	call, originalOp := uuid.NewString(), uuid.NewString()
	if _, err := owner.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,code,created_at,updated_at) VALUES($1,$2,$3,'execute-operation',$4,$5,'unknown','p13_strategy_revision_changed',$6,$6)`, f.Endpoint, task, call, a.Object{"kind": "ordinary-strategy-create-draft"}, originalOp, now()); err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := owner.QueryRow(ctx, `SELECT revision FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	op := uuid.NewString()
	input := a.Object{"kind": "retry", "operationId": op, "expectedRevision": revision}
	result, err := svc.Control(ctx, f.Root, task, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	var callState, callCode string
	if err := owner.QueryRow(ctx, `SELECT state,code FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, f.Endpoint, task, call).Scan(&callState, &callCode); err != nil || callState != "not-admitted" || callCode != "p13_strategy_revision_changed" {
		t.Fatalf("original fenced evidence missing: %s %s %v", callState, callCode, err)
	}
	previous, ok := result["previousAttempt"].(map[string]any)
	if !ok || previous["nativeRunId"] != native.run || previous["status"] != "ERROR" {
		t.Fatalf("previous identity missing: %v", result)
	}
	primary, _ := previous["primaryModelUsage"].(map[string]any)
	if primary["calls"] != 29 {
		t.Fatalf("original native usage not preserved: %v", primary)
	}
	var currentPrimary a.Object
	if err := owner.QueryRow(ctx, `SELECT primary_model_usage FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&currentPrimary); err != nil || currentPrimary != nil {
		t.Fatalf("new attempt inherited old primary: %v %v", currentPrimary, err)
	}
	if len(jobs) != 1 || jobs[0]["nativeAttemptId"] != op || jobs[0]["sessionId"] == native.session {
		t.Fatalf("bad job binding: %v", jobs)
	}
	replay, err := svc.Control(ctx, f.Root, task, input, nil)
	if err != nil || replay["replayed"] != true || len(jobs) != 1 {
		t.Fatalf("bad replay: %v %v", replay, err)
	}
	if a.RequireNativeAttempt(a.Object{"native_attempt_id": op}, a.Object{}) == nil || a.RequireNativeAttempt(a.Object{"native_attempt_id": op}, a.Object{"nativeAttemptId": op}) != nil {
		t.Fatal("attempt matcher failed")
	}

	// A terminal identity without a native usage snapshot cannot prove the old
	// observation was final. Preserve it as history, but leave the new total unknown.
	task = uuid.NewString()
	native.task, native.run, native.session, native.omitUsage = task, uuid.NewString(), uuid.NewString(), true
	if _, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (a.Object, error) {
		return svc.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: task, Domain: "overview", AIAccountID: base["aiAccountId"].(string)})
	}); err != nil {
		t.Fatal(err)
	}
	oldUsage := a.Object{"calls": 7, "inputTokens": 131400, "outputTokens": 3509, "totalTokens": 134909, "durationMs": 31732.65}
	if _, err := owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',mode='ai',state='unknown',model_state='failed',session_id=$3,native_run_id=$4,dispatch_started_at=$5,primary_model_usage=$6,model_usage=$6 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task, native.session, native.run, now(), oldUsage); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT revision FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	result, err = svc.Control(ctx, f.Root, task, a.Object{"kind": "retry", "operationId": uuid.NewString(), "expectedRevision": revision}, nil)
	if err != nil {
		t.Fatal(err)
	}
	previous, _ = result["previousAttempt"].(map[string]any)
	old, _ := previous["modelUsage"].(map[string]any)
	if previous["primaryModelUsage"] != nil || fmt.Sprint(old["calls"]) != "7" {
		t.Fatalf("missing native snapshot did not preserve only the old observation: %v", previous)
	}
	var currentTotal a.Object
	if err := owner.QueryRow(ctx, `SELECT primary_model_usage,model_usage FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&currentPrimary, &currentTotal); err != nil || currentPrimary != nil || currentTotal["calls"] != nil || currentTotal["inputTokens"] != nil || currentTotal["outputTokens"] != nil || currentTotal["totalTokens"] != nil || currentTotal["durationMs"] != nil {
		t.Fatalf("missing native snapshot did not keep current total unknown: %v %v %v", currentPrimary, currentTotal, err)
	}
}
