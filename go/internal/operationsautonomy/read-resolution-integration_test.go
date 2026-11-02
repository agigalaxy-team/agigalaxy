package operationsautonomy

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

func TestSelectedResolutionOriginalLedgerCompletionPG(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, pool, nil); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	endpoint, task, selected := "https://selected-resolution.invalid", uuid.NewString(), uuid.NewString()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	config, _ := json.Marshal(Object{"plan": Object{"resourceIds": []any{selected}}})
	exec(`INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at,effective_check) VALUES($1,$2,'maintenance','routine',$1::uuid::text,'fixture','ai','running','running','not-started',$3::jsonb,1,1,$4,now(),now(),now(),true)`, task, endpoint, config, uuid.NewString())
	add := func(tool, state, code string, args Object, seconds int) string {
		id := uuid.NewString()
		raw, _ := json.Marshal(args)
		exec(`INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,code,created_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,now()+$9*interval '1 second',now()+$9*interval '1 second')`, endpoint, task, id, tool, raw, uuid.NewString(), state, code, seconds)
		return id
	}
	_ = add("inspect-operations", "completed", "inspection-current-partial", Object{}, 1)
	_ = add("query-operations", "failed", "read-unavailable", Object{"module": "jobs", "view": "list", "filters": Object{}}, 2)
	_ = add("read-operation-object", "completed", "read-success-complete", Object{"kind": "forum-file", "id": selected}, 3)
	_ = add("assess-task", "completed", "task-assessment-current", Object{"goalSatisfied": true, "remainingWork": []any{}, "summary": "checked"}, 4)
	s := &Service{Endpoint: endpoint}
	get := func() Object {
		t.Helper()
		row, e := s.taskWithin(ctx, tx, task, "")
		if e != nil {
			t.Fatal(e)
		}
		result, e := s.completionWithin(ctx, tx, row, true)
		if e != nil {
			t.Fatal(e)
		}
		return result
	}
	if value := get(); value["disposition"] != "completed" {
		t.Fatalf("failed and partial reads must remain recorded without blocking final response: %#v", value)
	}
	add("execute-operation", "unknown", "", Object{}, 5)
	if value := get(); value["disposition"] != "unknown" {
		t.Fatalf("unknown writer bypassed: %#v", value)
	}
}
