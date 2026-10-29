package operationsautonomy

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

// Exercise the real migrated tables and each source family, including a
// workbench card whose turn is linked to a different autonomy task id.
func TestBatchedTaskSourcesMatchIndividualChecks(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	if _, err := databaseschema.Migrate(ctx, pool, nil); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	endpoint := "https://sources.example.invalid"
	execSQL := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	task1, task2, task3, empty := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, id := range []string{task1, task2, task3, empty} {
		execSQL(`INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1::uuid,$2,'overview','routine',$1::uuid::text,'fixture','code','queued','not-started','not-started','{}',1,1,$3,now(),now(),now())`, id, endpoint, uuid.NewString())
	}
	execSQL(`INSERT INTO operations_autonomy_receipts_v1(id,endpoint,task_id,operation_id,action,target_type,target_id,state,basis,details,created_at) VALUES($1,$2,$3,$4,'read','content-post','receipt-post','completed','fixture','{"items":[{"kind":"reply","id":"receipt-reply"}]}',now())`, uuid.NewString(), endpoint, task1, uuid.NewString())
	ai := uuid.NewString()
	execSQL(`INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'overview','fixture','',true,1,1,now(),now())`, ai, endpoint)
	execSQL(`INSERT INTO operations_ai_duty_operations_v1(operation_id,endpoint,task_id,ai_account_id,kind,request,proposal,binding,state,created_at,updated_at) VALUES($1,$2,$3,$4,'single','{}','{"target":{"kind":"post","id":"duty-post"}}','{}','prepared',now(),now()),($5,$2,$3,$4,'public-content-batch','{"items":[{"kind":"post","id":"duty-batch-post"}]}','{}','{}','prepared',now(),now())`, uuid.NewString(), endpoint, task2, ai, uuid.NewString())
	conversation, turn, tool := uuid.NewString(), uuid.NewString(), uuid.NewString()
	execSQL(`INSERT INTO operations_agentos_conversations_v1(id,endpoint,operator_id,domain,permission_key,session_id,created_at) VALUES($1,$2,'fixture','overview','workbench.read',$3,now())`, conversation, endpoint, uuid.NewString())
	execSQL(`INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,'fixture','digest','accepted','{}',now())`, turn, endpoint, conversation)
	execSQL(`INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,'run','call','prepare-operation','digest','completed',now(),now())`, tool, endpoint, conversation, turn)
	execSQL(`INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'fixture','overview',$6,'digest','{"kind":"public-content-batch","request":{"items":[{"kind":"reply","id":"card-batch-reply"}]}}','prepared',now(),now())`, uuid.NewString(), endpoint, conversation, turn, tool, uuid.NewString())
	tool2 := uuid.NewString()
	execSQL(`INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,'run','call-2','prepare-operation','digest','completed',now(),now())`, tool2, endpoint, conversation, turn)
	execSQL(`INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'fixture','overview',$6,'digest-2','{"kind":"single","target":{"kind":"post","id":"card-post"}}','prepared',now(),now())`, uuid.NewString(), endpoint, conversation, turn, tool2, uuid.NewString())
	execSQL(`INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,model_state,state,created_at,updated_at) VALUES($1,$2,$3,'completed','completed',now(),now())`, endpoint, task3, turn)
	execSQL(`INSERT INTO operations_autonomy_receipts_v1(id,endpoint,task_id,operation_id,action,target_type,target_id,state,basis,details,created_at) VALUES($1,'https://other.invalid',$2,$3,'read','content-post','wrong-endpoint','completed','fixture','{}',now())`, uuid.NewString(), task1, uuid.NewString())
	service := &Service{Endpoint: endpoint}
	ids := []string{task1, task2, task3, empty}
	batch, err := service.taskSourceRefsForTasksWithin(ctx, tx, ids)
	if err != nil {
		t.Fatal(err)
	}
	normalize := func(refs []Object) map[string]bool {
		values := map[string]bool{}
		for _, r := range refs {
			values[str(r["target_type"])+":"+str(r["target_id"])] = true
		}
		return values
	}
	expected := map[string]map[string]bool{
		task1: {"content-post:receipt-post": true, "content-reply:receipt-reply": true},
		task2: {"content-post:duty-post": true, "content-post:duty-batch-post": true},
		task3: {"content-reply:card-batch-reply": true, "content-post:card-post": true}, empty: {},
	}
	for _, id := range ids {
		single, err := service.TaskSourceRefsWithin(ctx, tx, id)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(normalize(single), expected[id]) || !reflect.DeepEqual(normalize(batch[id]), expected[id]) {
			t.Fatalf("source mismatch for %s: single=%v batch=%v", id, normalize(single), normalize(batch[id]))
		}
		row := Object{"id": id, "domain": "overview"}
		previous := service.checkTargetWithin(ctx, tx, Actor{}, row, true)
		prefetched := service.checkTargetWithRefsWithin(ctx, tx, Actor{}, row, batch[id])
		if (previous == nil) != (prefetched == nil) || previous != nil && (fault.Code(previous) != fault.Code(prefetched) || fault.Status(previous) != fault.Status(prefetched)) {
			t.Fatalf("source authority changed for %s: %v / %v", id, previous, prefetched)
		}
	}
	if missing, err := service.taskSourceRefsForTasksWithin(ctx, tx, nil); err != nil || len(missing) != 0 {
		t.Fatalf("empty batch: %v %v", missing, err)
	}
}
