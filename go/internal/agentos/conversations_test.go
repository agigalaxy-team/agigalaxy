package agentos

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type conversationDirectory struct{ denied atomic.Bool }

func (d *conversationDirectory) Roles(context.Context, string, string) ([]string, error) {
	if d.denied.Load() {
		return []string{}, nil
	}
	return []string{"admit-admin"}, nil
}
func (d *conversationDirectory) RolesFresh(ctx context.Context, issuer, subject string) ([]string, error) {
	return d.Roles(ctx, issuer, subject)
}

func TestDurableConversationOriginalIdentityAndPrivateAuthorization(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	endpoint, issuer, idRoot := f.Endpoint, f.Issuer, f.IDs["root"]
	role, err := f.Permissions.SaveRole(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Conversation service role", "description": "Isolated current AI permission fixture", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"workbench.read", "ai.roles.read", "ai.roles.create", "ai.roles.update", "ai.roles.assign", "ai.roles.revoke", "ai.prompts.read", "ai.prompts.update"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "overview", Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": object(role["role"])["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	for domain, configuration := range map[string]Object{"overview": {"prompt": "请依据当前授权处理，禁止借用其他岗位权限。"}, "governance": {"prompt": "原岗位工作要求", "model": Object{"retained": "unchanged"}}} {
		if _, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_configs_v1(id,endpoint,domain,revision,enabled,configuration,prompt_version,plan_version,delegation_version,updated_by,created_at,updated_at) VALUES($1,$2,$3,1,false,$4,1,1,1,$5,$6,$6)`, uuid.NewString(), endpoint, domain, configuration, idRoot, f.Now()); err != nil {
			t.Fatal(err)
		}
	}
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, err := c.Exec(ctx, "SET ROLE galaxy_api"); return err }
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	directory := &conversationDirectory{}
	gateway, err := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: idRoot, Issuer: issuer, Subject: "root"}}, directory)
	if err != nil {
		t.Fatal(err)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	gateway.Now = now
	permissions := &operationspermissions.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators(), Now: now, AIWork: &operationsai.Service{Endpoint: endpoint}}
	service := &Conversations{Pool: pool, Endpoint: endpoint, Permissions: permissions, Now: now}
	request, _ := http.NewRequest("GET", "https://admin.example.invalid/v1/operations/agentos/conversations/overview", nil)
	request.Header.Set("Origin", "https://admin.example.invalid")
	request.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	human, err := gateway.AuthorizeOperations(request, false, "workbench.read")
	if err != nil {
		t.Fatal(err)
	}
	current, err := service.Session(ctx, human, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	id := current.Row.ID
	again, err := service.Session(ctx, human, "overview", true)
	if err != nil || again.Row.ID != id || again.Row.PermissionKey != current.Row.PermissionKey {
		t.Fatal("durable conversation identity changed", err)
	}
	view := current.Row.View()
	if view["id"] != id || view["domain"] != "overview" || view["operatorId"] != idRoot {
		t.Fatal("conversation view changed", view)
	}
	input := Object{"conversationId": id, "operation": "run", "resourceType": "agents", "resourceId": "galaxy-conversation-overview"}
	value, err := service.AuthorizeNative(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if value["allowed"] != true || object(object(value["execution"])["rolePrompt"])["text"] != "请依据当前授权处理，禁止借用其他岗位权限。" {
		t.Fatal("current prompt or authorization missing")
	}
	// An accepted native request with a lost response is recovered through the
	// same durable turn before checking model readiness, never submitted twice.
	var writes atomic.Int32
	var retryMode atomic.Bool
	operationID, retryID := uuid.NewString(), uuid.NewString()
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/health" {
			_ = json.NewEncoder(w).Encode(Object{"framework": "agno", "version": "3.1.7", "state": "running", "model": "configured", "conversations": Object{"version": 2, "agentIds": []string{"galaxy-conversation-overview"}, "transport": Object{"originalRunLookup": 1}}})
			return
		}
		if r.Method == "POST" && r.URL.Path == "/agents/galaxy-conversation-overview/runs" {
			writes.Add(1)
			if r.Header.Get("Idempotency-Key") != operationID {
				t.Error("native operation identity changed")
			}
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = connection.Close()
			return
		}
		if r.Method == "POST" && r.URL.Path == "/agents/galaxy-conversation-overview/runs/original-native-run/continue" {
			writes.Add(1)
			_ = r.ParseForm()
			if r.Header.Get("Idempotency-Key") != retryID || r.Form.Get("retry_of_operation_id") != operationID || r.Form.Get("regenerate") != "true" || r.Form.Get("session_id") != current.Row.SessionID {
				t.Error("retry did not preserve its original identity and session")
			}
			_ = json.NewEncoder(w).Encode(Object{"run_id": "retry-native-run"})
			return
		}
		if r.Method == "GET" && r.URL.Path == "/galaxy/conversations/"+id+"/operations/"+retryID {
			if r.URL.Query().Get("runId") != "retry-native-run" || r.URL.Query().Get("retryOfOperationId") != operationID || r.URL.Query().Get("retryOfRunId") != "original-native-run" {
				t.Error("retry original lookup lost its stored lineage")
			}
			_ = json.NewEncoder(w).Encode(Object{"conversationId": id, "sessionId": current.Row.SessionID, "operationId": retryID, "runId": "retry-native-run", "state": "RUNNING", "native": Object{"runId": "retry-native-run", "operationId": retryID, "status": "RUNNING", "regeneratedFrom": "original-native-run"}})
			return
		}
		if r.Method == "GET" && r.URL.Path == "/galaxy/conversations/"+id {
			_ = json.NewEncoder(w).Encode(Object{"runs": []Object{{"runId": "original-native-run", "operationId": operationID, "status": "RUNNING", "content": nil}}})
			return
		}
		if r.Method == "GET" && r.URL.Path == "/galaxy/conversations/"+id+"/operations/"+operationID {
			native := Object{"runId": "original-native-run", "operationId": operationID, "status": "RUNNING", "content": nil}
			if retryMode.Load() {
				if r.URL.Query().Get("runId") != "original-native-run" {
					t.Error("retry lookup omitted the stored original native run")
				}
				native["status"], native["userInput"], native["errorCode"], native["failure"] = "ERROR", "查询当前处理状态", "operations_authorization_unavailable", nil
			}
			_ = json.NewEncoder(w).Encode(Object{"conversationId": id, "sessionId": current.Row.SessionID, "operationId": operationID, "runId": "original-native-run", "state": native["status"], "native": native})
			return
		}
		http.NotFound(w, r)
	}))
	defer agent.Close()
	service.Client, err = New(Configuration{URL: agent.URL, SigningKey: strings.Repeat("s", 32), ServiceKey: strings.Repeat("k", 32)}, Options{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	authorize := func(context.Context) (operationspermissions.Actor, error) {
		fresh := request.Clone(ctx)
		fresh.Method = "POST"
		fresh.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		return gateway.AuthorizeOperations(fresh, true, "workbench.read")
	}
	turn := Object{"operationId": operationID, "message": "查询当前处理状态"}
	httpTurn := func(input Object) Object {
		t.Helper()
		body, _ := json.Marshal(input)
		call := httptest.NewRequest("POST", "https://admin.example.invalid/v1/operations/agentos/conversations/overview/runs", bytes.NewReader(body))
		call.Header = request.Header.Clone()
		call.Header.Set("Content-Type", "application/json")
		call.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		response := httptest.NewRecorder()
		ConversationHandler{Service: service, Authority: gateway}.ServeHTTP(response, call)
		var value Object
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &value) != nil {
			t.Fatalf("actual conversation HTTP %d %s", response.Code, response.Body.String())
		}
		return value
	}
	result := httpTurn(turn)
	if err != nil || result["state"] != "unknown" || writes.Load() != 1 {
		t.Fatal("lost response was not durably unknown", result, err, writes.Load())
	}
	result = httpTurn(turn)
	if err != nil || result["state"] != "RUNNING" || result["replayed"] != true || writes.Load() != 1 {
		t.Fatal("original turn was not recovered without resending", result, err, writes.Load())
	}
	if _, err = service.Run(ctx, human, "overview", Object{"operationId": operationID, "message": "different"}, authorize); fault.Code(err) != "operations_agentos_operation_conflict" {
		t.Fatal("operation identity accepted changed input", err)
	}
	// The explicit retry uses the same owner, question and failed original. A
	// transient authorization-service failure is not a durable permission grant.
	if _, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET native_run_id=$3 WHERE endpoint=$1 AND id=$2`, endpoint, operationID, "original-native-run"); err != nil {
		t.Fatal(err)
	}
	retryMode.Store(true)
	// The retry follows a verified terminal original. Production sync records
	// this same turn/run/AI evidence even if its original ACK stayed unknown.
	cfg := Object{"externalWorkbench": Object{"conversationId": id, "operatorId": idRoot, "turnOperationId": operationID}}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,'overview','workbench',$1::uuid::text,'fixture','human-ai','failed','failed','not-started',$3,$4,1,1,$5,now(),now(),now())`, operationID, endpoint, *current.Row.AIAccountID, cfg, current.Row.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,native_run_id,model_state,state,created_at,updated_at) VALUES($1,$2::uuid,$2::uuid,'original-native-run','failed','failed',now(),now())`, endpoint, operationID); err != nil {
		t.Fatal(err)
	}
	retryTurn := Object{"operationId": retryID, "retryOfOperationId": operationID, "message": "查询当前处理状态"}
	denied := func(context.Context) (operationspermissions.Actor, error) {
		return operationspermissions.Actor{}, fail("operations_permission_denied", 403)
	}
	if _, err = service.Run(ctx, human, "overview", retryTurn, denied); fault.Status(err) != 403 || writes.Load() != 1 {
		t.Fatal("revoked current authority must stop retry before dispatch", err, writes.Load())
	}
	if _, err = service.Run(ctx, human, "overview", Object{"operationId": retryID, "retryOfOperationId": operationID, "message": "不同问题"}, authorize); fault.Code(err) != "operations_agentos_retry_unavailable" || writes.Load() != 1 {
		t.Fatal("retry must remain bound to the original question", err, writes.Load())
	}
	retryResult, err := service.Run(ctx, human, "overview", retryTurn, authorize)
	if err != nil || retryResult["operationId"] != retryID || retryResult["retryOfOperationId"] != operationID || retryResult["state"] != "accepted" || writes.Load() != 2 {
		t.Fatal("authorized explicit retry did not preserve the original binding", retryResult, err, writes.Load())
	}
	recoveredRetry, err := service.Run(ctx, human, "overview", retryTurn, authorize)
	if err != nil || recoveredRetry["operationId"] != retryID || recoveredRetry["replayed"] != true || writes.Load() != 2 {
		t.Fatal("retry recovery must read the same operation without a second POST", recoveredRetry, err, writes.Load())
	}
	retryMode.Store(false)
	service.Tools = &ConversationTools{Conversations: service}
	toolInput := Object{"conversationId": id, "sessionId": current.Row.SessionID, "turnId": operationID, "runId": "original-native-run", "callId": "provider:opaque/call+01", "tool": "read-ai-delegation", "arguments": Object{}}
	invokeTool := func(input Object) *httptest.ResponseRecorder {
		body, _ := json.Marshal(input)
		call := httptest.NewRequest("POST", "https://admin.example.invalid/v1/internal/agentos/tools/execute", bytes.NewReader(body))
		call.Header.Set("Authorization", "Bearer "+strings.Repeat("k", 32))
		call.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		NativeHandler{Client: service.Client, Conversations: service}.ServeHTTP(response, call)
		return response
	}
	toolResponse := invokeTool(toolInput)
	if toolResponse.Code != 200 {
		t.Fatalf("private bound tool %d %s", toolResponse.Code, toolResponse.Body.String())
	}
	var toolResult Object
	if json.Unmarshal(toolResponse.Body.Bytes(), &toolResult) != nil {
		t.Fatal("invalid actual tool result")
	}
	if toolResult["tool"] != "read-ai-delegation" || toolResult["availability"] != "available" || toolResult["data"] == nil || object(toolResult["pagination"])["complete"] != true {
		t.Fatal("current delegation projection unavailable", toolResult)
	}
	toolInput["arguments"] = Object{"aiAccountId": uuid.NewString()}
	if response := invokeTool(toolInput); response.Code != 409 {
		t.Fatal("opaque tool call identity accepted changed arguments", response.Code, response.Body.String())
	}
	var metadata Object
	if err = owner.QueryRow(ctx, `SELECT metadata FROM operations_agentos_conversation_tool_calls_v1 WHERE conversation_id=$1 AND call_id=$2`, id, toolInput["callId"]).Scan(&metadata); err != nil || len(metadata) != 5 || metadata["tool"] != "read-ai-delegation" {
		t.Fatal("tool ledger contains unexpected result or arguments", metadata, err)
	}
	cancelledInput := copyObject(toolInput)
	cancelledInput["tool"], cancelledInput["callId"], cancelledInput["arguments"] = "query-operations", "cancelled-current-read", Object{}
	cancelled, cancelRead := context.WithCancel(ctx)
	service.Tools.Query = func(ctx context.Context, _ operationspermissions.Actor, _, _ string, _ Object) (Object, error) {
		cancelRead()
		return nil, ctx.Err()
	}
	if _, err = service.Tools.Execute(cancelled, cancelledInput); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled read continued or lost its actual error", err)
	}
	var toolState string
	if err = owner.QueryRow(ctx, `SELECT state,metadata FROM operations_agentos_conversation_tool_calls_v1 WHERE conversation_id=$1 AND call_id=$2`, id, cancelledInput["callId"]).Scan(&toolState, &metadata); err != nil || toolState != "unavailable" || metadata["code"] != "operations_agentos_tool_request_cancelled" {
		t.Fatal("cancelled HTTP context left tool ledger started", toolState, metadata, err)
	}
	service.Tools.Query = func(context.Context, operationspermissions.Actor, string, string, Object) (Object, error) {
		return Object{"tool": "query-operations", "module": "feedback", "view": "list", "evidenceRefs": []any{}}, nil
	}
	if _, err = service.Tools.Execute(ctx, cancelledInput); err != nil {
		t.Fatal(err)
	}
	service.Tools.Query = func(context.Context, operationspermissions.Actor, string, string, Object) (Object, error) {
		return nil, fail("operations_query_not_configured", 503)
	}
	if _, err = service.Tools.Execute(ctx, cancelledInput); fault.Status(err) != 503 {
		t.Fatal("late failed read did not retain its own failure", err)
	}
	if err = owner.QueryRow(ctx, `SELECT state FROM operations_agentos_conversation_tool_calls_v1 WHERE conversation_id=$1 AND call_id=$2`, id, cancelledInput["callId"]).Scan(&toolState); err != nil || toolState != "completed" {
		t.Fatal("late failed retry replaced a completed observation", toolState, err)
	}
	service.Tools.Query = nil

	service.Tools.Prepare = func(ctx context.Context, actor operationspermissions.Actor, row Conversation, args Object, operation string) (Object, error) {
		return permissions.PrepareManagementAction(ctx, actor, row.Domain, args, operation)
	}
	prepareArgs := Object{"kind": "ai-role-command", "command": Object{"kind": "role-create", "expectedVersion": 0, "name": "Actual conversation role", "description": "Explicit delegated recipient only", "enabled": true, "permissions": []any{"feedback.read"}, "targetAiAccountIds": []any{object(automation["accounts"])["governance"]}}}
	toolInput["tool"], toolInput["callId"], toolInput["arguments"] = "prepare-operation", "provider.prepare.1", prepareArgs
	preparedHTTP := invokeTool(toolInput)
	if preparedHTTP.Code != 200 {
		t.Fatalf("actual prepare card %d %s", preparedHTTP.Code, preparedHTTP.Body.String())
	}
	var preparedCardResult Object
	_ = json.Unmarshal(preparedHTTP.Body.Bytes(), &preparedCardResult)
	card := object(preparedCardResult["card"])
	if object(card["capability"])["canConfirm"] != true || preparedCardResult["effectExecuted"] != false {
		t.Fatal("proposal was not a human confirmation card", preparedCardResult)
	}
	cardCommand := func(card Object, action string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(Object{"cardId": card["cardId"], "operationId": card["operationId"]})
		call := httptest.NewRequest("POST", "https://admin.example.invalid/v1/operations/agentos/conversations/overview/cards/"+text(card, "cardId")+"/"+action, bytes.NewReader(body))
		call.Header = request.Header.Clone()
		call.Header.Set("Content-Type", "application/json")
		call.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		response := httptest.NewRecorder()
		ConversationHandler{Service: service, Authority: gateway}.ServeHTTP(response, call)
		return response
	}
	for i := 0; i < 2; i++ {
		response := cardCommand(card, "confirm")
		var value Object
		_ = json.Unmarshal(response.Body.Bytes(), &value)
		if response.Code != 200 || value["state"] != "completed" {
			t.Fatalf("actual confirmation %d %s", response.Code, response.Body.String())
		}
	}
	var count int
	if err = owner.QueryRow(ctx, `SELECT count(*) FROM operations_business_roles_v1 WHERE endpoint=$1 AND name='Actual conversation role'`, endpoint).Scan(&count); err != nil || count != 1 {
		t.Fatal("confirmation duplicated delegated business write", count, err)
	}
	// Distinct user turns own distinct preparation budgets. The original test
	// observes independent receipts rather than adding multiple cards to one turn.
	newToolTurn := func() {
		t.Helper()
		turn, native := uuid.NewString(), "fixture-"+uuid.NewString()
		_, e := owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,native_run_id,result,created_at) VALUES($1,$2,$3,$4,$5,'accepted',$6,$7,$8)`, turn, endpoint, id, human.ID, strings.Repeat("f", 64), native, Object{"runId": native, "taskProgress": defaultConversationTask(turn, turn)}, now())
		if e != nil {
			t.Fatal(e)
		}
		toolInput["turnId"], toolInput["runId"] = turn, native
	}
	newToolTurn()
	// An attempted operation without an observable receipt never becomes prepared again.
	unknownArgs := copyObject(prepareArgs)
	unknownCommand := copyObject(object(prepareArgs["command"]))
	unknownCommand["name"] = "Unconfirmed receipt role"
	unknownArgs["command"] = unknownCommand
	toolInput["callId"], toolInput["arguments"] = "provider.prepare.unknown", unknownArgs
	response := invokeTool(toolInput)
	var unknown Object
	_ = json.Unmarshal(response.Body.Bytes(), &unknown)
	if response.Code != 200 {
		t.Fatal("unknown receipt card prepare", response.Body.String())
	}
	unknownCard := object(unknown["card"])
	if _, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_cards_v1 SET state='processing',result=jsonb_build_object('confirmationAttemptedAt','original-attempt') WHERE id=$1`, unknownCard["cardId"]); err != nil {
		t.Fatal(err)
	}
	response = cardCommand(unknownCard, "confirm")
	var recovered Object
	_ = json.Unmarshal(response.Body.Bytes(), &recovered)
	if response.Code != 200 || recovered["state"] != "unknown" {
		t.Fatal("absent original receipt rearmed an attempted card", response.Code, response.Body.String())
	}
	if err = owner.QueryRow(ctx, `SELECT count(*) FROM operations_business_roles_v1 WHERE endpoint=$1 AND name='Unconfirmed receipt role'`, endpoint).Scan(&count); err != nil || count != 0 {
		t.Fatal("unknown original operation was reissued", count, err)
	}

	newToolTurn()
	promptArgs := Object{"kind": "ai-work-prompt-save", "aiAccountId": object(automation["accounts"])["governance"], "prompt": "按当前已获准的职责核查，保持原数据边界。"}
	toolInput["callId"], toolInput["arguments"] = "provider.prepare.prompt", promptArgs
	response = invokeTool(toolInput)
	var promptPrepared Object
	_ = json.Unmarshal(response.Body.Bytes(), &promptPrepared)
	if response.Code != 200 {
		t.Fatalf("prompt review prepare %d %s", response.Code, response.Body.String())
	}
	promptCard := object(promptPrepared["card"])
	if promptCard["review"] == nil || object(promptCard["capability"])["canConfirm"] != true {
		t.Fatal("prompt review not available", promptCard)
	}
	response = cardCommand(promptCard, "confirm")
	var promptResult Object
	_ = json.Unmarshal(response.Body.Bytes(), &promptResult)
	if response.Code != 200 || promptResult["state"] != "completed" || promptResult["review"] == nil {
		t.Fatal("prompt confirmation failed", response.Code, response.Body.String())
	}
	// Withdrawing the actual delegation removes historical prompt bodies too.
	withdrawn := copyObject(object(automation["delegationInput"]))
	withdrawn["operationId"], withdrawn["expectedVersion"], withdrawn["enabled"] = uuid.NewString(), 1, false
	if _, err = permissions.SaveDelegation(ctx, human, withdrawn); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Tools.Card(ctx, human, "overview", text(promptCard, "cardId")); fault.Status(err) != 403 {
		t.Fatal("withdrawn delegation still exposes historical prompt review", err)
	}
	if _, err = owner.Exec(ctx, "DELETE FROM operations_operator_sessions_v1"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.AuthorizeNative(ctx, input); err != nil {
		t.Fatal("private runtime borrowed an HTTP session", err)
	}
	bad := Object{"conversationId": id, "operation": "run", "resourceType": "workflows"}
	if _, err = service.AuthorizeNative(ctx, bad); fault.Code(err) != "operations_agentos_domain_mismatch" {
		t.Fatal("resource mismatch accepted", err)
	}
	if _, err = owner.Exec(ctx, "UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE id=$1", *current.Row.AIAccountID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.AuthorizeNative(ctx, input); err == nil {
		t.Fatal("disabled fixed AI retained authority")
	}
	if _, err = owner.Exec(ctx, "UPDATE operations_ai_work_accounts_v1 SET enabled=true WHERE id=$1", *current.Row.AIAccountID); err != nil {
		t.Fatal(err)
	}
	directory.denied.Store(true)
	if _, err = service.AuthorizeNative(ctx, input); err == nil {
		t.Fatal("revoked human retained private runtime authority")
	}
}
