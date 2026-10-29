package operationsautonomy_test

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"slices"
	"testing"
	"time"
)

type manualPauseNative struct {
	runID, pauseID, callID string
	cancels, continues     int
}

func (n *manualPauseNative) Run(context.Context, a.Object) (a.Object, error) { return nil, nil }
func (n *manualPauseNative) Read(context.Context, a.Object) (a.Object, error) {
	return a.Object{"status": "PAUSED", "modelState": "running", "nativeRunId": n.runID, "continuable": true, "manualPause": a.Object{"pauseOperationId": n.pauseID, "checkpointCallIds": []string{n.callID}}}, nil
}
func (n *manualPauseNative) Cancel(context.Context, a.Object) (a.Object, error) {
	n.cancels++
	return nil, nil
}
func (n *manualPauseNative) Continue(context.Context, a.Object) (a.Object, error) {
	n.continues++
	return a.Object{"modelState": "accepted"}, nil
}

func TestManualPauseRequestsCheckpointAndContinuesOriginalRun(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	base := autonomyfixture.Setup(t, f, automation)
	now := func() time.Time { return time.Unix(2000000000, 0) }
	native := &manualPauseNative{runID: "same-native-run", pauseID: uuid.NewString(), callID: uuid.NewString()}
	svc := &a.Service{Pool: f.Pool, Endpoint: f.Endpoint, AIWork: &operationsai.Service{Endpoint: f.Endpoint}, Authority: f.Gateway, Now: now, Native: native}
	perms := &operationspermissions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, StoredAuthority: f.Gateway, AIWork: svc.AIWork, Duty: svc, Now: now}
	svc.Permissions = perms
	task := uuid.NewString()
	if _, e := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (a.Object, error) {
		return svc.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: task, Domain: "overview", AIAccountID: base["aiAccountId"].(string)})
	}); e != nil {
		t.Fatal(e)
	}
	if _, e := owner.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e := owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine' WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); e != nil {
		t.Fatal(e)
	}
	autonomyfixture.Operation(t, owner, f.Endpoint, f.IDs["root"], task, base["aiAccountId"].(string), uuid.NewString(), "feedback.update", false)
	if _, e := owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['autonomy.read','feedback.read','feedback.update'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, base["role"]); e != nil {
		t.Fatal(e)
	}
	if _, e := owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET dispatch_started_at=$3,native_run_id=$4 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task, now(), native.runID); e != nil {
		t.Fatal(e)
	}
	var revision int64
	if e := owner.QueryRow(ctx, `SELECT revision FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&revision); e != nil {
		t.Fatal(e)
	}
	// An already-admitted writer retains the shared task lock until its original
	// receipt commits; the pause must wait for that transaction.
	writer, e := owner.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer writer.Rollback(ctx)
	if _, e = writer.Exec(ctx, `SELECT id FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2 FOR SHARE`, f.Endpoint, task); e != nil {
		t.Fatal(e)
	}
	committedOp := uuid.NewString()
	if _, e = writer.Exec(ctx, `INSERT INTO operations_autonomy_receipts_v1(id,endpoint,task_id,operation_id,action,state,basis,created_at) VALUES($1,$2,$3,$4,'fixture','completed','persisted-domain-operation-receipt',$5)`, uuid.NewString(), f.Endpoint, task, committedOp, now()); e != nil {
		t.Fatal(e)
	}
	type controlResult struct {
		value a.Object
		err   error
	}
	ready, finished := make(chan struct{}), make(chan controlResult, 1)
	go func() {
		close(ready)
		value, err := svc.Control(ctx, f.Root, task, a.Object{"kind": "pause", "operationId": native.pauseID, "expectedRevision": revision}, nil)
		finished <- controlResult{value, err}
	}()
	<-ready
	select {
	case result := <-finished:
		t.Fatalf("pause bypassed writer lock: %v %v", result.value, result.err)
	case <-time.After(150 * time.Millisecond):
	}
	if e = writer.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	result := <-finished
	paused, e := result.value, result.err
	if e != nil {
		t.Fatal(e)
	}
	var receiptState string
	if e = owner.QueryRow(ctx, `SELECT state FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3`, f.Endpoint, task, committedOp).Scan(&receiptState); e != nil || receiptState != "completed" {
		t.Fatalf("committed original receipt changed: %s %v", receiptState, e)
	}
	view := paused["task"].(map[string]any)
	if view["state"] != "running" || view["manualPause"].(map[string]any)["phase"] != "requested" || native.cancels != 0 {
		t.Fatalf("request pretended pause or cancelled: %v", view)
	}
	// No business effect is admitted after the pause won the task lock.
	calls := 0
	svc.ActionReady = func(string) bool { return true }
	svc.ExecuteDutyOperation = func(context.Context, operationspermissions.Actor, string, a.Object, bool) (a.Object, error) {
		calls++
		return nil, nil
	}
	attempt, e := svc.Tool(ctx, a.Object{"taskId": task, "nativeRunId": native.runID, "callId": uuid.NewString(), "tool": "execute-operation", "arguments": a.Object{"kind": "feedback-update", "targetId": uuid.NewString(), "state": "processing"}}, false)
	if e != nil || attempt["state"] != "not-admitted" || calls != 0 {
		t.Fatalf("writer admitted: %v %v calls=%d", attempt, e, calls)
	}
	// This is a real persisted call coordinate, supplied here without private body.
	if _, e = owner.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,'current-summary','{}',$4,'completed',$5,$5)`, f.Endpoint, task, native.callID, uuid.NewString(), now()); e != nil {
		t.Fatal(e)
	}
	unknownCall := uuid.NewString()
	if _, e = owner.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,'execute-operation','{}',$4,'unknown',$5,$5)`, f.Endpoint, task, unknownCall, uuid.NewString(), now()); e != nil {
		t.Fatal(e)
	}
	probe, err := svc.Authorize(ctx, a.Object{"taskId": task, "operation": "read"})
	if err != nil || len(probe["task"].(map[string]any)["manualPause"].(map[string]any)["eligibleCallIds"].([]string)) != 0 {
		t.Fatalf("unknown writer exposed checkpoint: %v %v", probe, err)
	}
	blocked, err := svc.Report(ctx, a.Object{"taskId": task, "nativeRunId": native.runID, "modelState": "running", "status": "waiting-human", "manualPause": a.Object{"pauseOperationId": native.pauseID, "checkpointCallIds": []string{native.callID}}})
	if err != nil || blocked["state"] != "unknown" {
		t.Fatalf("unknown writer allowed pause: %v %v", blocked, err)
	}
	// Simulate reconciliation in this isolated fixture before exercising the
	// successful checkpoint; production must reconcile the original operation.
	if _, e = owner.Exec(ctx, `DELETE FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, f.Endpoint, task, unknownCall); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='running' WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); e != nil {
		t.Fatal(e)
	}
	probe, err = svc.Authorize(ctx, a.Object{"taskId": task, "operation": "read"})
	if err != nil || !slices.Contains(probe["task"].(map[string]any)["manualPause"].(map[string]any)["eligibleCallIds"].([]string), native.callID) {
		t.Fatalf("recorded read missing checkpoint: %v %v", probe, err)
	}
	failedOperation := uuid.NewString()
	if _, e = owner.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,'execute-operation','{}',$4,'failed',$5,$5)`, f.Endpoint, task, uuid.NewString(), failedOperation, now()); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `INSERT INTO operations_autonomy_receipts_v1(id,endpoint,task_id,operation_id,action,state,basis,created_at) VALUES($1,$2,$3,$4,'fixture','failed','original-operation-query',$5)`, uuid.NewString(), f.Endpoint, task, failedOperation, now()); e != nil {
		t.Fatal(e)
	}
	humanCall := uuid.NewString()
	if _, e = owner.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,'execute-operation','{}',$4,'waiting-human',$5,$5)`, f.Endpoint, task, humanCall, uuid.NewString(), now()); e != nil {
		t.Fatal(e)
	}
	blocked, err = svc.Report(ctx, a.Object{"taskId": task, "nativeRunId": native.runID, "modelState": "running", "status": "waiting-human", "manualPause": a.Object{"pauseOperationId": native.pauseID, "checkpointCallIds": []string{native.callID}}})
	if err != nil || blocked["state"] != "unknown" {
		t.Fatalf("failed receipt masked pending human decision: %v %v", blocked, err)
	}
	if _, e = owner.Exec(ctx, `DELETE FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, f.Endpoint, task, humanCall); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='running' WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); e != nil {
		t.Fatal(e)
	}
	report, e := svc.Report(ctx, a.Object{"taskId": task, "nativeRunId": native.runID, "modelState": "running", "status": "waiting-human", "manualPause": a.Object{"pauseOperationId": native.pauseID, "checkpointCallIds": []string{native.callID}}})
	if e != nil || report["state"] != "paused" {
		t.Fatalf("native pause %v %v", report, e)
	}
	pauseReport := a.Object{"taskId": task, "nativeRunId": native.runID, "modelState": "running", "status": "waiting-human", "manualPause": a.Object{"pauseOperationId": native.pauseID, "checkpointCallIds": []string{native.callID}}}
	if again, err := svc.Report(ctx, pauseReport); err != nil || again["state"] != "paused" {
		t.Fatalf("repeat pause changed state: %v %v", again, err)
	}
	for _, staleStatus := range []string{"running", "unknown"} {
		stale, err := svc.Report(ctx, a.Object{"taskId": task, "nativeRunId": native.runID, "nativeContinuable": false, "modelState": "running", "status": staleStatus})
		if err != nil || stale["state"] != "paused" {
			t.Fatalf("old %s progress lost real pause: %v %v", staleStatus, stale, err)
		}
	}
	var stillContinuable bool
	if e = owner.QueryRow(ctx, `SELECT native_continuable FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&stillContinuable); e != nil || !stillContinuable {
		t.Fatalf("old progress removed continuation: %v %v", stillContinuable, e)
	}
	current, e := svc.GetTask(ctx, f.Root, task)
	if e != nil {
		t.Fatal(e)
	}
	view = current["task"].(map[string]any)
	if view["state"] != "paused" || view["businessState"] != "failed" || view["manualPause"].(map[string]any)["phase"] != "paused" {
		t.Fatalf("not paused %v", view)
	}
	resumeID := uuid.NewString()
	resume, e := svc.Control(ctx, f.Root, task, a.Object{"kind": "resume", "operationId": resumeID, "expectedRevision": view["revision"]}, nil)
	if e != nil || native.continues != 1 || native.cancels != 0 {
		t.Fatalf("same run resume %v %v", resume, e)
	}
	var phase string
	if e = owner.QueryRow(ctx, `SELECT control_state->>'phase' FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&phase); e != nil || phase != "resuming" {
		t.Fatalf("accepted ticket ended continuation early: %s %v", phase, e)
	}
	consumed := a.Object{"pauseOperationId": native.pauseID, "resumeOperationId": resumeID, "checkpointCallIds": []string{native.callID}}
	for i := 0; i < 2; i++ {
		if _, e = svc.Report(ctx, a.Object{"taskId": task, "nativeRunId": native.runID, "modelState": "running", "status": "running", "manualResumeConsumed": consumed}); e != nil {
			t.Fatalf("consumed report %d: %v", i, e)
		}
	}
	if e = owner.QueryRow(ctx, `SELECT control_state->>'phase' FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&phase); e != nil || phase != "ended" {
		t.Fatalf("confirmed continuation not ended: %s %v", phase, e)
	}
	if late, err := svc.Report(ctx, pauseReport); err != nil || late["state"] != "running" {
		t.Fatalf("late prior pause changed resumed run: %v %v", late, err)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='waiting-human',control_state=jsonb_set(control_state,'{outcome}',to_jsonb('natural-human-review'::text)) WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); e != nil {
		t.Fatal(e)
	}
	if late, err := svc.Report(ctx, pauseReport); err != nil || late["state"] != "waiting-human" {
		t.Fatalf("old checkpoint changed natural human review: %v %v", late, err)
	}
	if late, err := svc.Report(ctx, a.Object{"taskId": task, "nativeRunId": native.runID, "modelState": "running", "status": "running"}); err != nil || late["state"] != "waiting-human" {
		t.Fatalf("old progress changed natural human review: %v %v", late, err)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='running',control_state=jsonb_set(control_state,'{outcome}',to_jsonb('resumed'::text)) WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); e != nil {
		t.Fatal(e)
	}
	if e = owner.QueryRow(ctx, `SELECT revision FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&revision); e != nil {
		t.Fatal(e)
	}
	if _, e = svc.Control(ctx, f.Root, task, a.Object{"kind": "pause", "operationId": uuid.NewString(), "expectedRevision": revision}, nil); e != nil {
		t.Fatal(e)
	}
	if late, err := svc.Report(ctx, pauseReport); err == nil {
		t.Fatalf("old checkpoint accepted for new pause: %v", late)
	}
	var currentState string
	if e = owner.QueryRow(ctx, `SELECT state,control_state->>'phase' FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&currentState, &phase); e != nil || currentState != "running" || phase != "requested" {
		t.Fatalf("old checkpoint changed new request: %s %s %v", currentState, phase, e)
	}
	ended, err := svc.Report(ctx, a.Object{"taskId": task, "nativeRunId": native.runID, "modelState": "completed", "status": "completed"})
	if err != nil || ended["state"] != "failed" {
		t.Fatalf("natural completion lost prior failed business fact: %v %v", ended, err)
	}
	var outcome string
	if e = owner.QueryRow(ctx, `SELECT control_state->>'phase',control_state->>'outcome' FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&phase,&outcome); e != nil || phase != "ended" || outcome != "native-ended" {
		t.Fatalf("natural completion did not retire request: %s %v", phase, e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='paused',control_state=jsonb_set(control_state,'{phase}',to_jsonb('paused'::text)) WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); e != nil { t.Fatal(e) }
	if _, e = svc.Report(ctx, a.Object{"taskId":task, "nativeRunId":native.runID, "modelState":"completed", "status":"completed"}); e != nil { t.Fatal(e) }
	if e = owner.QueryRow(ctx, `SELECT control_state->>'outcome' FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&outcome); e != nil || outcome != "native-ended-after-checkpoint" { t.Fatalf("completed after real pause lost checkpoint: %s %v",outcome,e) }
}
