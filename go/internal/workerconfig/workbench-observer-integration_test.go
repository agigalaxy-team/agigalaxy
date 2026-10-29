package workerconfig

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWorkbenchObserverProductionWorkerBindingPG(t *testing.T) {
	ctx := context.Background()
	owner, dsn := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	if _, err := databaseschema.Migrate(ctx, owner, []string{"worker"}); err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, err := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return err
	}
	workerPool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer workerPool.Close()
	var metadata map[string]any
	var calls int
	var duringRequest func()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "GET" || !strings.HasPrefix(r.URL.Path, "/galaxy/runs/") {
			t.Errorf("unexpected native request %s %s", r.Method, r.URL.Path)
		}
		if duringRequest != nil {
			callback := duringRequest
			duringRequest = nil
			callback()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"run": metadata, "output": "private should not escape"})
	}))
	defer server.Close()
	worker, err := autonomyWorker(workerPool, Config{Endpoint: f.Endpoint, AgentOS: agentos.Configuration{URL: server.URL, SigningKey: strings.Repeat("s", 32), ServiceKey: strings.Repeat("k", 32)}}, f.Gateway.StoredOperators(), nil)
	if err != nil {
		t.Fatal(err)
	}
	worker.Service.EnqueueWithin = func(context.Context, pgx.Tx, string, operationsautonomy.Object, string, *time.Time) error { return nil }
	ai := automation["accounts"].(map[string]any)["overview"].(string)
	task, conversation, session, native := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	operator := f.Root.ID
	_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversations_v1(id,endpoint,operator_id,domain,permission_key,session_id,created_at,ai_account_id) VALUES($1,$2,$3,'overview','fixture',$4,now(),$5)`, conversation, f.Endpoint, operator, session, ai)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at,native_run_id) VALUES($1,$2,$3,$4,'digest','accepted',jsonb_build_object('runId',$5::text),now(),$5)`, task, f.Endpoint, conversation, operator, native)
	if err != nil {
		t.Fatal(err)
	}
	seed := &operationsautonomy.Service{Pool: f.Pool, Endpoint: f.Endpoint, AIWork: f.Permissions.AIWork, Now: f.Now}
	_, err = postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (operationsautonomy.Object, error) {
		return seed.LinkWorkbenchWithin(ctx, tx, operationsautonomy.WorkbenchLink{OperationID: task, Domain: "overview", AIAccountID: ai, NativeRunID: &native, ConversationID: &conversation, SessionID: &session, OperatorID: &operator})
	})
	if err != nil {
		t.Fatal(err)
	}
	metadata = map[string]any{"runId": native, "domain": "overview", "componentType": "agent", "componentId": "galaxy-conversation-overview", "conversationId": conversation, "sessionId": session, "state": "ERROR"}
	readState := func() string {
		var state string
		if err := owner.QueryRow(ctx, `SELECT state FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, task).Scan(&state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	for _, key := range []string{"runId", "domain", "componentId", "componentType", "conversationId", "sessionId"} {
		old := metadata[key]
		metadata[key] = "wrong"
		if _, err = worker.Tick(ctx); err != nil {
			t.Fatal(err)
		}
		if readState() != "running" {
			t.Fatalf("mismatch %s altered task", key)
		}
		metadata[key] = old
	}
	newTurn := uuid.NewString()
	duringRequest = func() {
		if _, err := owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET configuration=jsonb_set(configuration,'{externalWorkbench,turnOperationId}',to_jsonb($3::text)) WHERE endpoint=$1 AND id=$2`, f.Endpoint, task, newTurn); err != nil {
			t.Errorf("replace turn: %v", err)
		}
	}
	if _, err = worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if readState() != "running" {
		t.Fatal("native result polluted a replaced turn")
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET configuration=jsonb_set(configuration,'{externalWorkbench,turnOperationId}',to_jsonb($3::text)) WHERE endpoint=$1 AND id=$2`, f.Endpoint, task, task); err != nil {
		t.Fatal(err)
	}
	if _, err = worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if state := readState(); state != "failed" {
		t.Fatalf("native ERROR was not reconciled: %s", state)
	}
	if _, err = worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if state := readState(); state != "failed" {
		t.Fatalf("repeat changed terminal state: %s", state)
	}
	if calls < 1 {
		t.Fatal("worker did not observe original native run")
	}
	var canReadPrivate bool
	if err = workerPool.QueryRow(ctx, `SELECT has_table_privilege(current_user,'public.operations_agentos_conversation_commands_v1','SELECT')`).Scan(&canReadPrivate); err != nil || canReadPrivate {
		t.Fatalf("worker received conversation table read: %v %v", canReadPrivate, err)
	}
	completedTask, completedConversation, completedSession, completedRun := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversations_v1(id,endpoint,operator_id,domain,permission_key,session_id,created_at,ai_account_id) VALUES($1,$2,$3,'overview','fixture-completed',$4,now(),$5)`, completedConversation, f.Endpoint, operator, completedSession, ai)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at,native_run_id) VALUES($1,$2,$3,$4,'digest','accepted',jsonb_build_object('runId',$5::text),now(),$5)`, completedTask, f.Endpoint, completedConversation, operator, completedRun)
	if err != nil {
		t.Fatal(err)
	}
	_, err = postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (operationsautonomy.Object, error) {
		return seed.LinkWorkbenchWithin(ctx, tx, operationsautonomy.WorkbenchLink{OperationID: completedTask, Domain: "overview", AIAccountID: ai, NativeRunID: &completedRun, ConversationID: &completedConversation, SessionID: &completedSession, OperatorID: &operator})
	})
	if err != nil {
		t.Fatal(err)
	}
	metadata = map[string]any{"runId": completedRun, "domain": "overview", "componentType": "agent", "componentId": "galaxy-conversation-overview", "conversationId": completedConversation, "sessionId": completedSession, "state": "COMPLETED"}
	if _, err = worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	var completedState string
	if err = owner.QueryRow(ctx, `SELECT state FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, completedTask).Scan(&completedState); err != nil || completedState != "completed" {
		t.Fatalf("native completion: %s %v", completedState, err)
	}
}
