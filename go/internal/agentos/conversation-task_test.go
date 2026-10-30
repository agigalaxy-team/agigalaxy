package agentos

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestConversationTaskCheckpointRootAndPending(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	f.Delegated(t)
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	row := *current.Row
	root, child := uuid.NewString(), uuid.NewString()
	insert := func(id string, result Object) {
		t.Helper()
		_, e := owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,native_run_id,result,created_at) VALUES($1,$2,$3,$4,$5,'accepted',$1::uuid::text,$6,$7)`, id, f.Endpoint, row.ID, row.OperatorID, strings.Repeat("a", 64), result, f.Now())
		if e != nil {
			t.Fatal(e)
		}
	}
	insert(root, Object{"runId": root, "taskProgress": defaultConversationTask(root, root)})
	tools := &ConversationTools{Conversations: s}
	bound := boundConversationTool{row: row, actor: f.Root, callID: uuid.NewString(), args: Object{"disposition": "completed", "reason": "尚有工作", "remaining": []any{"核对后续"}}}
	result, err := tools.assessConversationTask(ctx, bound, root)
	if err != nil || result["state"] != "needs-continuation" || object(result["taskProgress"])["phase"] != "continue" {
		t.Fatal("remaining cannot complete", result, err)
	}
	again, err := tools.assessConversationTask(ctx, bound, root)
	firstRevision, _ := index(object(result["taskProgress"])["revision"])
	againRevision, _ := index(object(again["taskProgress"])["revision"])
	if err != nil || againRevision != firstRevision {
		t.Fatal("same call must be idempotent", again, err)
	}
	call, card, op := uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,$4::uuid::text,$1::uuid::text,'prepare-operation',$5,'completed',$6,$6)`, call, f.Endpoint, row.ID, root, strings.Repeat("b", 64), f.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'overview',$7,$8,'{}','prepared',$9,$9)`, card, f.Endpoint, row.ID, root, call, row.OperatorID, op, strings.Repeat("c", 64), f.Now())
	if err != nil {
		t.Fatal(err)
	}
	bound.callID = uuid.NewString()
	bound.args = Object{"disposition": "completed", "reason": "模型认为完成", "remaining": []any{}}
	result, err = tools.assessConversationTask(ctx, bound, root)
	if err != nil || result["state"] != "needs-continuation" || object(result["taskProgress"])["phase"] != "waiting-confirmation" {
		t.Fatal("prepared card must block completion", result, err)
	}
	_, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_cards_v1 SET state='not-available',result='{ "state":"cancelled" }'::jsonb WHERE id=$1`, card)
	if err != nil {
		t.Fatal(err)
	}
	projected, err := s.conversationTaskProgress(ctx, row, root)
	if err != nil || projected["phase"] != "needs-information" {
		t.Fatal("cancelled options need a new decision", projected, err)
	}
	_, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_cards_v1 SET state='unknown' WHERE id=$1`, card)
	if err != nil {
		t.Fatal(err)
	}
	bound.callID = uuid.NewString()
	result, err = tools.assessConversationTask(ctx, bound, root)
	if err != nil || object(result["taskProgress"])["phase"] != "waiting-result" {
		t.Fatal("unknown result must block completion", result, err)
	}
	_, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET result=jsonb_set(result,'{taskProgress,phase}','"continue"'::jsonb) WHERE id=$1`, root)
	if err != nil {
		t.Fatal(err)
	}
	projectedRuns, err := s.decorateRuns(ctx, row, []Object{{"operationId": root, "runId": root, "status": "ERROR"}})
	if err != nil || object(projectedRuns[0]["taskProgress"])["phase"] != "waiting-result" {
		t.Fatal("unknown business result must remain waiting", projectedRuns, err)
	}
	bound.callID = uuid.NewString()
	bound.args["disposition"] = "interrupted"
	result, err = tools.assessConversationTask(ctx, bound, root)
	if err != nil || object(result["taskProgress"])["phase"] != "interrupted" {
		t.Fatal("interruption must survive outstanding card", result, err)
	}
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/operations/"+root) {
			http.Error(w, "unexpected", 404)
			return
		}
		_ = json.NewEncoder(w).Encode(Object{"conversationId": row.ID, "sessionId": row.SessionID, "operationId": root, "runId": root, "state": "COMPLETED", "native": Object{"runId": root, "operationId": root, "status": "COMPLETED", "userInput": "原始业务目标", "events": []any{}}})
	}))
	defer native.Close()
	s.Client, err = New(Configuration{URL: native.URL, SigningKey: strings.Repeat("s", 32)}, Options{Now: f.Now})
	if err != nil {
		t.Fatal(err)
	}
	insert(child, Object{"runId": child, "origin": "operation-feedback", "parentOperationId": root})
	_, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET result=jsonb_set(result,'{taskProgress,activeOperationId}',to_jsonb($2::text)) WHERE id=$1`, root, child)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET result=jsonb_set(result,'{taskProgress,phase}','"continue"'::jsonb) WHERE id=$1`, root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.decorateRuns(ctx, row, []Object{{"operationId": root, "runId": root, "status": "ERROR"}})
	if err != nil {
		t.Fatal(err)
	}
	var persisted Object
	if err = owner.QueryRow(ctx, `SELECT result->'taskProgress' FROM operations_agentos_conversation_commands_v1 WHERE id=$1`, root).Scan(&persisted); err != nil || persisted["phase"] != "continue" {
		t.Fatal("old native error overwrote active feedback", persisted, err)
	}
	_, taskContext, err := s.conversationTaskContext(ctx, row, child)
	if err != nil || taskContext["rootOperationId"] != root || taskContext["objective"] != "原始业务目标" || taskContext["objectiveAvailable"] != true {
		t.Fatal("feedback loses original objective", taskContext, err)
	}
	bound.callID = uuid.NewString()
	if _, err = tools.assessConversationTask(ctx, bound, root); err == nil {
		t.Fatal("old step cannot overwrite newer checkpoint")
	}
	prepareCalls := 0
	tools.Prepare = func(_ context.Context, _ operationspermissions.Actor, _ Conversation, args Object, _ string) (Object, error) {
		prepareCalls++
		return Object{"kind": "fixture", "request": args}, nil
	}
	blocked := boundConversationTool{row: row, actor: f.Root, callID: uuid.NewString(), args: Object{"candidate": "new"}}
	if _, e := tools.prepareCard(ctx, blocked, Object{"turnId": child}); fault.Code(e) != "operations_agentos_task_result_pending" {
		t.Fatal("unknown original allowed a new card", e)
	}
	var cardCount int
	if e := owner.QueryRow(ctx, `SELECT count(*) FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND conversation_id=$2`, f.Endpoint, row.ID).Scan(&cardCount); e != nil || cardCount != 1 || prepareCalls != 0 {
		t.Fatal("unknown original caused another card", cardCount, e)
	}
	bound.callID = uuid.NewString()
	bound.args = Object{"disposition": "continue", "reason": "继续原目标", "remaining": []any{"下一步"}}
	result, err = tools.assessConversationTask(ctx, bound, child)
	if err != nil || object(result["taskProgress"])["rootOperationId"] != root {
		t.Fatal("feedback must update original root", result, err)
	}
	_, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_cards_v1 SET state='not-available',result='{ "state":"failed" }'::jsonb WHERE id=$1`, card)
	if err != nil {
		t.Fatal(err)
	}
	bound.callID = uuid.NewString()
	bound.args = Object{"disposition": "completed", "reason": "后续已核对", "remaining": []any{}}
	result, err = tools.assessConversationTask(ctx, bound, child)
	if err != nil || result["state"] != "recorded" || object(result["taskProgress"])["phase"] != "completed" {
		t.Fatal("historical failed card must remain recorded but not block a new assessment", result, err)
	}
	_, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET result=jsonb_set(result,'{taskProgress,phase}','"continue"'::jsonb) WHERE id=$1`, root)
	if err != nil {
		t.Fatal(err)
	}
	projectedRuns, err = s.decorateRuns(ctx, row, []Object{{"operationId": child, "runId": child, "status": "CANCELLED"}})
	if err != nil || object(projectedRuns[0]["taskProgress"])["phase"] != "interrupted" {
		t.Fatal("current cancellation must interrupt task", projectedRuns, err)
	}
	toolInput := Object{"conversationId": row.ID, "sessionId": row.SessionID, "turnId": child, "runId": child, "callId": "runtime:task-timeout:" + child, "tool": "assess-conversation-task", "arguments": Object{"disposition": "interrupted", "reason": "私有检查点原因", "remaining": []any{"私有未完成事项"}}}
	result, err = tools.Execute(ctx, toolInput)
	if err != nil || object(result["taskProgress"])["phase"] != "interrupted" {
		t.Fatal("bound runtime checkpoint failed", result, err)
	}
	var metadata Object
	if e := owner.QueryRow(ctx, `SELECT metadata FROM operations_agentos_conversation_tool_calls_v1 WHERE endpoint=$1 AND turn_id=$2 AND call_id=$3`, f.Endpoint, child, toolInput["callId"]).Scan(&metadata); e != nil {
		t.Fatal(e)
	}
	encoded, _ := json.Marshal(metadata)
	if strings.Contains(string(encoded), "私有检查点原因") || strings.Contains(string(encoded), "私有未完成事项") {
		t.Fatal("private checkpoint prose leaked to tool metadata", metadata)
	}
	maximum := make([]any, 40)
	for i := range maximum {
		maximum[i] = strings.Repeat("事", 1000)
	}
	bound.callID = uuid.NewString()
	bound.args = Object{"disposition": "continue", "reason": "边界检查", "remaining": maximum}
	limited, err := tools.assessConversationTask(ctx, bound, child)
	if err != nil || len(object(limited["taskProgress"])["remaining"].([]any)) != 40 {
		t.Fatal("valid remaining limit was truncated", err)
	}
	for _, items := range [][]any{append(append([]any{}, maximum...), "超出"), {strings.Repeat("事", 1001)}} {
		bound.callID = uuid.NewString()
		bound.args["remaining"] = items
		if _, e := tools.assessConversationTask(ctx, bound, child); fault.Code(e) != "invalid_operations_agentos_request" {
			t.Fatal("oversized remaining accepted", e)
		}
	}
	other := row
	other.OperatorID = "other-owner"
	_, err = postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (string, error) {
		id, _, e := conversationTaskRootWithin(ctx, tx, f.Endpoint, other, child)
		return id, e
	})
	if err == nil {
		t.Fatal("cross-owner lineage accepted")
	}
}

func TestConversationTaskFeedbackUsesOriginalObjectiveOnce(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	f.Delegated(t)
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	row := *current.Row
	root, card, op, call := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	progress := defaultConversationTask(root, root)
	progress["remaining"] = []any{"继续核实下一项"}
	_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,native_run_id,result,created_at) VALUES($1,$2,$3,$4,$5,'accepted',$1::uuid::text,$6,$7)`, root, f.Endpoint, row.ID, row.OperatorID, strings.Repeat("a", 64), Object{"runId": root, "taskProgress": progress}, f.Now())
	if err != nil {
		t.Fatal(err)
	}
	cfg := Object{"externalWorkbench": Object{"conversationId": row.ID, "operatorId": row.OperatorID, "turnOperationId": root}}
	_, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_tasks_v1(id,endpoint,ai_account_id,domain,source,source_key,title,mode,state,model_state,business_state,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,$3,'overview','workbench',$1::uuid::text,'fixture','human-ai','completed','completed','none',$4,1,1,$5,$6,$6,$6)`, root, f.Endpoint, *row.AIAccountID, cfg, row.SessionID, f.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,native_run_id,model_state,state,created_at,updated_at) VALUES($1,$2,$2,$2::uuid::text,'completed','completed',$3,$3)`, f.Endpoint, root, f.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,$4::uuid::text,$1::uuid::text,'prepare-operation',$5,'completed',$6,$6)`, call, f.Endpoint, row.ID, root, strings.Repeat("b", 64), f.Now())
	if err != nil {
		t.Fatal(err)
	}
	proposal := Object{"kind": "fixture", "target": Object{"label": "对象"}, "title": "处理对象"}
	receipt := Object{"operationId": op, "state": "completed", "feedbackEnabled": true, "confirmationAttemptedAt": "fixture", "effectExecuted": true}
	_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,result,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'overview',$7,$8,$9,$10,'completed',$11,$11)`, card, f.Endpoint, row.ID, root, call, row.OperatorID, op, strings.Repeat("c", 64), proposal, receipt, f.Now())
	if err != nil {
		t.Fatal(err)
	}
	feedbackID := feedbackOperation(&conversationCard{OperationID: op})
	posts := 0
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/health" {
			_ = json.NewEncoder(w).Encode(Object{"framework": "agno", "version": "3.1.7", "state": "running", "model": "configured", "conversations": Object{"version": 2, "agentIds": []string{"galaxy-conversation-overview"}, "transport": Object{"originalRunLookup": 1}}})
			return
		}
		if r.Method == "POST" && r.URL.Path == "/agents/galaxy-conversation-overview/runs" {
			posts++
			_ = r.ParseForm()
			if r.Header.Get("Idempotency-Key") != feedbackID || r.Form.Get("message") != feedbackMessage || strings.Contains(r.Form.Get("message"), "原始业务目标") {
				t.Error("feedback did not use stable short message")
			}
			_ = json.NewEncoder(w).Encode(Object{"run_id": feedbackID})
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/galaxy/conversations/"+row.ID+"/operations/")
		if id != root && id != feedbackID {
			http.Error(w, "unexpected", 404)
			return
		}
		input := "原始业务目标"
		if id == feedbackID {
			input = feedbackMessage
		}
		_ = json.NewEncoder(w).Encode(Object{"conversationId": row.ID, "sessionId": row.SessionID, "operationId": id, "runId": id, "state": "COMPLETED", "native": Object{"runId": id, "operationId": id, "status": "COMPLETED", "userInput": input, "events": []any{}}})
	}))
	defer native.Close()
	s.Client, err = New(Configuration{URL: native.URL, SigningKey: strings.Repeat("s", 32)}, Options{Now: f.Now})
	if err != nil {
		t.Fatal(err)
	}
	tools := &ConversationTools{Conversations: s, CardReadPermission: func(string) (string, error) { return "workbench.read", nil }}
	s.Tools = tools
	authorize := func(context.Context) (operationspermissions.Actor, error) { return f.Root, nil }
	ack, err := tools.CardFeedback(ctx, f.Root, "overview", card, true, authorize)
	if err != nil || ack["operationId"] != feedbackID || posts != 1 {
		t.Fatal("feedback did not start once", ack, posts, err)
	}
	_, taskContext, err := s.conversationTaskContext(ctx, row, feedbackID)
	if err != nil || taskContext["objective"] != "原始业务目标" || taskContext["rootOperationId"] != root || len(taskContext["remaining"].([]any)) != 1 {
		t.Fatal("feedback lost original task", taskContext, err)
	}
	again, err := tools.CardFeedback(ctx, f.Root, "overview", card, true, authorize)
	if err != nil || again["operationId"] != feedbackID || posts != 1 {
		t.Fatal("feedback original was reissued", again, posts, err)
	}
}
