package operationsautonomy

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

func TestTagReceiptUsesRealRandomTargetAndCurrentPermission(t *testing.T) {
	op, tag, other := uuid.NewString(), uuid.NewString(), uuid.NewString()
	card := func(kind, targetKind string, target any, state string, receiptID string) Object {
		return Object{"operation_id": op, "state": state, "proposal": Object{"kind": kind, "target": Object{"kind": targetKind, "id": target}}, "result": Object{"operationId": op, "state": state, "receipt": Object{"tagId": receiptID}}}
	}
	created := WorkbenchCardFact(card("content-tag-create", "tag-creation", nil, "completed", tag))
	r := obj(created["businessReceipt"])
	if r["targetType"] != "content-tag" || r["targetId"] != tag || r["targetId"] == op {
		t.Fatalf("random target lost: %v", r)
	}
	unknown := WorkbenchCardFact(card("content-tag-create", "tag-creation", nil, "unknown", ""))
	r = obj(unknown["businessReceipt"])
	if r["state"] != "unknown" || r["targetType"] != nil || r["targetId"] != nil {
		t.Fatalf("unknown ID fabricated: %v", r)
	}
	if WorkbenchCardFact(card("content-tag-create", "tag-creation", op, "completed", tag)) != nil {
		t.Fatal("create accepted fabricated proposal target")
	}
	if WorkbenchCardFact(card("content-tag-update", "content-tag", tag, "completed", other)) != nil {
		t.Fatal("update accepted another receipt target")
	}
	a := &noticeAuthority{}
	s := &Service{Endpoint: "fixture", Authority: a}
	row := Object{"target_type": "content-tag", "target_id": tag}
	if e := s.checkTargetWithin(context.Background(), nil, Actor{Endpoint: "fixture"}, row, false); fault.Status(e) != 403 || a.action != "content.tags.read" {
		t.Fatalf("permission: %v %s", e, a.action)
	}
	a.allowed = true
	if e := s.checkTargetWithin(context.Background(), nil, Actor{Endpoint: "fixture"}, row, false); e != nil {
		t.Fatal(e)
	}
	a.allowed = false
	if e := s.checkTargetWithin(context.Background(), nil, Actor{Endpoint: "fixture"}, row, false); fault.Status(e) != 403 {
		t.Fatalf("revoke ignored: %v", e)
	}
}

func TestTagUnknownOriginalReceiptPromotesOnlyFromBoundCard(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, pool, nil); e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		name              string
		badOwner, wrongID bool
	}{{"exact", false, false}, {"wrong-owner", true, false}, {"wrong-id", false, true}} {
		t.Run(tc.name, func(t *testing.T) {
			tx, e := pool.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback(ctx)
			exec := func(q string, args ...any) {
				t.Helper()
				if _, err := tx.Exec(ctx, q, args...); err != nil {
					t.Fatal(err)
				}
			}
			endpoint, task, turn, conversation, session, ai, operator, tool, op, tag := "https://tag-source.invalid", uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			exec(`INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'overview','fixture','',true,1,1,now(),now())`, ai, endpoint)
			exec(`INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,'overview','workbench',$1::uuid::text,'fixture','human-ai','running','completed','not-started',$3,jsonb_build_object('externalWorkbench',jsonb_build_object('turnOperationId',$4::text,'operatorId',$5::text,'conversationId',$6::text,'sessionId',$7::text)),1,1,$8,now(),now(),now())`, task, endpoint, ai, turn, operator, conversation, session, uuid.NewString())
			exec(`INSERT INTO operations_agentos_conversations_v1(id,endpoint,operator_id,domain,permission_key,session_id,ai_account_id,created_at) VALUES($1,$2,$3,'overview','workbench.read',$4,$5,now())`, conversation, endpoint, operator, session, ai)
			exec(`INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,'digest','accepted','{}',now())`, turn, endpoint, conversation, operator)
			exec(`INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,model_state,state,created_at,updated_at) VALUES($1,$2,$3,'completed','completed',now(),now())`, endpoint, task, turn)
			exec(`INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,'run','call','prepare-operation','digest','completed',now(),now())`, tool, endpoint, conversation, turn)
			exec(`INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'overview',$7,'digest','{"kind":"content-tag-create","target":{"kind":"tag-creation"}}','unknown',jsonb_build_object('operationId',$7::uuid::text,'state','unknown'),now(),now())`, uuid.NewString(), endpoint, conversation, turn, tool, operator, op)
			service := &Service{Endpoint: endpoint}
			status := "unknown"
			r := &BusinessReceipt{OperationID: op, Action: "content-tag-create", State: "unknown", Basis: "workbench-original-domain-receipt"}
			row, e := service.UpdateWorkbenchWithin(ctx, tx, WorkbenchUpdate{OperationID: task, TurnOperationID: &turn, Status: &status, Receipt: r})
			if e != nil || row["business_state"] != "unknown" {
				t.Fatalf("unknown lost %v %v", row, e)
			}
			if tc.badOwner {
				exec(`UPDATE operations_agentos_conversation_cards_v1 SET operator_id=$3 WHERE endpoint=$1 AND operation_id=$2`, endpoint, op, uuid.NewString())
			}
			exec(`UPDATE operations_agentos_conversation_cards_v1 SET state='completed',result=jsonb_build_object('operationId',$2::uuid::text,'state','completed','receipt',jsonb_build_object('tagId',$3::uuid::text)) WHERE endpoint=$1 AND operation_id=$2`, endpoint, op, tag)
			projectedID := tag
			if tc.wrongID {
				projectedID = uuid.NewString()
			}
			typ := "content-tag"
			r = &BusinessReceipt{OperationID: op, Action: "content-tag-create", State: "completed", Basis: "workbench-original-domain-receipt", TargetType: &typ, TargetID: &projectedID}
			status = "completed"
			row, e = service.UpdateWorkbenchWithin(ctx, tx, WorkbenchUpdate{OperationID: task, TurnOperationID: &turn, Status: &status, Receipt: r})
			if tc.badOwner || tc.wrongID {
				if fault.Code(e) != "operations_autonomy_operation_conflict" {
					t.Fatalf("forgery accepted: %v %v", row, e)
				}
				return
			}
			if e != nil || row["business_state"] != "completed" {
				t.Fatalf("original promotion failed: %v %v", row, e)
			}
			var got string
			if e = tx.QueryRow(ctx, `SELECT target_id FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3`, endpoint, task, op).Scan(&got); e != nil || got != tag {
				t.Fatalf("wrong random tag ID %s: %v", got, e)
			}
		})
	}
}

func TestCleanupUnknownOriginalReceiptPromotesOnlyFromBoundCard(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, pool, nil); e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		name              string
		badOwner, wrongID bool
	}{{"exact", false, false}, {"wrong-owner", true, false}, {"wrong-id", false, true}} {
		t.Run(tc.name, func(t *testing.T) {
			tx, e := pool.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback(ctx)
			exec := func(q string, args ...any) {
				t.Helper()
				if _, err := tx.Exec(ctx, q, args...); err != nil {
					t.Fatal(err)
				}
			}
			endpoint, task, turn, conversation, session, ai, operator, tool, op, tag := "https://tag-source.invalid", uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			exec(`INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'overview','fixture','',true,1,1,now(),now())`, ai, endpoint)
			exec(`INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,'overview','workbench',$1::uuid::text,'fixture','human-ai','running','completed','not-started',$3,jsonb_build_object('externalWorkbench',jsonb_build_object('turnOperationId',$4::text,'operatorId',$5::text,'conversationId',$6::text,'sessionId',$7::text)),1,1,$8,now(),now(),now())`, task, endpoint, ai, turn, operator, conversation, session, uuid.NewString())
			exec(`INSERT INTO operations_agentos_conversations_v1(id,endpoint,operator_id,domain,permission_key,session_id,ai_account_id,created_at) VALUES($1,$2,$3,'overview','workbench.read',$4,$5,now())`, conversation, endpoint, operator, session, ai)
			exec(`INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,'digest','accepted','{}',now())`, turn, endpoint, conversation, operator)
			exec(`INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,model_state,state,created_at,updated_at) VALUES($1,$2,$3,'completed','completed',now(),now())`, endpoint, task, turn)
			exec(`INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,'run','call','prepare-operation','digest','completed',now(),now())`, tool, endpoint, conversation, turn)
			exec(`INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'overview',$7,'digest','{"kind":"file-cleanup-plan-create","target":{"kind":"file-cleanup-creation"}}','unknown',jsonb_build_object('operationId',$7::uuid::text,'state','unknown'),now(),now())`, uuid.NewString(), endpoint, conversation, turn, tool, operator, op)
			service := &Service{Endpoint: endpoint}
			status := "unknown"
			r := &BusinessReceipt{OperationID: op, Action: "file-cleanup-plan-create", State: "unknown", Basis: "workbench-original-domain-receipt"}
			row, e := service.UpdateWorkbenchWithin(ctx, tx, WorkbenchUpdate{OperationID: task, TurnOperationID: &turn, Status: &status, Receipt: r})
			if e != nil || row["business_state"] != "unknown" {
				t.Fatalf("unknown lost %v %v", row, e)
			}
			if tc.badOwner {
				exec(`UPDATE operations_agentos_conversation_cards_v1 SET operator_id=$3 WHERE endpoint=$1 AND operation_id=$2`, endpoint, op, uuid.NewString())
			}
			exec(`UPDATE operations_agentos_conversation_cards_v1 SET state='completed',result=jsonb_build_object('operationId',$2::uuid::text,'state','completed','receipt',jsonb_build_object('planId',$3::uuid::text)) WHERE endpoint=$1 AND operation_id=$2`, endpoint, op, tag)
			projectedID := tag
			if tc.wrongID {
				projectedID = uuid.NewString()
			}
			typ := "file-cleanup-plan"
			r = &BusinessReceipt{OperationID: op, Action: "file-cleanup-plan-create", State: "completed", Basis: "workbench-original-domain-receipt", TargetType: &typ, TargetID: &projectedID}
			status = "completed"
			row, e = service.UpdateWorkbenchWithin(ctx, tx, WorkbenchUpdate{OperationID: task, TurnOperationID: &turn, Status: &status, Receipt: r})
			if tc.badOwner || tc.wrongID {
				if fault.Code(e) != "operations_autonomy_operation_conflict" {
					t.Fatalf("forgery accepted: %v %v", row, e)
				}
				return
			}
			if e != nil || row["business_state"] != "completed" {
				t.Fatalf("original promotion failed: %v %v", row, e)
			}
			var got string
			if e = tx.QueryRow(ctx, `SELECT target_id FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3`, endpoint, task, op).Scan(&got); e != nil || got != tag {
				t.Fatalf("wrong random plan ID %s: %v", got, e)
			}
		})
	}
}

func TestCleanupReceiptUsesOriginalRandomPlan(t *testing.T) {
	op, plan, other := uuid.NewString(), uuid.NewString(), uuid.NewString()
	card := func(kind, targetKind string, target any, state string, receiptID string) Object {
		return Object{"operation_id": op, "state": state, "proposal": Object{"kind": kind, "target": Object{"kind": targetKind, "id": target}}, "result": Object{"operationId": op, "state": state, "receipt": Object{"planId": receiptID, "stateAtOperation": "awaiting-approval"}}}
	}
	fact := WorkbenchCardFact(card("file-cleanup-plan-create", "file-cleanup-creation", nil, "completed", plan))
	receipt := obj(fact["businessReceipt"])
	if receipt["targetType"] != "file-cleanup-plan" || receipt["targetId"] != plan || receipt["targetId"] == op || receipt["details"] != nil {
		t.Fatalf("random plan lost or history overclaimed: %v", receipt)
	}
	fact = WorkbenchCardFact(card("file-cleanup-plan-create", "file-cleanup-creation", nil, "unknown", ""))
	receipt = obj(fact["businessReceipt"])
	if receipt["state"] != "unknown" || receipt["targetId"] != nil || receipt["targetType"] != nil {
		t.Fatalf("unknown plan fabricated: %v", receipt)
	}
	if WorkbenchCardFact(card("file-cleanup-plan-create", "file-cleanup-creation", op, "completed", plan)) != nil {
		t.Fatal("create accepted invented target")
	}
	if WorkbenchCardFact(card("file-cleanup-plan-cancel", "file-cleanup-plan", plan, "completed", other)) != nil {
		t.Fatal("cancel accepted another plan")
	}
}
