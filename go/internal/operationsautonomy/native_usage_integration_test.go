package operationsautonomy

import (
	"context"
	"math"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

func TestTerminalNativeUsageSnapshotsAreMonotonicAndAttemptBound(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, pool, nil); err != nil {
		t.Fatal(err)
	}
	endpoint, id, ai, attempt := "https://native-usage.invalid", uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'overview','fixture','',true,1,1,now(),now())`, ai, endpoint); err != nil {
		t.Fatal(err)
	}
	old := Object{"calls": 7, "inputTokens": 131400, "outputTokens": 3509, "totalTokens": 134909, "durationMs": 31732.65}
	if _, err := pool.Exec(ctx, `INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,native_run_id,native_attempt_id,dispatch_started_at,primary_model_usage,model_usage,due_at,created_at,updated_at) VALUES($1,$2,'overview','routine',$1::uuid::text,'fixture','ai','failed','failed','not-started',$3,'{}',1,1,$4,'native-original',$5,now(),$6,$6,now(),now(),now())`, id, endpoint, ai, uuid.NewString(), attempt, jsonText(old)); err != nil {
		t.Fatal(err)
	}
	s := &Service{Pool: pool, Endpoint: endpoint}
	newer := Object{"calls": 29, "inputTokens": 1432518, "outputTokens": 10852, "totalTokens": 1443370, "durationMs": 223831.4}
	report := Object{"taskId": id, "nativeRunId": "native-original", "nativeAttemptId": attempt, "status": "failed", "modelState": "failed", "modelUsage": newer}
	if _, err := s.Report(ctx, report); err != nil {
		t.Fatal(err)
	}
	var primary, total Object
	var state, model string
	var revision int
	if err := pool.QueryRow(ctx, `SELECT primary_model_usage,model_usage,state,model_state,revision FROM operations_autonomy_tasks_v1 WHERE id=$1`, id).Scan(&primary, &total, &state, &model, &revision); err != nil {
		t.Fatal(err)
	}
	if !sameValue(primary, newer) || !sameValue(total, newer) || state != "failed" || model != "failed" {
		t.Fatalf("terminal snapshot %v %v %s %s", primary, total, state, model)
	}
	stale := obj(clone(report))
	stale["modelUsage"] = old
	stale["status"] = "running"
	stale["modelState"] = "running"
	if _, err := s.Report(ctx, stale); err != nil {
		t.Fatal(err)
	}
	var after Object
	var afterState, afterModel string
	var afterRevision int
	if err := pool.QueryRow(ctx, `SELECT primary_model_usage,state,model_state,revision FROM operations_autonomy_tasks_v1 WHERE id=$1`, id).Scan(&after, &afterState, &afterModel, &afterRevision); err != nil {
		t.Fatal(err)
	}
	if !sameValue(after, newer) || afterState != "failed" || afterModel != "failed" || afterRevision != revision {
		t.Fatalf("stale snapshot regressed %v %s %s", after, afterState, afterModel)
	}
	wrong := obj(clone(report))
	wrong["nativeAttemptId"] = uuid.NewString()
	if _, err := s.Report(ctx, wrong); err == nil {
		t.Fatal("old attempt accepted")
	}
	bad := obj(clone(report))
	bad["modelUsage"] = Object{"calls": 29, "inputTokens": 1, "outputTokens": 1, "totalTokens": 2, "durationMs": math.Inf(1)}
	if _, err := s.Report(ctx, bad); err == nil {
		t.Fatal("nonfinite usage accepted")
	}
	// A retry command preserves only its original native primary snapshot.
	// The current attempt and each workbench run are added exactly once.
	retry, nextAttempt := uuid.NewString(), uuid.NewString()
	workbench := Object{"calls": 2, "inputTokens": 200, "outputTokens": 20, "totalTokens": 220, "durationMs": 100.0}
	if _, err := pool.Exec(ctx, `INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,model_state,state,usage,created_at,updated_at) VALUES($1,$2,$3,'completed','completed',$4,now(),now())`, endpoint, id, uuid.NewString(), jsonText(workbench)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO operations_autonomy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,'fixture','control',$3,$4,now())`, endpoint, retry, jsonText(Object{"kind": "retry", "id": id}), jsonText(Object{"previousAttempt": Object{"primaryModelUsage": newer, "modelUsage": Object{"calls": 31}}})); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='running',model_state='running',native_run_id='native-second',native_attempt_id=$2,primary_model_usage=NULL WHERE id=$1`, id, nextAttempt); err != nil {
		t.Fatal(err)
	}
	second := Object{"calls": 1, "inputTokens": 100, "outputTokens": 10, "totalTokens": 110, "durationMs": 50.0}
	if _, err := s.Report(ctx, Object{"taskId": id, "nativeRunId": "native-second", "nativeAttemptId": nextAttempt, "status": "running", "modelState": "running", "modelUsage": second}); err != nil {
		t.Fatal(err)
	}
	var combined Object
	if err := pool.QueryRow(ctx, `SELECT model_usage FROM operations_autonomy_tasks_v1 WHERE id=$1`, id).Scan(&combined); err != nil {
		t.Fatal(err)
	}
	expected := Object{"calls": 32, "inputTokens": 1432818, "outputTokens": 10882, "totalTokens": 1443700, "durationMs": 223981.4}
	if !sameValue(combined, expected) {
		t.Fatalf("attempt/workbench usage was duplicated or lost: %v", combined)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO operations_autonomy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,'fixture','control',$3,$4,now())`, endpoint, uuid.NewString(), jsonText(Object{"kind":"retry","id":id}), jsonText(Object{"previousAttempt":Object{"modelUsage":Object{"calls":123}}})); err != nil { t.Fatal(err) }
	second["calls"] = 2
	if _, err := s.Report(ctx, Object{"taskId":id,"nativeRunId":"native-second","nativeAttemptId":nextAttempt,"status":"running","modelState":"running","modelUsage":second}); err != nil { t.Fatal(err) }
	if err := pool.QueryRow(ctx, `SELECT model_usage FROM operations_autonomy_tasks_v1 WHERE id=$1`, id).Scan(&combined); err != nil { t.Fatal(err) }
	if combined["calls"] != nil { t.Fatalf("legacy aggregate was guessed as an original primary snapshot: %v",combined) }
}
