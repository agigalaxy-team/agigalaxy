package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"strings"
	"testing"
)

func TestFinalAnalysisTerminalRaceAndIdempotency(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, pool, nil); err != nil {
		t.Fatal(err)
	}
	endpoint, id, ai := "https://final-report.invalid", uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'overview','fixture','',true,1,1,now(),now())`, ai, endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,native_run_id,dispatch_started_at,summary,due_at,created_at,updated_at) VALUES($1,$2,'overview','routine',$1::uuid::text,'fixture','ai','completed','completed','not-started',$3,'{}',1,1,$4,'native-original',now(),'original summary',now(),now(),now())`, id, endpoint, ai, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	s := &Service{Pool: pool, Endpoint: endpoint}
	input := Object{"taskId": id, "nativeRunId": "native-original", "status": "completed", "modelState": "completed", "finalAnalysis": Object{"state": "available", "text": "安全分析"}}
	if _, err := s.Report(ctx, input); err != nil {
		t.Fatal(err)
	}
	var first Object
	var revision int
	var summary, state string
	if err := pool.QueryRow(ctx, `SELECT result,revision,summary,state FROM operations_autonomy_tasks_v1 WHERE id=$1`, id).Scan(&first, &revision, &summary, &state); err != nil {
		t.Fatal(err)
	}
	if obj(first["analysis"])["text"] != "安全分析" || summary != "original summary" || state != "completed" {
		t.Fatalf("wrong original task %#v %s %s", first, summary, state)
	}
	if _, err := s.Report(ctx, input); err != nil {
		t.Fatal(err)
	}
	var repeated int
	if err := pool.QueryRow(ctx, `SELECT revision FROM operations_autonomy_tasks_v1 WHERE id=$1`, id).Scan(&repeated); err != nil || revision != repeated {
		t.Fatalf("repeat changed revision %d %d %v", revision, repeated, err)
	}
	input["finalAnalysis"] = Object{"state": "available", "text": "不同分析"}
	if _, err := s.Report(ctx, input); fault.Code(err) != "operations_autonomy_operation_conflict" {
		t.Fatalf("different analysis accepted: %v", err)
	}
	input["nativeRunId"] = "different"
	if _, err := s.Report(ctx, input); fault.Code(err) != "operations_autonomy_operation_conflict" {
		t.Fatalf("different run accepted: %v", err)
	}
	input["nativeRunId"] = "native-original"
	input["finalAnalysis"] = Object{"state": "available", "text": strings.Repeat("界", 4000)}
	if _, err := parseReport(input); err != nil {
		t.Fatalf("exact UTF-8 limit rejected: %v", err)
	}
	input["finalAnalysis"] = Object{"state": "available", "text": strings.Repeat("界", 4001)}
	if _, err := s.Report(ctx, input); fault.Status(err) != 400 {
		t.Fatalf("oversize accepted: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET result=NULL,state='unknown',model_state='completed' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	input["finalAnalysis"] = Object{"state": "available", "text": strings.Repeat("\x01", 4000)}
	if _, err := s.Report(ctx, input); err != nil {
		t.Fatal(err)
	}
	var result Object
	if err := pool.QueryRow(ctx, `SELECT result,state FROM operations_autonomy_tasks_v1 WHERE id=$1`, id).Scan(&result, &state); err != nil {
		t.Fatal(err)
	}
	if state != "unknown" || obj(result["analysis"])["reason"] != "encoded-result-limit" || obj(result["analysis"])["text"] != nil {
		t.Fatalf("unknown/encoded result changed %#v %s", result, state)
	}
	if _, err := s.Report(ctx, input); err != nil {
		t.Fatal(err)
	}
	input["finalAnalysis"] = Object{"state": "available", "text": strings.Repeat("\x02", 4000)}
	if _, err := s.Report(ctx, input); fault.Code(err) != "operations_autonomy_operation_conflict" {
		t.Fatalf("same-size distinct result accepted: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET result=NULL,state='paused',model_state='completed' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Report(ctx, input); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT result,state FROM operations_autonomy_tasks_v1 WHERE id=$1`, id).Scan(&result, &state); err != nil || result != nil || state != "paused" {
		t.Fatalf("paused result changed %#v %s %v", result, state, err)
	}
}

func TestAnalysisSourceUsesActualFactsAndOriginalReadScope(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, pool, nil); err != nil {
		t.Fatal(err)
	}
	endpoint, id, ai := "https://source-report.invalid", uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'overview','fixture','',true,1,1,now(),now())`, ai, endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,'overview','routine',$1::uuid::text,'fixture','ai','completed','completed','not-started',$3,'{}',1,1,$4,now(),now(),now())`, id, endpoint, ai, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	authority := &originalReadAuthority{}
	s := &Service{Pool: pool, Endpoint: endpoint, Authority: authority, QueryReadPermission: func(string, Object) (string, error) { return "analytics.read", nil }}
	actor := Actor{ID: "human", Endpoint: endpoint}
	row := Object{"id": id, "domain": "overview", "configuration": Object{}, "event_ids": []any{}}
	check := func(calls []Object) bool {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		return s.analysisSourcesAllowedWithin(ctx, tx, row, actor, calls)
	}
	report := syntheticInspectionReport()
	sections := obj(report["sections"])
	obj(sections["search"])["availability"] = "not-authorized"
	obj(sections["recommendations"])["availability"] = "not-authorized"
	calls := []Object{{"tool": "inspect-operations", "state": "completed", "read_outcome": Object{"inspectionReport": report}}}
	authority.denied = "analytics.read"
	if !check(calls) {
		t.Fatal("unread null analytics must not require its permission")
	}
	authority.denied = "feedback.read"
	if check(calls) {
		t.Fatal("read workbench feedback facts ignored current permission")
	}
	authority.denied = ""
	call := Object{"tool": "query-operations", "state": "completed", "arguments": Object{"module": "analytics", "view": "overview", "filters": Object{"days": 7}}}
	if !check([]Object{call}) {
		t.Fatal("bounded aggregate should not require profile")
	}
	authority.denied = "analytics.read"
	if check([]Object{call}) {
		t.Fatal("aggregate current permission ignored")
	}
	authority.denied = ""
	call["arguments"] = Object{"module": "feedback", "view": "list", "filters": Object{}}
	if check([]Object{call}) {
		t.Fatal("unverified material list was released")
	}
	op := uuid.NewString()
	writer := Object{"tool": "execute-operation", "state": "completed", "operation_id": op}
	if check([]Object{writer}) {
		t.Fatal("unrecorded writer evidence accepted")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO operations_autonomy_receipts_v1(id,endpoint,task_id,operation_id,action,state,basis,created_at) VALUES(gen_random_uuid(),$1,$2,$3,'fixture','unknown','original-operation-query',now())`, endpoint, id, op); err != nil {
		t.Fatal(err)
	}
	if !check([]Object{writer}) {
		t.Fatal("original writer receipt was treated as unverified material")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,'execute-operation','{}',$4,'completed',now(),now())`, endpoint, id, uuid.NewString(), op); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET result=$2 WHERE id=$1`, id, Object{"schemaVersion": 1, "analysis": Object{"state": "available", "basis": "native-run-final-content", "nativeRunId": "original", "text": "原回执未知", "recordedAt": "2026-10-29T00:00:00Z"}}); err != nil {
		t.Fatal(err)
	}
	value, err := s.GetTask(ctx, actor, id)
	if err != nil {
		t.Fatal(err)
	}
	analysis := obj(obj(value["task"])["finalAnalysis"])
	if analysis["state"] != "available" || analysis["text"] != "原回执未知" {
		t.Fatalf("original writer GET was withheld %#v", value)
	}
}
