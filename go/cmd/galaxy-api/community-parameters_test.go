package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/communitygrowth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGovernanceCommunityCardUsesOriginalWorkbenchOperation(t *testing.T) {
	ctx := context.Background()
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	role, err := f.Permissions.SaveRole(ctx, f.Root, agentos.Object{
		"operationId": uuid.NewString(), "expectedVersion": 0, "name": "治理参数建议",
		"description": "只读取计分参数", "subjectScope": "ai-only", "enabled": true,
		"permissions": []string{"rules.read"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "governance", agentos.Object{
		"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true,
	}); err != nil {
		t.Fatal(err)
	}
	conversations := &agentos.Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	autonomy := &operationsautonomy.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway,
		AIWork: f.Permissions.AIWork, Permissions: f.Permissions, Now: f.Now}
	f.Permissions.Duty = autonomy
	growth := &communitygrowth.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: &p.BusinessAuthority{Human: f.Gateway, Duty: autonomy}, Now: f.Now}
	connectWorkbench(conversations, autonomy, slog.Default())
	actions := connectWorkbenchActions(conversations, autonomy, nil, nil)
	actions.Now = f.Now
	connectCommunityParameterActions(conversations, autonomy, actions, growth)
	session, err := conversations.Session(ctx, f.Root, "governance", true)
	if err != nil {
		t.Fatal(err)
	}
	row := *session.Row
	turn := uuid.NewString()
	// Seed the already admitted model turn. The real service handles its tool
	// call, card persistence, management read, human decision and owner write.
	if _, err = postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (bool, error) {
		if _, err := tx.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1
			(id,endpoint,conversation_id,operator_id,message_digest,state,native_run_id,result,created_at)
			VALUES($1,$2,$3,$4,$5,'accepted',$1::uuid::text,'{}',$6)`,
			turn, f.Endpoint, row.ID, row.OperatorID, strings.Repeat("a", 64), f.Now()); err != nil {
			return false, err
		}
		err := conversations.LinkWorkbenchWithin(ctx, tx, row, turn, "")
		return err == nil, err
	}); err != nil {
		t.Fatal(err)
	}
	tool := func(name string, args agentos.Object) agentos.Object {
		t.Helper()
		result, err := conversations.Tools.Execute(ctx, agentos.Object{"conversationId": row.ID, "sessionId": row.SessionID,
			"turnId": turn, "runId": turn, "callId": uuid.NewString(), "tool": name, "arguments": args})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return result
	}
	current := tool("read-community-parameters", agentos.Object{"area": "growth", "scope": "like_received"})
	prepared := tool("prepare-operation", agentos.Object{"kind": "community-parameter-adjustment", "area": "growth",
		"scope": "like_received", "expectedVersion": current["version"], "parameters": agentos.Object{"experience": 3}, "reason": "调整今后的互动经验"})
	card, ok := prepared["card"].(map[string]any)
	if !ok || card["state"] != "prepared" {
		t.Fatalf("no prepared card: %v", prepared)
	}
	checkRule := func(version, experience int64) {
		t.Helper()
		var v, xp int64
		err := owner.QueryRow(ctx, `SELECT version,experience FROM community_growth_rules_v1
			WHERE endpoint=$1 AND rule_key='like_received'`, f.Endpoint).Scan(&v, &xp)
		if err != nil || v != version || xp != experience {
			t.Fatalf("rule version=%d experience=%d: %v", v, xp, err)
		}
	}
	checkRule(1, 1)
	path := "/v1/operations/agentos/conversations/governance/cards"
	handler := agentos.ConversationHandler{Service: conversations, Authority: f.Gateway}
	request := func(method, target string, body agentos.Object) agentos.Object {
		t.Helper()
		encoded, _ := json.Marshal(body)
		r := httptest.NewRequest(method, "https://admin.example.invalid"+target, bytes.NewReader(encoded))
		r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
		r.Header.Set("Origin", "https://admin.example.invalid")
		r.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		r.Header.Set("Content-Type", "application/json")
		if r.URL.RawQuery != "" && !httpboundary.AllowedQuery(method, r.URL.Path, r.URL.RawQuery, "") {
			t.Fatalf("query rejected: %s", target)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		var result agentos.Object
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != http.StatusOK {
			t.Fatalf("%s %s: %d %s %v", method, target, response.Code, response.Body.String(), err)
		}
		return result
	}
	listed := request(http.MethodGet, path+"?kind=community-parameter-adjustment", nil)
	items, ok := listed["items"].([]any)
	if !ok || len(items) != 1 || items[0].(map[string]any)["cardId"] != card["cardId"] {
		t.Fatalf("governance did not list the original card: %v", listed)
	}
	confirmPath := path + "/" + card["cardId"].(string) + "/confirm"
	for i := 0; i < 2; i++ {
		adopted := request(http.MethodPost, confirmPath, agentos.Object{"cardId": card["cardId"], "operationId": card["operationId"]})
		if adopted["state"] != "completed" {
			t.Fatalf("original confirmation: %v", adopted)
		}
	}
	checkRule(2, 3)

	now := f.Now()
	autonomy.Now = func() time.Time { return now }
	autonomy.Native = macroTestNative{}
	autonomy.NativeConfigured = func() bool { return true }
	autonomy.RuntimeStatus = func(context.Context) (agentos.Object, error) {
		return agentos.Object{"state": "connected", "modelState": "configured"}, nil
	}
	var queued agentos.Object
	autonomy.EnqueueWithin = func(_ context.Context, _ pgx.Tx, kind string, payload agentos.Object, _ string, _ *time.Time) error {
		if kind == "autonomy-task" {
			queued = payload
		}
		return nil
	}
	if _, err = databaseschema.Migrate(ctx, owner, []string{"worker"}); err != nil {
		t.Fatal(err)
	}
	workerConfig := owner.Config()
	workerConfig.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return err
	}
	workerPool, err := pgxpool.NewWithConfig(ctx, workerConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer workerPool.Close()
	workerService := &operationsautonomy.Service{Pool: workerPool, Endpoint: f.Endpoint, AIWork: f.Permissions.AIWork,
		Now: autonomy.Now, Native: autonomy.Native, NativeConfigured: autonomy.NativeConfigured, EnqueueWithin: autonomy.EnqueueWithin}
	worker := operationsautonomy.NewWorker(workerService)
	if _, err = worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	authorize := func(context.Context) (p.Actor, error) { return f.Root, nil }
	if _, err = autonomy.SaveConfig(ctx, f.Root, "governance", agentos.Object{
		"operationId": uuid.NewString(), "expectedRevision": 1, "enabled": true, "mode": "ai",
		"schedule": agentos.Object{"kind": "interval", "minutes": 1},
		"purpose":  "operations-governance", "goal": "分析社区计分规则", "prompt": "",
		"plan": agentos.Object{"communityParameterProposals": true},
	}, authorize); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if _, err = worker.Tick(ctx); err != nil || queued == nil {
		t.Fatalf("routine was not scheduled: %v %v", queued, err)
	}
	if run, err := worker.Execute(ctx, queued); err != nil || run["state"] != "running" {
		t.Fatalf("routine was not started: %v %v", run, err)
	}
	taskID := queued["taskId"].(string)
	var attempt *string
	if err = owner.QueryRow(ctx, `SELECT native_attempt_id::text FROM operations_autonomy_tasks_v1 WHERE id=$1`, taskID).Scan(&attempt); err != nil {
		t.Fatal(err)
	}
	callID := uuid.NewString()
	toolInput := agentos.Object{
		"taskId": taskID, "nativeRunId": "governance-fixture-run",
		"callId": callID, "tool": "prepare-community-parameters",
		"arguments": agentos.Object{"kind": "community-parameter-adjustment", "area": "growth", "scope": "like_received",
			"expectedVersion": 2, "parameters": agentos.Object{"experience": 4}, "reason": "审核未来互动经验"},
	}
	if attempt != nil {
		toolInput["nativeAttemptId"] = *attempt
	}
	proposed, err := autonomy.Tool(ctx, toolInput, false)
	if err != nil || proposed["state"] != "waiting-human" {
		t.Fatalf("automatic proposal: %v %v", proposed, err)
	}
	checkRule(2, 3)
	var revision int64
	if err = owner.QueryRow(ctx, `SELECT revision FROM operations_autonomy_tasks_v1 WHERE id=$1`, taskID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	decision := agentos.Object{"operationId": uuid.NewString(), "expectedRevision": revision, "callId": callID, "decision": "approved"}
	for i := 0; i < 2; i++ {
		result, err := autonomy.Decide(ctx, f.Root, taskID, decision, authorize)
		if err != nil || result["communityParameterReceipt"] == nil {
			t.Fatalf("automatic proposal receipt: %v %v", result, err)
		}
	}
	checkRule(3, 4)
}

type macroTestNative struct{}

func (macroTestNative) Run(_ context.Context, task agentos.Object) (agentos.Object, error) {
	return agentos.Object{"taskId": task["id"], "sessionId": task["session_id"], "nativeRunId": "governance-fixture-run",
		"nativeAttemptId": task["native_attempt_id"], "status": "RUNNING", "modelState": "running", "continuable": false}, nil
}
func (macroTestNative) Read(context.Context, agentos.Object) (agentos.Object, error) {
	return nil, nil
}
func (macroTestNative) Continue(context.Context, agentos.Object) (agentos.Object, error) {
	return nil, nil
}
func (macroTestNative) Cancel(context.Context, agentos.Object) (agentos.Object, error) {
	return nil, nil
}
