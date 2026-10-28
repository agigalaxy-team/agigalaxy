package operationsautonomy_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWorkerOriginalDispatchFenceAndNativeReceiptRecovery(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	encode := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	node := func(mode string, input a.Object) a.Object {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/operations-autonomy-interop.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		if input != nil {
			cmd.Stdin = strings.NewReader(encode(input))
		}
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original worker %s %v %s", mode, e, out)
		}
		var o a.Object
		if json.Unmarshal(out, &o) != nil {
			t.Fatal("invalid original worker result")
		}
		return o
	}
	base := node("setup", nil)
	endpoint, accountID := base["endpoint"].(string), base["aiAccountId"].(string)
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
	original := node("worker-execute", a.Object{"taskId": id, "origin": server.URL})
	if original["state"] != "waiting-human" {
		t.Fatalf("model ended claimed inspection complete %s", encode(original))
	}
	result, e = worker.Execute(ctx, a.Object{"taskId": id})
	if e != nil || result["state"] != "waiting-human" {
		t.Fatalf("waiting human replay %s %v", encode(result), e)
	}
	mu.Lock()
	p, g := posts, gets
	mu.Unlock()
	if p != 1 || g != 2 {
		t.Fatalf("native dispatch history POST%d GET%d", p, g)
	}
	var effective bool
	var business, code string
	if e = pool.QueryRow(ctx, `SELECT effective_check,business_state,code FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, endpoint, id).Scan(&effective, &business, &code); e != nil || effective || business != "not-started" || code != "effective-check-required" {
		t.Fatalf("business completion evidence %v %s %s %v", effective, business, code, e)
	}
}
