package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
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
	proof := Object{"sourceProofVersion": 1, "complete": true, "material": "present", "refs": []any{Object{"kind": "feedback", "id": "item"}}}
	call["read_outcome"] = proof
	if check([]Object{call}) {
		t.Fatal("new evidence was released before external revalidation")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	verified := context.WithValue(ctx, sourceProofContextKey{}, id)
	if !s.analysisSourcesAllowedWithin(verified, tx, row, actor, []Object{call}) {
		t.Fatal("valid fresh proof should allow an ordinary query scope")
	}
	proof["complete"] = false
	if s.analysisSourcesAllowedWithin(verified, tx, row, actor, []Object{call}) {
		t.Fatal("incomplete proof released")
	}
	_ = tx.Rollback(ctx)
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

func TestTaskReportFinalizerRevalidatesOutsideTransaction(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := databaseschema.Migrate(ctx, owner, nil); err != nil {
		t.Fatal(err)
	}
	config := owner.Config().Copy()
	config.MaxConns = 1
	config.MinConns = 0
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	endpoint, id, ai, callID := "https://report-finalizer-"+uuid.NewString()+".invalid", uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err = pool.Exec(ctx, `INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'overview','fixture','',true,1,1,now(),now())`, ai, endpoint); err != nil {
		t.Fatal(err)
	}
	analysis := Object{"schemaVersion": 1, "analysis": Object{"state": "available", "basis": "native-run-final-content", "nativeRunId": "original", "text": "当前分析", "recordedAt": "2026-10-29T00:00:00Z"}}
	if _, err = pool.Exec(ctx, `INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at,result) VALUES($1,$2,'overview','routine',$1::uuid::text,'fixture','ai','completed','completed','not-started',$3,'{}',1,1,$4,now(),now(),now(),$5)`, id, endpoint, ai, uuid.NewString(), analysis); err != nil {
		t.Fatal(err)
	}
	args := Object{"module": "feedback", "view": "list", "filters": Object{}}
	ref := Object{"kind": "feedback", "id": "item", "version": 1, "controlledSource": true, "purpose": "feedback-processing", "read": Object{"tool": "read-operation-object", "arguments": Object{"kind": "feedback", "id": "item", "filters": Object{}}}}
	proof := Object{"sourceProofVersion": 1, "complete": true, "material": "present", "refs": []any{ref}}
	if _, err = pool.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at,read_outcome) VALUES($1,$2,$3,'query-operations',$4,$5,'completed',now(),now(),$6)`, endpoint, id, callID, args, uuid.NewString(), proof); err != nil {
		t.Fatal(err)
	}
	authority := &originalReadAuthority{}
	service := &Service{Pool: pool, Endpoint: endpoint, Authority: authority, QueryReadPermission: func(string, Object) (string, error) { return "feedback.read", nil }}
	actor := Actor{ID: "human", Endpoint: endpoint}
	mode, calls, selected := "valid", 0, 0
	service.RevalidateReadSources = func(ctx context.Context, got Actor, domain string, refs []Object) (Object, error) {
		calls++
		var one int
		if err := pool.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil {
			return nil, err
		}
		selected += one
		if got.ID != actor.ID || domain != "overview" || len(refs) != 1 || refs[0]["id"] != "item" {
			t.Fatalf("unexpected callback input: %#v %q %#v", got, domain, refs)
		}
		switch mode {
		case "source-changed":
			return Object{"valid": false, "refs": []any{}}, nil
		case "permission-revoked":
			authority.denied = "feedback.read"
		case "call-changed":
			if _, err := pool.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET state='failed',updated_at=now() WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, endpoint, id, callID); err != nil {
				return nil, err
			}
		}
		return Object{"valid": true, "refs": []any{ref}}, nil
	}
	check := func(list bool, want string) {
		t.Helper()
		before := calls
		var value Object
		var err error
		if list {
			value, err = service.Tasks(ctx, actor, Object{})
			if err == nil {
				items, ok := value["items"].([]Object)
				if !ok || len(items) != 1 {
					t.Fatalf("unexpected items: %#v", value)
				}
				value = items[0]
			}
		} else {
			value, err = service.GetTask(ctx, actor, id)
			if err == nil {
				value = obj(value["task"])
			}
		}
		if err != nil {
			t.Fatal(err)
		}
		if got := obj(value["finalAnalysis"])["state"]; got != want {
			t.Fatalf("%s: expected %s, got %#v", mode, want, value)
		}
		if calls != before+1 || selected != calls {
			t.Fatalf("callback or single-connection SELECT failed: calls=%d before=%d selects=%d", calls, before, selected)
		}
	}
	check(false, "available")
	check(true, "available")
	mode = "source-changed"
	check(false, "withheld")
	mode = "permission-revoked"
	check(false, "withheld")
	authority.denied = ""
	mode = "call-changed"
	check(true, "withheld")
	if _, err = pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET result=NULL WHERE endpoint=$1 AND id=$2`, endpoint, id); err != nil {
		t.Fatal(err)
	}
	before := calls
	if _, err = service.GetTask(ctx, actor, id); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Tasks(ctx, actor, Object{}); err != nil {
		t.Fatal(err)
	}
	if calls != before {
		t.Fatalf("callback called without analysis: %d -> %d", before, calls)
	}
}
