package agentos

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/publicationfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type executionPublicationFixture struct{}

func (executionPublicationFixture) Account(context.Context, pgx.Tx, string, string) error { return nil }
func TestActualExecutionAuthorityPreparedUnknownAndOriginalReadback(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	endpoint, issuer, rootID := f.Endpoint, f.Issuer, f.IDs["root"]
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	directory := &conversationDirectory{}
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: rootID, Issuer: issuer, Subject: "root"}}, directory)
	if e != nil {
		t.Fatal(e)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	gateway.Now = now
	p := &operationspermissions.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators(), Now: now, AIWork: &operationsai.Service{Endpoint: endpoint}}
	request := httptest.NewRequest("GET", "https://admin.example.invalid/v1/operations/agentos", nil)
	request.Header.Set("Origin", "https://admin.example.invalid")
	request.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	human, e := gateway.AuthorizeOperations(request, false, "workbench.read")
	if e != nil {
		t.Fatal(e)
	}
	publication := publicationfixture.Prepare(t, pool, endpoint, now)
	forum := &community.Service{Pool: pool, Endpoint: endpoint, Authority: executionPublicationFixture{}, Now: now, OperationsHandling: true}
	payload := object(publication["payload"])
	raw, _ := json.Marshal(payload)
	if _, e = forum.Publish(ctx, publication["accounts"].([]any)[0].(string), string(raw)); e != nil {
		t.Fatal(e)
	}
	target := text(payload, "postId")
	authority := &Executions{Pool: pool, Endpoint: endpoint, Permissions: p, Now: now}
	business := &operationspermissions.BusinessAuthority{Human: gateway, Execution: authority}
	content := &operationscommunity.Service{Pool: pool, Endpoint: endpoint, Authority: business, PrincipalWithin: gateway.LockOperationsPrincipalWithin, ReadPrincipalWithin: gateway.ReadOperationsPrincipalWithin, Forum: forum, Now: now}
	authority.QualifyWithin = QualifyExecutionSources(content.QualifyPublicExecutionWithin, nil)
	g := &ExecutionGateway{Authority: authority, ReadContent: func(ctx context.Context, a operationspermissions.Actor, kind, id string) (Object, error) {
		return content.Content(ctx, a, kind, id, Object{})
	}, Visibility: content.ContentVisibility}
	fixture := seedExecution(t, f, authority, human, target, object(automation["accounts"]), false)
	id := text(object(fixture["original"]), "executionId")
	got, e := authority.Get(ctx, human, id)
	if e != nil {
		t.Fatal(e)
	}
	if text(object(got["execution"]), "id") != id || text(object(got["preparedAction"]), "targetId") != target {
		t.Fatal("execution readback lost selected target", got)
	}
	actor, e := authority.Actor(ctx, id, ExecutionActorOptions{})
	if e != nil {
		t.Fatal(e)
	}
	metadata, _ := authority.ExecutionMetadata(actor)
	if actor.ID != "executor:"+id || len(actor.Permissions) == 0 || len(metadata["resourceIds"].([]string)) != 1 || metadata["resourceIds"].([]string)[0] != target {
		t.Fatal("execution proof or target scope changed")
	}
	if authority.AcceptsExecution(operationspermissions.Actor{ID: actor.ID, Role: actor.Role, Endpoint: actor.Endpoint, Version: actor.Version, Permissions: actor.Permissions}) {
		t.Fatal("JSON actor forged private execution")
	}
	input := object(fixture["create"])
	input["operationId"] = uuid.NewString()
	authorize := func(ctx context.Context, tx pgx.Tx) (operationspermissions.Actor, error) {
		return gateway.RequireWithin(ctx, tx, human, "workbench.read")
	}
	created, e := authority.Create(ctx, human, input, authorize)
	if e != nil {
		t.Fatal("Go create", e)
	}
	goID := text(created, "executionId")
	goReplay, e := authority.Create(ctx, human, input, authorize)
	if e != nil || goReplay["replayed"] != true || goReplay["executionId"] != goID {
		t.Fatalf("Go create replay %v %v", e, goReplay)
	}

	pause, e := authority.Change(ctx, human, goID, Object{"operationId": uuid.NewString(), "expectedRevision": 1, "kind": "pause"}, authorize)
	if e != nil || object(pause["execution"])["state"] != "paused" {
		t.Fatalf("Go pause %v %v", e, pause)
	}
	paused, e := authority.Actor(ctx, goID, ExecutionActorOptions{InactiveRead: true})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = content.Content(ctx, paused, "post", target, Object{}); e != nil {
		t.Fatal("paused current read lost original semantics", e)
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return business.RequireWithin(ctx, tx, paused, "content.hide")
	}); fault.Code(e) != "operations_agentos_execution_inactive" {
		t.Fatalf("paused execution wrote %v", e)
	}
	if _, e = authority.Change(ctx, human, goID, Object{"operationId": uuid.NewString(), "expectedRevision": 2, "kind": "resume"}, authorize); e != nil {
		t.Fatal("Go resume", e)
	}
	var nativeWrites atomic.Int32
	runOperation := uuid.NewString()
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/health" {
			_ = json.NewEncoder(w).Encode(Object{"framework": "agno", "version": "3.1.7", "state": "running", "model": "configured"})
			return
		}
		if r.Method == "POST" && r.URL.Path == "/agents/galaxy-governance/runs" {
			nativeWrites.Add(1)
			if r.Header.Get("Idempotency-Key") != runOperation {
				t.Error("native operation changed")
			}
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = conn.Close()
			return
		}
		if r.Method == "GET" && r.URL.Path == "/galaxy/executions/"+goID {
			_ = json.NewEncoder(w).Encode(Object{"runs": []Object{{"runId": "original-native-run", "operationId": runOperation, "status": "RUNNING"}}})
			return
		}
		http.NotFound(w, r)
	}))
	defer native.Close()
	client, e := New(Configuration{URL: native.URL, SigningKey: strings.Repeat("s", 32), ServiceKey: strings.Repeat("k", 32)}, Options{Now: now})
	if e != nil {
		t.Fatal(e)
	}
	runtime := &ExecutionRuntime{Authority: authority, Client: client}
	runInput := Object{"operationId": runOperation, "message": "Original execution instruction"}
	if _, e = runtime.Command(ctx, human, goID, "run", runInput, authorize); fault.Code(e) != "operations_agentos_result_unknown" {
		t.Fatalf("lost native acceptance %v", e)
	}
	runReplay, e := runtime.Command(ctx, human, goID, "run", runInput, authorize)
	if e != nil || runReplay["state"] != "RUNNING" || nativeWrites.Load() != 1 {
		t.Fatalf("native run replayed %v %v writes%d", e, runReplay, nativeWrites.Load())
	}
	receipt, e := runtime.Operation(ctx, human, runOperation)
	if e != nil || receipt["state"] != "RUNNING" || nativeWrites.Load() != 1 {
		t.Fatalf("operation read dispatched %v %v", e, receipt)
	}
	handler := ExecutionHandler{Runtime: runtime, Authority: gateway}
	httpRequest := request.Clone(ctx)
	httpRequest.URL.Path = "/v1/operations/agentos/executions/" + goID
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httpRequest)
	if response.Code != 200 {
		t.Fatalf("execution HTTP %d %s", response.Code, response.Body.String())
	}
	httpInput := Object{}
	for k, v := range input {
		httpInput[k] = v
	}
	httpInput["operationId"] = uuid.NewString()
	body, _ := json.Marshal(httpInput)
	for _, csrf := range []bool{false, true} {
		req := request.Clone(ctx)
		req.Method = "POST"
		req.URL.Path = "/v1/operations/agentos/executions"
		req.Body = io.NopCloser(strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		if csrf {
			req.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		expected := 403
		if csrf {
			expected = 200
		}
		if response.Code != expected {
			t.Fatalf("execution create HTTP csrf%v %d %s", csrf, response.Code, response.Body.String())
		}
	}
	aiFixture := seedExecution(t, f, authority, human, target, object(automation["accounts"]), true)
	aiID := text(object(aiFixture["original"]), "executionId")
	aiActor, e := authority.Actor(ctx, aiID, ExecutionActorOptions{})
	if e != nil {
		t.Fatal("AI eligible current", e)
	}
	aiMeta, _ := authority.ExecutionMetadata(aiActor)
	if aiActor.ID != "executor:"+aiID || len(aiActor.Permissions) == 0 || len(aiMeta["resourceIds"].([]string)) != 1 || aiMeta["resourceIds"].([]string)[0] != target {
		t.Fatal("AI execution scope changed")
	}
	caller, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return p.HumanAIWithin(ctx, tx, human, "governance", "execution", "workbench.read")
	})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = authority.Actor(ctx, aiID, ExecutionActorOptions{Caller: &caller}); e != nil {
		t.Fatal("real caller intersection", e)
	}
	if _, e = authority.Actor(ctx, aiID, ExecutionActorOptions{Caller: &human}); fault.Code(e) != "business_admin_denied" {
		t.Fatalf("unattested caller accepted %v", e)
	}
	aiCreate := object(aiFixture["create"])
	aiCreate["operationId"] = uuid.NewString()
	aiCreated, e := authority.Create(ctx, human, aiCreate, authorize)
	if e != nil {
		t.Fatal("Go AI eligible create", e)
	}
	gotAI, e := authority.Get(ctx, human, text(aiCreated, "executionId"))
	if e != nil {
		t.Fatal(e)
	}
	if text(object(gotAI["execution"]), "id") != text(aiCreated, "executionId") {
		t.Fatal("AI execution readback changed")
	}
	options, e := authority.Options(ctx, human)
	if e != nil {
		t.Fatal("current options", e)
	}
	if items, ok := options["items"].([]any); !ok || len(items) == 0 {
		t.Fatal("eligible AI execution option missing")
	}
	if _, e = owner.Exec(ctx, `UPDATE forum_permissions_v1 SET revoked_at=$2 WHERE object_id=$1`, payload["versionId"], now()); e != nil {
		t.Fatal(e)
	}
	if _, e = authority.Actor(ctx, aiID, ExecutionActorOptions{}); fault.Code(e) != "operations_agentos_object_ineligible" {
		t.Fatalf("revoked source kept eligible execution %v", e)
	}
	if _, e = owner.Exec(ctx, `UPDATE forum_permissions_v1 SET revoked_at=NULL WHERE object_id=$1`, payload["versionId"]); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_ai_work_assignments_v1 SET enabled=false WHERE endpoint=$1 AND role_id=$2`, endpoint, object(aiFixture["role"])["id"]); e != nil {
		t.Fatal(e)
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return business.RequireWithin(ctx, tx, aiActor, "content.read")
	}); e == nil {
		t.Fatal("AI role revocation kept old executor proof")
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return business.RequireOperationWithin(ctx, tx, actor, []string{"content.hide"}, Object{"id": uuid.NewString()}, "community-content-visibility")
	}); fault.Code(e) != "operations_agentos_scope_denied" {
		t.Fatalf("out of scope execution allowed %v", e)
	}
	read := Object{"executionId": id, "tool": "read-selected-content", "arguments": Object{"kind": "post", "id": target}, "runId": "original-run", "callId": "source-read"}
	source, e := g.Execute(ctx, read, nil)
	if e != nil || source["body"] == nil {
		t.Fatalf("actual selected source %v %v", e, source)
	}
	command := Object{"executionId": id, "tool": "execute-prepared-command", "arguments": Object{}, "runId": "original-run", "callId": "prepared-effect"}
	// The business commits but its ACK is lost. The technical ledger must stay
	// unknown and the same original domain operation must recover, never reissue.
	writes := 0
	g.Visibility = func(ctx context.Context, a operationspermissions.Actor, kind, id string, x Object) (Object, error) {
		writes++
		result, e := content.ContentVisibility(ctx, a, kind, id, x)
		if e == nil && writes == 1 {
			return nil, errors.New("synthetic lost ACK")
		}
		return result, e
	}
	if _, e = g.Execute(ctx, command, nil); fault.Code(e) != "operations_agentos_tool_failed" {
		t.Fatalf("unknown commit was called success %v", e)
	}
	var state, operation string
	if e = pool.QueryRow(ctx, `SELECT state,operation_id::text FROM operations_agentos_tool_calls_v1 WHERE execution_id=$1 AND call_id='prepared-effect'`, id).Scan(&state, &operation); e != nil || state != "unknown" {
		t.Fatalf("unknown ledger %s %v", state, e)
	}
	recovered, e := g.Execute(ctx, command, nil)
	if e != nil || recovered["operationId"] != operation || recovered["replayed"] != true {
		t.Fatalf("original command not recovered %v %v", e, recovered)
	}
	var count int
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM business_admin_audit_v1 WHERE operation_id=$1`, operation).Scan(&count); e != nil || count != 1 {
		t.Fatalf("business effect repeated %d %v", count, e)
	}
	var kind string
	var role, contextValue *string
	var execution, grant string
	if e = pool.QueryRow(ctx, `SELECT actor_kind,operator_role,actor_context::text,execution_id::text,grant_id::text FROM business_admin_audit_v1 WHERE operation_id=$1`, operation).Scan(&kind, &role, &contextValue, &execution, &grant); e != nil || kind != "operations-executor" || role != nil || contextValue != nil || execution != id || grant != text(object(fixture["grant"]), "id") {
		t.Fatalf("executor attribution fabricated %s %v %v %v", kind, role, contextValue, e)
	}
	before := writes
	replay, e := g.Execute(ctx, command, nil)
	if e != nil || replay["replayed"] != true || writes != before {
		t.Fatalf("completed technical call repeated %v %v", e, replay)
	}
	if _, e = content.ContentVisibility(ctx, human, "post", target, Object{"operationId": uuid.NewString(), "expectedVersion": 1, "expectedRevision": 1, "kind": "restore", "reason": "Human restores the prior decision"}); e != nil {
		t.Fatal(e)
	}
	if _, e = content.ContentVisibility(ctx, human, "post", target, Object{"operationId": uuid.NewString(), "expectedVersion": 1, "expectedRevision": 2, "kind": "hide", "until": 2000000300, "reason": "Human records a new current decision"}); e != nil {
		t.Fatal(e)
	}
	if _, e = g.Execute(ctx, command, nil); fault.Code(e) != "operations_agentos_human_review_required" {
		t.Fatalf("executor replaced intervening human decision %v", e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_automation_grants_v1 SET version=version+1 WHERE id=$1`, text(object(fixture["grant"]), "id")); e != nil {
		t.Fatal(e)
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return business.RequireWithin(ctx, tx, actor, "content.read")
	}); fault.Code(e) != "operations_agentos_authority_changed" {
		t.Fatalf("stale proof retained grant %v", e)
	}
}
