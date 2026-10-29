package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"testing"
)

func TestInspectionOutcomePreservesOnlyFixedIncompleteSegments(t *testing.T) {
	segments := Object{}
	for _, key := range []string{"workbench", "maintenance", "search", "recommendations", "analytics", "messaging", "autonomy", "delegation"} {
		segments[key] = Object{"availability": "available", "collectionComplete": true, "data": Object{"private": "do-not-store"}}
	}
	obj(segments["recommendations"])["profileComplete"] = true
	obj(segments["recommendations"])["supplySample"] = Object{"collectionComplete": false}
	obj(segments["autonomy"])["collectionComplete"] = false
	obj(segments["autonomy"])["sourceWithheld"] = true
	out := inspectionOutcome(Object{"profile": "current-operations-v1", "inspectionChecked": false, "profileComplete": false, "segments": segments})
	if out["profileComplete"] != false || obj(obj(out["segments"])["autonomy"])["reason"] != "source-withheld" || obj(obj(out["segments"])["recommendations"])["reason"] != "complete" {
		t.Fatalf("incorrect fixed coverage: %v", out)
	}
	if obj(obj(out["segments"])["autonomy"])["data"] != nil {
		t.Fatal("stored source body")
	}
}

func TestInspectionProfileUsesOnlyActualCoverageAndPreservesUnknown(t *testing.T) {
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
	endpoint, task := "https://profile.invalid", uuid.NewString()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at,effective_check) VALUES($1::uuid,$2,'overview','routine',$1::uuid::text,'fixture','ai','running','running','not-started','{"plan":{"inspectionProfile":"current-operations-v1","actions":[],"grantIds":[],"strategyIds":[],"resourceIds":[],"eventTypes":[]}}',1,1,$3,now(),now(),now(),true)`, task, endpoint, uuid.NewString())
	add := func(tool, state, code, args string) string {
		id := uuid.NewString()
		exec(`INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,code,created_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,now(),now())`, endpoint, task, id, tool, args, uuid.NewString(), state, code)
		return id
	}
	assessment := add("assess-task", "completed", "task-assessment-current", `{"goalSatisfied":true,"remainingWork":[],"summary":"checked"}`)
	partial := add("inspect-operations", "completed", "inspection-current-partial", `{}`)
	exec(`UPDATE operations_autonomy_tool_calls_v1 SET read_outcome='{"profile":"current-operations-v1","profileComplete":false,"segments":{"autonomy":{"availability":"available","profileComplete":false,"reason":"source-withheld"}}}'::jsonb WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, endpoint, task, partial)
	add("query-operations", "failed", "read-unavailable", `{"module":"audit","view":"list","filters":{}}`)
	s := &Service{Endpoint: endpoint}
	get := func() Object {
		row, e := s.taskWithin(ctx, tx, task, "")
		if e != nil {
			t.Fatal(e)
		}
		out, e := s.completionWithin(ctx, tx, row, true)
		if e != nil {
			t.Fatal(e)
		}
		return out
	}
	result := get()
	if result["disposition"] != "continue" {
		t.Fatalf("partial accepted: %v", result)
	}
	coverage := obj(result["readCoverage"])
	unresolved := coverage["unresolved"].([]Object)
	if len(unresolved) != 1 || obj(unresolved[0]["inspectionOutcome"])["profileComplete"] != false {
		t.Fatalf("missing actual segment metadata: %v", coverage)
	}
	if len(coverage["incidentalReadFailures"].([]Object)) != 1 {
		t.Fatalf("unrelated read not visible: %v", coverage)
	}
	exec(`UPDATE operations_autonomy_tool_calls_v1 SET code='inspection-current-complete' WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, endpoint, task, partial)
	result = get()
	if result["disposition"] != "completed" {
		t.Fatalf("complete profile should not require unrelated audit: %v", result)
	}
	exec(`UPDATE operations_autonomy_tool_calls_v1 SET code='task-assessment-stale' WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, endpoint, task, assessment)
	result = get()
	if result["disposition"] != "continue" || result["reasonCode"] != "task-assessment-required" {
		t.Fatalf("missing latest assessment: %v", result)
	}
	exec(`UPDATE operations_autonomy_tool_calls_v1 SET code='task-assessment-current' WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, endpoint, task, assessment)
	add("execute-operation", "unknown", "", `{}`)
	result = get()
	if result["disposition"] != "unknown" || result["businessState"] != "unknown" {
		t.Fatalf("unknown effect bypassed: %v", result)
	}
}

func TestInspectionProfileRequiresPureModelPlan(t *testing.T) {
	base := Object{"operationId": uuid.NewString(), "expectedRevision": 1, "enabled": false, "mode": "ai", "schedule": Object{"kind": "interval", "minutes": 30}, "purpose": "inspection", "goal": "check", "prompt": "", "plan": Object{"inspectionProfile": "current-operations-v1"}}
	for _, mode := range []string{"ai", "ai-human", "code", "human-ai"} {
		input := obj(clone(base))
		input["mode"] = mode
		_, err := parseConfiguration(input)
		if (err == nil) != (mode == "ai" || mode == "ai-human") {
			t.Fatalf("mode %s: %v", mode, err)
		}
	}
	for _, key := range []string{"actions", "grantIds", "strategyIds", "resourceIds", "eventTypes"} {
		input := obj(clone(base))
		value := "read"
		if key == "grantIds" || key == "strategyIds" || key == "resourceIds" {
			value = uuid.NewString()
		}
		obj(input["plan"])[key] = []any{value}
		if _, err := parseConfiguration(input); err == nil {
			t.Fatalf("profile accepted %s", key)
		}
	}
	input := obj(clone(base))
	obj(input["plan"])["inspectionProfile"] = "unknown-profile"
	if _, err := parseConfiguration(input); err == nil {
		t.Fatal("accepted unknown profile")
	}
}
