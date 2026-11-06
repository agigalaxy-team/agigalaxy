package operationsautonomy_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/publicationfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestCommunityAssessmentLifecyclePreservesOriginalFactsAndFencesLateCopies(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.NewEndpoint(t, owner, "https://assessment-lifecycle.example.invalid")
	automation := f.Automation(t)
	ai := automation["accounts"].(map[string]any)["discovery"].(string)
	publication := publicationfixture.Prepare(t, owner, f.Endpoint, f.Now)
	account := publication["accounts"].([]any)[0].(string)
	postID := publication["payload"].(map[string]any)["postId"].(string)
	s := &a.Service{Pool: f.Pool, Endpoint: f.Endpoint, AIWork: f.Permissions.AIWork, Now: f.Now}
	encode := func(value any) string { raw, _ := json.Marshal(value); return string(raw) }
	exec := func(query string, args ...any) {
		t.Helper()
		if _, e := f.Pool.Exec(ctx, query, args...); e != nil {
			t.Fatal(e)
		}
	}
	var role string
	if e := f.Pool.QueryRow(ctx, "SELECT current_user").Scan(&role); e != nil || role != "galaxy_api" {
		t.Fatalf("actual API role required: %q %v", role, e)
	}
	communityTask, unrelatedTask := uuid.NewString(), uuid.NewString()
	attempt := uuid.NewString()
	const originalRun = "native-lifecycle-original"
	const sourceText = "待最小化的原来源派生正文"
	const unrelatedText = "另一个原交办的正文应保持"
	for _, id := range []string{communityTask, unrelatedTask} {
		if _, e := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (a.Object, error) {
			return s.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: id, Domain: "discovery", AIAccountID: ai})
		}); e != nil {
			t.Fatal(e)
		}
	}
	failure := a.Object{"stage": "model-request", "category": "timeout", "reportedStatus": nil}
	usage := a.Object{"calls": 2, "inputTokens": 40, "outputTokens": 8, "totalTokens": 48, "durationMs": 100}
	result := a.Object{"schemaVersion": 1, "analysis": a.Object{"state": "available", "basis": "native-run-final-content", "nativeRunId": originalRun, "text": sourceText}, "failure": failure, "failureNativeRunId": originalRun}
	bound := a.Object{"taskId": communityTask, "accountId": account, "domain": "technology", "purpose": "evaluation-reference", "inputRevision": 1, "configVersion": 1}
	exec(`UPDATE operations_autonomy_tasks_v1 SET source='event',mode='ai',state='failed',model_state='completed',business_state='failed',code='operations_autonomy_original_receipt_failed',
		native_run_id=$3,native_attempt_id=$4,dispatch_started_at=$5,summary=$6,result=$7,primary_model_usage=$8,model_usage=$8,
		configuration=jsonb_set(configuration,'{communityAssessment}',$9::jsonb,true) WHERE endpoint=$1 AND id=$2`, f.Endpoint, communityTask, originalRun, attempt, f.Now(), sourceText, encode(result), encode(usage), encode(bound))
	exec(`UPDATE operations_autonomy_tasks_v1 SET source='event',mode='ai',state='failed',model_state='completed',business_state='failed',summary=$3,
		result=jsonb_build_object('analysis',jsonb_build_object('state','available','text',$3::text)) WHERE endpoint=$1 AND id=$2`, f.Endpoint, unrelatedTask, unrelatedText)
	// The normal assessment/manifest foreign keys establish the exact owner of
	// these copies; the unrelated event task deliberately shares its domain.
	exec(`INSERT INTO community_assessment_tasks_v1(endpoint,id,account_id,domain,purpose,input_revision,config_version,configuration,native_task_id,state,created_at,updated_at)
		VALUES($1,$2,$3,'technology','evaluation-reference',1,1,'{}',$2,'saved',$4,$4)`, f.Endpoint, communityTask, account, f.Now())
	exec(`INSERT INTO community_assessment_materials_v1(endpoint,task_id,source_key,source_kind,source_id,source_revision,snapshot,read_version,read_at)
		VALUES($1,$2,'source-coordinate','post',$3,1,$4,'source-version',$5)`, f.Endpoint, communityTask, postID, encode(a.Object{"accountId": account, "objectKind": "post", "objectId": postID, "title": sourceText}), f.Now())
	callIDs, operations := []string{}, []string{}
	arguments := []a.Object{
		{"limit": 20, "after": "source-cursor", "oldCopiedBody": sourceText},
		{"accountId": account, "domain": "technology", "purpose": "evaluation-reference", "inputRevision": 1, "configVersion": 1, "status": "assessed", "value": 0.5, "coverage": "partial", "reason": sourceText, "missing": []string{sourceText}, "evidence": []any{}},
		{"scope": "execution", "goalSatisfied": false, "summary": sourceText, "remainingWork": []any{a.Object{"kind": "read", "description": sourceText}}, "deferredWork": []string{sourceText}},
	}
	tools := []string{"read-community-assessment-material", "save-community-assessment-result", "assess-task"}
	for i, tool := range tools {
		call, operation := uuid.NewString(), uuid.NewString()
		callIDs, operations = append(callIDs, call), append(operations, operation)
		exec(`INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,code,native_run_id,native_attempt_id,created_at,updated_at)
			VALUES($1,$2,$3,$4,$5,$6,'unknown','operations_autonomy_original_receipt_unknown',$7,$8,$9,$9)`, f.Endpoint, communityTask, call, tool, encode(arguments[i]), operation, originalRun, attempt, f.Now())
	}
	command := uuid.NewString()
	commandResult := a.Object{"operationId": command, "task": a.Object{"id": communityTask, "state": "failed", "code": "operations_autonomy_original_receipt_failed", "summary": sourceText, "assessmentSummary": sourceText, "finalAnalysis": a.Object{"state": "available", "text": sourceText}, "failure": failure}}
	exec(`INSERT INTO operations_autonomy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,'control',$4,$5,$6)`, f.Endpoint, command, f.Root.ID, encode(a.Object{"kind": "reconcile", "id": communityTask, "humanReason": "保留原人工请求"}), encode(commandResult), f.Now())
	readJSON := func(query string, args ...any) a.Object {
		t.Helper()
		var out a.Object
		if e := f.Pool.QueryRow(ctx, query, args...).Scan(&out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	metadataQuery := `SELECT jsonb_build_object('id',id,'state',state,'modelState',model_state,'businessState',business_state,'code',code,'nativeRunId',native_run_id,
		'nativeAttemptId',native_attempt_id,'sessionId',session_id,'failure',result->'failure','failureNativeRunId',result->'failureNativeRunId','modelUsage',model_usage,'primaryModelUsage',primary_model_usage)
		FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`
	before := readJSON(metadataQuery, f.Endpoint, communityTask)
	unrelatedBefore := readJSON(`SELECT to_jsonb(t) FROM operations_autonomy_tasks_v1 t WHERE endpoint=$1 AND id=$2`, f.Endpoint, unrelatedTask)
	if _, e := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (a.Object, error) {
		return s.MinimizeCommunityAssessmentTasksWithin(ctx, tx, []string{communityTask, unrelatedTask})
	}); e != nil {
		t.Fatal(e)
	}
	assertCopies := func() {
		t.Helper()
		after := readJSON(metadataQuery, f.Endpoint, communityTask)
		if encode(after) != encode(before) {
			t.Fatalf("source minimization changed original state/failure/run/usage: before=%s after=%s", encode(before), encode(after))
		}
		row := readJSON(`SELECT jsonb_build_object('summary',summary,'analysis',result->'analysis','configuration',configuration) FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, communityTask)
		if row["summary"] != nil || row["analysis"].(map[string]any)["state"] != "withheld" || strings.Contains(encode(row), sourceText) {
			t.Fatalf("original task still contains derived text: %s", encode(row))
		}
		for i, call := range callIDs {
			row := readJSON(`SELECT jsonb_build_object('operationId',operation_id,'callId',call_id,'state',state,'code',code,'runId',native_run_id,'attemptId',native_attempt_id,'arguments',arguments,'readOutcome',read_outcome) FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, f.Endpoint, communityTask, call)
			if row["operationId"] != operations[i] || row["callId"] != call || row["state"] != "unknown" || row["code"] != "operations_autonomy_original_receipt_unknown" || row["runId"] != originalRun || row["attemptId"] != attempt || strings.Contains(encode(row), sourceText) {
				t.Fatalf("tool projection lost original audit or retained text: %s", encode(row))
			}
		}
		row = readJSON(`SELECT result FROM operations_autonomy_commands_v1 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, command)
		if strings.Contains(encode(row), sourceText) || row["operationId"] != command || row["task"].(map[string]any)["state"] != "failed" {
			t.Fatalf("original control receipt text/state changed incorrectly: %s", encode(row))
		}
		other := readJSON(`SELECT to_jsonb(t) FROM operations_autonomy_tasks_v1 t WHERE endpoint=$1 AND id=$2`, f.Endpoint, unrelatedTask)
		if encode(other) != encode(unrelatedBefore) {
			t.Fatal("an unrelated event task in the same domain was modified")
		}
	}
	assertCopies()
	// Exercise the installed SQL triggers as the actual API role, without
	// invoking a mock projection or rebuilding the trigger in this test.
	exec(`UPDATE operations_autonomy_tool_calls_v1 SET arguments=$4 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, f.Endpoint, communityTask, callIDs[1], encode(arguments[1]))
	exec(`UPDATE operations_autonomy_tasks_v1 SET summary=$3,result=jsonb_set(result,'{analysis}',jsonb_build_object('state','available','text',$3::text)) WHERE endpoint=$1 AND id=$2`, f.Endpoint, communityTask, sourceText)
	exec(`UPDATE operations_autonomy_commands_v1 SET result=$3 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, command, encode(commandResult))
	lateCall, lateOperation := uuid.NewString(), uuid.NewString()
	exec(`INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,code,native_run_id,native_attempt_id,created_at,updated_at)
		VALUES($1,$2,$3,'assess-task',$4,$5,'completed','task-assessment-current',$6,$7,$8,$8)`, f.Endpoint, communityTask, lateCall,
		encode(a.Object{"scope": "execution", "goalSatisfied": true, "summary": sourceText, "remainingWork": []any{}, "deferredWork": []string{sourceText}}), lateOperation, originalRun, attempt, f.Now())
	late := readJSON(`SELECT jsonb_build_object('operationId',operation_id,'state',state,'arguments',arguments) FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, f.Endpoint, communityTask, lateCall)
	if late["operationId"] != lateOperation || late["state"] != "completed" || strings.Contains(encode(late), sourceText) || late["arguments"].(map[string]any)["goalSatisfied"] != true {
		t.Fatalf("late assessment could not retain its real completion metadata safely: %s", encode(late))
	}
	_, e := s.Report(ctx, a.Object{"taskId": communityTask, "nativeRunId": originalRun, "nativeAttemptId": attempt, "status": "completed", "modelState": "completed", "finalAnalysis": a.Object{"state": "available", "text": sourceText}})
	if fault.Code(e) != "operations_autonomy_operation_conflict" {
		t.Fatalf("late original-run prose was not refused by its existing minimized result: %v", e)
	}
	assertCopies()
}
