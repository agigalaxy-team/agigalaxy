package operationsautonomy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type originalReadAuthority struct {
	perms.Authority
	denied string
}

func (a *originalReadAuthority) AuthorizeOperations(_ *http.Request, _ bool, action string) (Actor, error) {
	return a.RequireWithin(context.Background(), nil, Actor{ID: "human", Endpoint: "https://original-receipt.invalid"}, action)
}
func (a *originalReadAuthority) RequireWithin(_ context.Context, _ pgx.Tx, actor Actor, action string) (Actor, error) {
	if action == a.denied {
		return Actor{}, fault.New("operations_permission_denied", 403)
	}
	return actor, nil
}

func TestOriginalAIReceiptTaskBindingAndCurrentPermission(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, pool, nil); e != nil {
		t.Fatal(e)
	}
	endpoint := "https://original-receipt.invalid"
	task, other, ai, otherAI, call, op, target := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, e := pool.Exec(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	exec(`INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'overview','one','',true,1,1,now(),now()),($3,$2,'governance','two','',true,1,1,now(),now())`, ai, endpoint, otherAI)
	for _, id := range []string{task, other} {
		exec(`INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,'overview','routine',$1::uuid::text,'fixture','ai','unknown','failed','unknown',$3,'{}',1,1,$4,now(),now(),now())`, id, endpoint, ai, uuid.NewString())
	}
	args := `{"kind":"feedback-update","targetId":"` + target + `","state":"processing"}`
	proposal := `{"kind":"feedback-update","domain":"overview","target":{"kind":"feedback","id":"` + target + `"},"request":` + args + `,"command":{"expectedRevision":1,"state":"processing"}}`
	exec(`INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,'execute-operation',$4::jsonb,$5,'unknown',now(),now())`, endpoint, task, call, args, op)
	exec(`INSERT INTO operations_ai_duty_operations_v1(operation_id,endpoint,task_id,ai_account_id,kind,request,proposal,binding,state,created_at,updated_at) VALUES($1,$2,$3,$4,'feedback-update',$5::jsonb,$6::jsonb,jsonb_build_object('operation',jsonb_build_object('targetId',$7::text,'permission','feedback.update')),'unknown',now(),now())`, op, endpoint, task, ai, args, proposal, target)
	authority := &originalReadAuthority{}
	count := 0
	s := &Service{Pool: pool, Endpoint: endpoint, Authority: authority, ReadTargetWithin: func(context.Context, pgx.Tx, Actor, string, string, string) (Object, error) {
		return Object{"availability": "available"}, nil
	}, OriginalAIReceiptWithin: func(_ context.Context, _ pgx.Tx, _ Actor, src businessadmin.OriginalAIReceiptSource) (Object, error) {
		count++
		if src.TaskID != task || src.AIAccountID != ai || src.CallID != call || src.OperationID != op || src.Request["targetId"] != target || src.Command["expectedRevision"] != float64(1) {
			t.Fatalf("incorrect frozen source %#v", src)
		}
		return Object{"state": "recorded", "operationId": op, "action": "feedback.update", "targetType": "feedback", "targetId": target, "version": 2, "metadataOnly": true, "recordedAt": "2026-10-29T12:00:00Z"}, nil
	}}
	actor := Actor{ID: "human", Endpoint: endpoint}
	result, e := s.OriginalAIReceipt(ctx, actor, task, op)
	if e != nil || obj(result["receipt"])["state"] != "recorded" || count != 1 {
		t.Fatalf("original read: %v %v", result, e)
	}
	if _, e = s.OriginalAIReceipt(ctx, actor, other, op); fault.Status(e) != 404 {
		t.Fatalf("cross-task: %v", e)
	}
	authority.denied = "feedback.read"
	if _, e = s.OriginalAIReceipt(ctx, actor, task, op); fault.Status(e) != 403 {
		t.Fatalf("current feedback permission: %v", e)
	}
	authority.denied = "autonomy.read"
	if _, e = s.OriginalAIReceipt(ctx, actor, task, op); fault.Status(e) != 403 {
		t.Fatalf("current task permission: %v", e)
	}
	authority.denied = ""
	exec(`UPDATE operations_ai_duty_operations_v1 SET ai_account_id=$3 WHERE endpoint=$1 AND operation_id=$2`, endpoint, op, otherAI)
	if _, e = s.OriginalAIReceipt(ctx, actor, task, op); fault.Status(e) != 404 {
		t.Fatalf("wrong AI: %v", e)
	}
	req := httptest.NewRequest("GET", "https://original-receipt.invalid/v1/operations/autonomy/tasks/"+task+"/operations/"+op, nil)
	rr := httptest.NewRecorder()
	Handler{Service: s}.ServeHTTP(rr, req)
	if rr.Code != 404 {
		t.Fatalf("route bypassed binding: %d", rr.Code)
	}
}
