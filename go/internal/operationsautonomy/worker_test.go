package operationsautonomy_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWorkerOriginalDispatchFenceAndNativeReceiptRecovery(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	encode := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	f := operationsfixture.NewEndpoint(t, owner, "https://autonomy.example.invalid")
	automation := f.Automation(t)
	base := autonomyfixture.Setup(t, f, automation)
	endpoint, accountID := f.Endpoint, base["aiAccountId"].(string)
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(2000000000, 0) }
	s := &a.Service{Pool: pool, Endpoint: endpoint, AIWork: &operationsai.Service{Endpoint: endpoint}, Now: now}
	id := uuid.NewString()
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (a.Object, error) {
		return s.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: id, Domain: "overview", AIAccountID: accountID})
	}); e != nil {
		t.Fatal(e)
	}
	admin, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer admin.Close()
	if _, e = admin.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e = admin.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',mode='ai',state='queued',native_run_id=NULL,dispatch_started_at=NULL,model_state='not-started',configuration=jsonb_set(configuration,'{mode}','"ai"') WHERE endpoint=$1 AND id=$2`, endpoint, id); e != nil {
		t.Fatal(e)
	}
	var mu sync.Mutex
	posts, gets := 0, 0
	nativeState := "RUNNING"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == "POST" {
			posts++
			if r.Header.Get("Idempotency-Key") != id {
				t.Error("dispatch replaced original task operation")
			}
			c, _, e := w.(http.Hijacker).Hijack()
			if e == nil {
				c.Close()
			}
			return
		}
		gets++
		w.Header().Set("Content-Type", "application/json")
		model := "running"
		if nativeState == "COMPLETED" {
			model = "completed"
		}
		json.NewEncoder(w).Encode(a.Object{"nativeRunId": "original-native-run", "status": nativeState, "modelState": model, "continuable": false})
	}))
	defer server.Close()
	client, e := agentos.New(agentos.Configuration{URL: server.URL, SigningKey: strings.Repeat("s", 32), ServiceKey: strings.Repeat("v", 32)}, agentos.Options{Now: now})
	if e != nil {
		t.Fatal(e)
	}
	s.Native = &a.NativeClient{Client: client}
	worker := a.NewWorker(s)
	result, e := worker.Execute(ctx, a.Object{"taskId": id})
	if e != nil || result["state"] != "unknown" {
		t.Fatalf("lost ACK %s %v", encode(result), e)
	}
	var dispatched bool
	var state string
	if e = pool.QueryRow(ctx, `SELECT dispatch_started_at IS NOT NULL,state FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, endpoint, id).Scan(&dispatched, &state); e != nil || !dispatched || state != "unknown" {
		t.Fatalf("dispatch fence %v %s %v", dispatched, state, e)
	}
	result, e = worker.Execute(ctx, a.Object{"taskId": id})
	if e != nil || result["state"] != "running" {
		t.Fatalf("original GET recovery %s %v", encode(result), e)
	}
	mu.Lock()
	nativeState = "COMPLETED"
	mu.Unlock()
	original, e := worker.Execute(ctx, a.Object{"taskId": id})
	if e != nil {
		t.Fatal(e)
	}
	if original["state"] != "unknown" {
		t.Fatalf("model ended claimed inspection complete %s", encode(original))
	}
	result, e = worker.Execute(ctx, a.Object{"taskId": id})
	if e != nil || result["state"] != "unknown" {
		t.Fatalf("original incomplete replay %s %v", encode(result), e)
	}
	mu.Lock()
	p, g := posts, gets
	mu.Unlock()
	if p != 1 || g != 3 {
		t.Fatalf("native dispatch history POST%d GET%d", p, g)
	}
	var effective bool
	var business, code string
	if e = pool.QueryRow(ctx, `SELECT effective_check,business_state,code FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, endpoint, id).Scan(&effective, &business, &code); e != nil || effective || business != "not-started" || code != "task-assessment-required" {
		t.Fatalf("business completion evidence %v %s %s %v", effective, business, code, e)
	}
}

func TestReportRequiresCurrentAssessmentAndOriginalWriteOutcome(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.NewEndpoint(t, pool, "https://completion.example.invalid")
	base := autonomyfixture.Setup(t, f, f.Automation(t))
	s := &a.Service{Pool: pool, Endpoint: f.Endpoint, AIWork: &operationsai.Service{Endpoint: f.Endpoint}, Now: time.Now}
	id := uuid.NewString()
	if _, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (a.Object, error) {
		return s.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: id, Domain: "overview", AIAccountID: base["aiAccountId"].(string)})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',mode='ai',state='running',dispatch_started_at=now(),effective_check=true WHERE endpoint=$1 AND id=$2`, f.Endpoint, id); err != nil {
		t.Fatal(err)
	}
	assessment, call, operation := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,code,created_at,updated_at) VALUES($1,$2,$3,'assess-task','{"goalSatisfied":true,"remainingWork":[],"summary":"checked"}',$4,'completed','task-assessment-current',now(),now()),($1,$2,$5,'execute-operation','{}',$6,'unknown',NULL,now(),now())`, f.Endpoint, id, assessment, uuid.NewString(), call, operation); err != nil {
		t.Fatal(err)
	}
	report := func() a.Object {
		t.Helper()
		out, err := s.Report(ctx, a.Object{"taskId": id, "status": "completed", "modelState": "completed"})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	if got := report(); got["state"] != "unknown" || got["businessState"] != "unknown" {
		t.Fatalf("unknown writer: %#v", got)
	}
	if _, err := pool.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET state='completed' WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, f.Endpoint, id, call); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO operations_autonomy_receipts_v1(id,endpoint,task_id,operation_id,action,state,basis,created_at) VALUES(gen_random_uuid(),$1,$2,$3,'test','failed','original-operation-query',now())`, f.Endpoint, id, operation); err != nil {
		t.Fatal(err)
	}
	if got := report(); got["state"] != "failed" || got["businessState"] != "failed" {
		t.Fatalf("failed receipt: %#v", got)
	}
}

func TestAssessmentBecomesStaleAfterBusinessTool(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.NewEndpoint(t, pool, "https://assessment.example.invalid")
	base := autonomyfixture.Setup(t, f, f.Automation(t))
	s := &a.Service{Pool: pool, Endpoint: f.Endpoint, AIWork: &operationsai.Service{Endpoint: f.Endpoint}, Now: time.Now}
	id := uuid.NewString()
	if _, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (a.Object, error) {
		return s.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: id, Domain: "overview", AIAccountID: base["aiAccountId"].(string)})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',mode='ai',state='running',dispatch_started_at=now(),lease_until=now()+interval '10 minutes',native_run_id=NULL WHERE endpoint=$1 AND id=$2`, f.Endpoint, id); err != nil {
		t.Fatal(err)
	}
	assessment := uuid.NewString()
	if _, err := s.Tool(ctx, a.Object{"taskId": id, "callId": assessment, "tool": "assess-task", "arguments": a.Object{"goalSatisfied": true, "remainingWork": []any{}, "summary": "checked"}}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Tool(ctx, a.Object{"taskId": id, "callId": uuid.NewString(), "tool": "current-summary", "arguments": a.Object{}}, false); err != nil {
		t.Fatal(err)
	}
	var code string
	if err := pool.QueryRow(ctx, `SELECT code FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, f.Endpoint, id, assessment).Scan(&code); err != nil || code != "task-assessment-stale" {
		t.Fatalf("assessment code %q: %v", code, err)
	}
}

func TestUnsentRecoveryRequiresOriginalReadAndExplicitControl(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.NewEndpoint(t, pool, "https://unsent.example.invalid")
	base := autonomyfixture.Setup(t, f, f.Automation(t))
	s := &a.Service{Pool: pool, Endpoint: f.Endpoint, AIWork: &operationsai.Service{Endpoint: f.Endpoint}, Now: time.Now}
	id := uuid.NewString()
	if _, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (a.Object, error) {
		return s.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: id, Domain: "overview", AIAccountID: base["aiAccountId"].(string)})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',mode='ai',state='unknown',native_run_id=NULL,dispatch_started_at=now(),code='operations_agentos_not_configured' WHERE endpoint=$1 AND id=$2`, f.Endpoint, id); err != nil {
		t.Fatal(err)
	}
	var posts, gets int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" {
			posts++
			if r.Header.Get("Idempotency-Key") != id {
				t.Error("original task ID changed")
			}
			json.NewEncoder(w).Encode(a.Object{"nativeRunId": "native-original", "modelState": "running", "status": "RUNNING"})
			return
		}
		gets++
		if posts == 0 {
			json.NewEncoder(w).Encode(a.Object{"status": "NOT_RECORDED"})
		} else {
			json.NewEncoder(w).Encode(a.Object{"status": "RUNNING", "nativeRunId": "native-original", "modelState": "running"})
		}
	}))
	defer server.Close()
	client, err := agentos.New(agentos.Configuration{URL: server.URL, SigningKey: strings.Repeat("s", 32), ServiceKey: strings.Repeat("v", 32)}, agentos.Options{})
	if err != nil {
		t.Fatal(err)
	}
	s.Native = &a.NativeClient{Client: client}
	worker := a.NewWorker(s)
	if _, err = worker.Execute(ctx, a.Object{"taskId": id}); err != nil || posts != 0 {
		t.Fatalf("without human control: POST=%d %v", posts, err)
	}
	cmd := uuid.NewString()
	if _, err = pool.Exec(ctx, `INSERT INTO operations_autonomy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,'test','control',$3,$4,now())`, f.Endpoint, cmd, a.Object{"kind": "reconcile", "id": id}, a.Object{"task": a.Object{"id": id, "state": "unknown", "code": "operations_agentos_not_configured", "revision": 1}}); err != nil {
		t.Fatal(err)
	}
	if _, err = worker.Execute(ctx, a.Object{"taskId": id}); err != nil || posts != 1 {
		t.Fatalf("original recovery: POST=%d %v", posts, err)
	}
	if _, err = worker.Execute(ctx, a.Object{"taskId": id}); err != nil || posts != 1 || gets != 3 {
		t.Fatalf("original reconcile POST=%d GET=%d %v", posts, gets, err)
	}
}
