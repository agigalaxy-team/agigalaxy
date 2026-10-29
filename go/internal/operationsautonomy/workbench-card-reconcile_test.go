package operationsautonomy

import (
	"context"
	"fmt"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

func TestWorkbenchCardStateReconciliation(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, pool, nil); e != nil {
		t.Fatal(e)
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	endpoint := "https://card-reconcile.invalid"
	exec := func(q string, args ...any) {
		t.Helper()
		if _, e := tx.Exec(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	ai := uuid.NewString()
	exec(`INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'overview','fixture','',true,1,1,now(),now())`, ai, endpoint)
	for _, tc := range []struct {
		name    string
		cards   []string
		receipt bool
		want    string
	}{
		{"failed", []string{"not-available"}, false, "failed"},
		{"other-card-pending", []string{"not-available", "prepared"}, false, "waiting-human"},
		{"unknown-writer", []string{"not-available", "unknown"}, false, "unknown"},
		{"partial-failure", []string{"not-available", "completed"}, false, "failed"},
		{"unknown-receipt", []string{"not-available"}, true, "unknown"},
		{"cancelled", []string{"cancelled"}, false, "stopped"},
		{"binding-invalid", []string{"not-available"}, false, "unknown"},
		{"external-decision", []string{"not-available"}, false, "waiting-human"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exec := func(q string, args ...any) {
				t.Helper()
				if _, err := tx.Exec(ctx, q, args...); err != nil {
					t.Fatal(err)
				}
			}
			task, conversation, turn, operator := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			exec(`INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,'overview','workbench',$1::uuid::text,'fixture','human-ai','waiting-human','completed','not-started',$5,jsonb_build_object('externalWorkbench',jsonb_build_object('turnOperationId',$4::text,'operatorId',$6::text)),1,1,$3,now(),now(),now())`, task, endpoint, uuid.NewString(), turn, ai, operator)
			exec(`INSERT INTO operations_agentos_conversations_v1(id,endpoint,operator_id,domain,permission_key,session_id,ai_account_id,created_at) VALUES($1,$2,$4,'overview','workbench.read',$3,$5,now())`, conversation, endpoint, uuid.NewString(), operator, ai)
			exec(`INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,'digest','accepted','{}',now())`, turn, endpoint, conversation, operator)
			exec(`INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,model_state,state,created_at,updated_at) VALUES($1,$2,$3,'completed','completed',now(),now())`, endpoint, task, turn)
			for i, state := range tc.cards {
				tool, card := uuid.NewString(), uuid.NewString()
				result := "{}"
				if state == "cancelled" {
					state = "not-available"
					result = `{"state":"cancelled"}`
				}
				exec(`INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,'run',$5,'prepare-operation','digest','completed',now(),now())`, tool, endpoint, conversation, turn, fmt.Sprint(i))
				exec(`INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$10,'overview',$6,$7,'{}',$8,$9::jsonb,now(),now())`, card, endpoint, conversation, turn, tool, uuid.NewString(), fmt.Sprint(i), state, result, operator)
			}
			if tc.name == "external-decision" {
				exec(`INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,'fixture','{}',$4,'waiting-human',now(),now())`, endpoint, task, uuid.NewString(), uuid.NewString())
			}
			if tc.name == "binding-invalid" {
				exec(`UPDATE operations_agentos_conversation_cards_v1 SET operator_id=$3 WHERE endpoint=$1 AND turn_id=$2`, endpoint, turn, uuid.NewString())
			}
			if tc.receipt {
				exec(`INSERT INTO operations_autonomy_receipts_v1(id,endpoint,task_id,operation_id,action,state,basis,created_at) VALUES($1,$2,$3,$4,'fixture','unknown','fixture',now())`, uuid.NewString(), endpoint, task, uuid.NewString())
			}
			service := &Service{Endpoint: endpoint}
			status, model := "completed", "completed"
			for i := 0; i < 2; i++ {
				row, e := service.UpdateWorkbenchWithin(ctx, tx, WorkbenchUpdate{OperationID: task, TurnOperationID: &turn, Status: &status, ModelState: &model})
				if e != nil {
					t.Fatal(e)
				}
				if row["state"] != tc.want {
					t.Fatalf("state=%v want=%v", row["state"], tc.want)
				}
				if !tc.receipt && row["business_state"] != "not-started" {
					t.Fatalf("invented receipt: %v", row)
				}
				if tc.name == "failed" && row["code"] != "operations_autonomy_card_confirmation_unavailable" {
					t.Fatalf("missing failure code: %v", row)
				}
			}
		})
	}
}
