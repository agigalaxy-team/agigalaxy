package operationsautonomy_test

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestInspectionOutcomeRecordedOnOriginalToolCall(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.NewEndpoint(t, pool, "https://profile-ledger.invalid")
	base := autonomyfixture.Setup(t, f, f.Automation(t))
	s := &a.Service{Pool: pool, Endpoint: f.Endpoint, Authority: f.Gateway, AIWork: &operationsai.Service{Endpoint: f.Endpoint}, Now: time.Now}
	id := uuid.NewString()
	if _, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (a.Object, error) {
		return s.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: id, Domain: "overview", AIAccountID: base["aiAccountId"].(string)})
	}); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',mode='ai',state='running',dispatch_started_at=now(),lease_until=now()+interval '10 minutes',native_run_id=NULL WHERE endpoint=$1 AND id=$2`, f.Endpoint, id); e != nil {
		t.Fatal(e)
	}
	s.QueryTool = func(context.Context, a.Actor, string, string, a.Object) (a.Object, error) {
		sections := a.Object{}
		for _, key := range []string{"workbench", "maintenance", "search", "recommendations", "analytics", "messaging", "autonomy", "delegation"} {
			sections[key] = a.Object{"availability": "available", "complete": true, "window": a.Object{}, "coverage": a.Object{}, "facts": a.Object{}, "findingCodes": []any{}}
		}
		sections["maintenance"].(map[string]any)["facts"] = a.Object{"componentTotal": 3, "private": "must-not-store"}
		return a.Object{"profile": "current-operations-v1", "availability": "partial", "inspectionChecked": false, "profileComplete": false, "segments": a.Object{"autonomy": a.Object{"availability": "available", "collectionComplete": false, "sourceWithheld": true, "data": a.Object{"private": "must-not-store"}}}, "inspectionReport": a.Object{"schemaVersion": 1, "profile": "current-operations-v1", "checkedAt": time.Now().Unix(), "profileComplete": false, "sections": sections}}, nil
	}
	call := uuid.NewString()
	if _, e := s.Tool(ctx, a.Object{"taskId": id, "callId": call, "tool": "inspect-operations", "arguments": a.Object{}}, false); e != nil {
		t.Fatal(e)
	}
	var code string
	var outcome a.Object
	if e := pool.QueryRow(ctx, `SELECT code,read_outcome FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, f.Endpoint, id, call).Scan(&code, &outcome); e != nil {
		t.Fatal(e)
	}
	segments, _ := outcome["segments"].(map[string]any)
	autonomy, _ := segments["autonomy"].(map[string]any)
	if code != "inspection-current-partial" || autonomy["reason"] != "source-withheld" || autonomy["data"] != nil {
		t.Fatalf("unsafe or missing outcome: %s %#v", code, outcome)
	}
	report, _ := outcome["inspectionReport"].(map[string]any)
	if report == nil || report["profileComplete"] != false {
		t.Fatalf("report not saved on original call %#v", outcome)
	}
	section := report["sections"].(map[string]any)["maintenance"].(map[string]any)
	if section["facts"].(map[string]any)["componentTotal"] != float64(3) || section["facts"].(map[string]any)["private"] != nil {
		t.Fatalf("unsafe report facts %#v", section)
	}
	view, e := s.GetTask(ctx, f.Root, id)
	if e != nil {
		t.Fatal(e)
	}
	task := view["task"].(map[string]any)
	visible, _ := task["inspectionReport"].(map[string]any)
	if visible == nil || visible["callId"] != call {
		t.Fatalf("task report missing original call %#v", task)
	}
}
