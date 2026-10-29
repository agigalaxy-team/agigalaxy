package agentos

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestConversationAdmissionConcurrentPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	f.Delegated(t)
	ctx := context.Background()
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/health" {
			_ = json.NewEncoder(w).Encode(Object{"framework": "agno", "version": "3.1.7", "state": "running", "model": "configured", "conversations": Object{"version": 2, "agentIds": []string{"galaxy-conversation-overview", "galaxy-conversation-governance"}, "transport": Object{"originalRunLookup": 1}}})
			return
		}
		if r.Method == "POST" && (r.URL.Path == "/agents/galaxy-conversation-overview/runs" || r.URL.Path == "/agents/galaxy-conversation-governance/runs") {
			calls.Add(1)
			_ = json.NewEncoder(w).Encode(Object{"run_id": r.Header.Get("Idempotency-Key")})
			return
		}
		if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/galaxy/conversations/"+current.Row.ID+"/operations/") {
			id := strings.TrimPrefix(r.URL.Path, "/galaxy/conversations/"+current.Row.ID+"/operations/")
			_ = json.NewEncoder(w).Encode(Object{"conversationId": current.Row.ID, "sessionId": current.Row.SessionID, "operationId": id, "runId": id, "state": "RUNNING", "native": Object{"runId": id, "operationId": id, "status": "RUNNING"}})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	s.Client, err = New(Configuration{URL: server.URL, SigningKey: strings.Repeat("s", 32), ServiceKey: strings.Repeat("k", 32)}, Options{Now: f.Now})
	if err != nil {
		t.Fatal(err)
	}
	authorize := func(context.Context) (operationspermissions.Actor, error) { return f.Root, nil }
	ids := []string{uuid.NewString(), uuid.NewString()}
	results := make([]error, 2)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, results[i] = s.Run(ctx, f.Root, "overview", Object{"operationId": ids[i], "message": "test"}, authorize)
		}(i)
	}
	close(start)
	wg.Wait()
	winner := -1
	for i, e := range results {
		if e == nil {
			winner = i
		} else if fault.Code(e) != "operations_agentos_conversation_busy" {
			t.Fatalf("admission %d: %v", i, e)
		}
	}
	if winner < 0 || calls.Load() != 1 {
		t.Fatalf("winner=%d calls=%d errors=%v", winner, calls.Load(), results)
	}
	loser := 1 - winner
	var n int
	if err = owner.QueryRow(ctx, `SELECT count(*) FROM operations_agentos_conversation_commands_v1 WHERE id=$1`, ids[loser]).Scan(&n); err != nil || n != 0 {
		t.Fatalf("blocked row=%d err=%v", n, err)
	}
	input, _ := json.Marshal(Object{"operationId": ids[loser], "message": "test"})
	req := httptest.NewRequest("POST", "https://admin.example.invalid/v1/operations/agentos/conversations/overview/runs", bytes.NewReader(input))
	req.Header.Set("Origin", "https://admin.example.invalid")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
	req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	response := httptest.NewRecorder()
	ConversationHandler{Service: s, Authority: f.Gateway}.ServeHTTP(response, req)
	var busy Object
	if err = json.Unmarshal(response.Body.Bytes(), &busy); err != nil || response.Code != 409 || busy["error"] != "operations_agentos_conversation_busy" || busy["operationId"] != ids[loser] || busy["blockingOperationId"] != ids[winner] || busy["conversationId"] != current.Row.ID || busy["admitted"] != false || calls.Load() != 1 {
		t.Fatalf("busy HTTP %d %#v %v", response.Code, busy, err)
	}
	if _, err = s.Run(ctx, f.Root, "overview", Object{"operationId": ids[winner], "message": "test"}, authorize); err != nil || calls.Load() != 1 {
		t.Fatalf("same operation must recover, calls=%d err=%v", calls.Load(), err)
	}
	task := ids[winner]
	cfg := Object{"externalWorkbench": Object{"conversationId": current.Row.ID, "operatorId": f.Root.ID, "turnOperationId": task}}
	_, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,'overview','workbench',$1::uuid::text,'fixture','human-ai','completed','completed','not-started',$3,$4,1,1,$5,now(),now(),now())`, task, f.Endpoint, *current.Row.AIAccountID, cfg, current.Row.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,native_run_id,model_state,state,created_at,updated_at) VALUES($1,$2::uuid,$2::uuid,$2::uuid::text,'completed','waiting-human',now(),now())`, f.Endpoint, task)
	if err != nil {
		t.Fatal(err)
	}
	// Even terminal-looking evidence for another native run cannot release admission.
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_workbench_runs_v1 SET native_run_id='other-run' WHERE task_id=$1`, task); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Run(ctx, f.Root, "overview", Object{"operationId": ids[loser], "message": "test"}, authorize); fault.Code(err) != "operations_agentos_conversation_busy" || calls.Load() != 1 {
		t.Fatalf("wrong native released admission: %v", err)
	}
	// A different task cannot lend this turn an otherwise matching terminal projection.
	otherTask := uuid.NewString()
	if _, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,'overview','workbench',$1::uuid::text,'other','human-ai','completed','completed','not-started',$3,$4,1,1,$5,now(),now(),now())`, otherTask, f.Endpoint, *current.Row.AIAccountID, cfg, current.Row.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,native_run_id,model_state,state,created_at,updated_at) VALUES($1,$2::uuid,$3::uuid,$3::uuid::text,'completed','completed',now(),now())`, f.Endpoint, otherTask, task); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Run(ctx, f.Root, "overview", Object{"operationId": ids[loser], "message": "test"}, authorize); fault.Code(err) != "operations_agentos_conversation_busy" || calls.Load() != 1 {
		t.Fatalf("wrong task released admission: %v", err)
	}
	if _, err = owner.Exec(ctx, `DELETE FROM operations_autonomy_workbench_runs_v1 WHERE endpoint=$1 AND task_id=$2`, f.Endpoint, otherTask); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_workbench_runs_v1 SET native_run_id=$1::uuid::text WHERE task_id=$1::uuid`, task); err != nil {
		t.Fatal(err)
	}
	// A recovered terminal original may have a historical unknown ACK; that history remains untouched.
	if _, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET state='unknown' WHERE id=$1`, task); err != nil {
		t.Fatal(err)
	}
	callID, cardID := uuid.NewString(), uuid.NewString()
	if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,metadata,created_at,updated_at) VALUES($1,$2,$3,$4,$4::uuid::text,'prepared-test','prepare-operation',$5,'completed','{}',now(),now())`, callID, f.Endpoint, current.Row.ID, task, strings.Repeat("e", 64)); err != nil {
		t.Fatal(err)
	}
	proposal := Object{"kind": "message-draft-save", "domain": "overview", "target": Object{"id": uuid.NewString()}, "impact": []any{}, "basis": []any{}}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'overview',$7,$8,$9,'prepared','{}',now(),now())`, cardID, f.Endpoint, current.Row.ID, task, callID, f.Root.ID, uuid.NewString(), strings.Repeat("f", 64), proposal); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Run(ctx, f.Root, "overview", Object{"operationId": ids[loser], "message": "test"}, authorize); err != nil || calls.Load() != 2 {
		t.Fatalf("completed model with waiting-human permits next: %v calls=%d", err, calls.Load())
	}
	// A different fixed-AI conversation has its own admission boundary.
	if _, err = s.Run(ctx, f.Root, "governance", Object{"operationId": uuid.NewString(), "message": "test"}, authorize); err != nil || calls.Load() != 3 {
		t.Fatalf("another conversation should not be blocked: %v calls=%d", err, calls.Load())
	}
}

func TestConversationAdmissionEqualTimestampCannotHideActivePG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	f.Delegated(t)
	ctx := context.Background()
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	done := "ffffffff-ffff-4fff-8fff-ffffffffffff"
	active := "00000000-0000-4000-8000-000000000001"
	for _, id := range []string{done, active} {
		if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,native_run_id,created_at) VALUES($1,$2,$3,$4,$5,'accepted','{}',$1::uuid::text,$6)`, id, f.Endpoint, current.Row.ID, f.Root.ID, strings.Repeat("d", 64), f.Now()); err != nil {
			t.Fatal(err)
		}
	}
	cfg := Object{"externalWorkbench": Object{"conversationId": current.Row.ID, "operatorId": f.Root.ID, "turnOperationId": done}}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,'overview','workbench',$1::uuid::text,'fixture','human-ai','completed','completed','not-started',$3,$4,1,1,$5,now(),now(),now())`, done, f.Endpoint, *current.Row.AIAccountID, cfg, current.Row.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,native_run_id,model_state,state,created_at,updated_at) VALUES($1,$2::uuid,$2::uuid,$2::uuid::text,'completed','completed',now(),now())`, f.Endpoint, done); err != nil {
		t.Fatal(err)
	}
	_, err = postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (bool, error) {
		return true, s.requireConversationAvailableWithin(ctx, tx, *current.Row, uuid.NewString())
	})
	var busy *ConversationBusyError
	if !errors.As(err, &busy) || busy.BlockingOperationID != active {
		t.Fatalf("same timestamp active must block, got %v %#v", err, busy)
	}
}
