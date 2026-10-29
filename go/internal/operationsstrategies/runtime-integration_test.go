package operationsstrategies

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/publicationfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type publicationQualificationFixture struct{}

func (publicationQualificationFixture) Account(context.Context, pgx.Tx, string, string) error {
	return nil
}
func TestStrategyRealPreparedEffectOriginalTraceAndReceipt(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	currentFixture := operationsfixture.New(t, owner)
	base := currentFixture.Data
	currentFixture.Automation(t)
	endpoint, issuer, rootID := str(base["endpoint"]), str(base["issuer"]), str(obj(base["ids"])["root"])
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	var enabled atomic.Bool
	enabled.Store(true)
	g, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{Issuer: issuer, Subject: "root", OperatorID: rootID}}, currentDirectory{&enabled})
	if e != nil {
		t.Fatal(e)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	g.Now = now
	permissions := &p.Service{Pool: pool, Endpoint: endpoint, Authority: g, StoredAuthority: g.StoredOperators(), Now: now, AIWork: &operationsai.Service{Endpoint: endpoint}}
	publication := publicationfixture.Prepare(t, owner, endpoint, now)
	forum := &community.Service{Pool: pool, Endpoint: endpoint, Authority: publicationQualificationFixture{}, Now: now, OperationsHandling: true}
	payload := obj(publication["payload"])
	body, _ := json.Marshal(payload)
	if _, e = forum.Publish(ctx, publication["accounts"].([]any)[0].(string), string(body)); e != nil {
		t.Fatal(e)
	}
	target := str(payload["postId"])
	executionFixture := seedStrategyExecution(t, currentFixture, target)
	executionID := str(obj(executionFixture["original"])["executionId"])
	executions := &agentos.Executions{Pool: pool, Endpoint: endpoint, Permissions: permissions, Now: now}
	business := &p.BusinessAuthority{Human: g, Execution: executions}
	content := &operationscommunity.Service{Pool: pool, Endpoint: endpoint, Authority: business, PrincipalWithin: g.LockOperationsPrincipalWithin, ReadPrincipalWithin: g.ReadOperationsPrincipalWithin, Forum: forum, Now: now}
	strategy := &Service{Pool: pool, Endpoint: endpoint, Authority: business, StoredAuthority: g.StoredOperators(), Executor: executions, RequireExecutionWithin: executions.RequireExecutionWithin, Now: now}
	executions.QualifyWithin = agentos.QualifyExecutionSources(content.QualifyPublicExecutionWithin, strategy.QualifyOrdinaryExecutionWithin)
	writes := 0
	gateway := &agentos.ExecutionGateway{Authority: executions, ReadContent: func(ctx context.Context, a p.Actor, kind, id string) (Object, error) {
		return content.Content(ctx, a, kind, id, Object{})
	}, Visibility: func(ctx context.Context, a p.Actor, kind, id string, input Object) (Object, error) {
		writes++
		v, e := content.ContentVisibility(ctx, a, kind, id, input)
		if e == nil && writes == 1 {
			return nil, errors.New("isolated business receipt ACK lost")
		}
		return v, e
	}}
	effects := &EffectsAdapter{PoolReader: strategy, Executions: executions, Gateway: gateway, Content: content, PriorPreparedEffect: gateway.PreparedEffect}
	strategy.Effects = effects
	configuration := sampleConfig()
	selected := obj(list(configuration["strategies"])[0])
	selected["enabled"], selected["template"] = true, "selected-public-content-visibility"
	condition := obj(selected["condition"])
	obj(list(condition["rules"])[0])["value"] = 10
	parsed, e := ParseConfiguration(configuration)
	if e != nil {
		t.Fatal(e)
	}
	selected = findStrategy(parsed, selected["id"])
	facts, e := effects.Inspect(ctx, executionID, rootID, []Object{selected})
	if e != nil {
		t.Fatal(e)
	}
	rawFacts, e := os.ReadFile("testdata/strategies-effects.json")
	if e != nil {
		t.Fatal(e)
	}
	var original Object
	if e = json.Unmarshal(rawFacts, &original); e != nil {
		t.Fatal(e)
	}
	original["executionId"], original["ownerId"], original["grantId"] = executionID, rootID, obj(executionFixture["grant"])["id"]
	obj(original["target"])["id"] = target
	if !same(facts, original) {
		a, _ := json.Marshal(facts)
		b, _ := json.Marshal(original)
		t.Fatalf("real condition/source facts differ\nGo%s\nReference%s", a, b)
	}
	request := httptest.NewRequest("POST", "https://admin.example.invalid/v1/operations/strategies/draft", nil)
	request.Header.Set("Origin", "https://admin.example.invalid")
	request.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
	request.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	authorize := func() (Actor, error) { return g.AuthorizeOperations(request, true, "") }
	human, e := authorize()
	if e != nil {
		t.Fatal(e)
	}
	saved, e := strategy.SaveDraft(ctx, human, Object{"operationId": uuid.NewString(), "expectedRevision": 0, "configuration": parsed, "reason": "原选定内容策略"}, authorize)
	if e != nil {
		t.Fatal(e)
	}
	rehearsal, e := strategy.Rehearsal(ctx, human, Object{"operationId": uuid.NewString(), "versionId": saved["versionId"], "executionIds": []string{executionID}})
	if e != nil || rehearsal["valid"] != true {
		t.Fatalf("actual consumer rehearsal %v %#v", e, rehearsal)
	}
	if _, e = strategy.Publish(ctx, human, Object{"operationId": uuid.NewString(), "expectedRevision": 1, "versionId": saved["versionId"], "rehearsalId": rehearsal["rehearsalId"], "reason": "原真实预演发布"}, authorize); e != nil {
		t.Fatal(e)
	}
	var handler Handler
	var client *agentos.Client
	var rowContext Object
	nativeRun := "original-native-run"
	metadata := Object{"runId": nativeRun, "status": "RUNNING", "awaitingHuman": false, "workflowId": WorkflowID, "workflowVersion": 1, "steps": []any{}}
	private := func(path string, input Object) (int, Object) {
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", "http://api.invalid/v1/internal/agentos/p13/"+path, strings.NewReader(string(raw)))
		r.Header.Set("Authorization", "Bearer "+strings.Repeat("k", 32))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var o Object
		_ = json.Unmarshal(w.Body.Bytes(), &o)
		return w.Code, o
	}
	starts := 0
	continuePosts := 0
	continuationReceipts := map[string]Object{}
	loseContinuationACK := true
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/health":
			_ = json.NewEncoder(w).Encode(Object{"framework": "agno", "version": "3.1.7", "state": "running", "model": "configured", "strategies": Object{"state": "ready", "workflowId": WorkflowID, "workflowVersion": 1}})
		case strings.HasSuffix(r.URL.Path, "/start"):
			starts++
			parts := strings.Split(r.URL.Path, "/")
			runID := parts[len(parts)-2]
			code, result := private("context", Object{"runId": runID, "executionId": executionID, "operation": "run"})
			if code != 200 {
				t.Errorf("actual native context %d %#v", code, result)
			}
			rowContext = result
			_ = json.NewEncoder(w).Encode(Object{"accepted": true})
		case strings.Contains(r.URL.Path, "/continuations/"):
			op := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			receipt := continuationReceipts[op]
			if receipt == nil {
				receipt = Object{"operationId": op, "runId": rowContext["runId"], "nativeRunId": nativeRun, "pauseId": metadata["pauseId"], "state": "not-recorded"}
			}
			_ = json.NewEncoder(w).Encode(receipt)
		case strings.HasSuffix(r.URL.Path, "/continue"):
			continuePosts++
			op := r.Header.Get("Idempotency-Key")
			continuationReceipts[op] = Object{"operationId": op, "runId": rowContext["runId"], "nativeRunId": nativeRun, "pauseId": metadata["pauseId"], "state": "accepted"}
			metadata["status"], metadata["awaitingHuman"], metadata["pauseId"], metadata["pauseKind"] = "RUNNING", false, nil, nil
			if loseContinuationACK {
				loseContinuationACK = false
				conn, _, _ := w.(http.Hijacker).Hijack()
				_ = conn.Close()
				return
			}
			_ = json.NewEncoder(w).Encode(Object{"accepted": true})
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/galaxy/p13-strategies/"):
			_ = json.NewEncoder(w).Encode(metadata)
		case strings.HasPrefix(r.URL.Path, "/galaxy/runs/"):
			_ = json.NewEncoder(w).Encode(Object{"metadataOnly": true, "run": Object{"runId": nativeRun, "executionId": executionID, "sessionId": rowContext["sessionId"], "componentId": WorkflowID, "componentType": "workflow"}, "strategyWorkflow": metadata})
		default:
			t.Errorf("unexpected workflow path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	client, e = agentos.New(agentos.Configuration{URL: provider.URL, SigningKey: strings.Repeat("s", 32), ServiceKey: strings.Repeat("k", 32)}, agentos.Options{Now: now})
	if e != nil {
		t.Fatal(e)
	}
	strategy.Native = &NativeClient{Client: client}
	handler = Handler{Service: strategy, VerifyService: (agentos.NativeHandler{Client: client}).VerifyService}
	runID := uuid.NewString()
	run, e := strategy.Run(ctx, human, Object{"operationId": runID, "strategyId": selected["id"], "executionId": executionID}, authorize)
	if e != nil || starts != 1 {
		t.Fatalf("actual workflow start %v %#v starts%d", e, run, starts)
	}
	step := Object{"runId": runID, "executionId": executionID, "nativeRunId": nativeRun, "phase": "prepare"}
	code, prepared := private("step", step)
	if code != 200 || prepared["route"] != "code" {
		t.Fatalf("private prepare %d %#v", code, prepared)
	}
	step["phase"] = "effect"
	code, unknown := private("step", step)
	if code != 503 {
		t.Fatalf("unknown effect called success %d %#v", code, unknown)
	}
	code, completed := private("step", step)
	if code != 200 || completed["state"] != "completed" {
		t.Fatalf("same original effect recovery %d %#v", code, completed)
	}
	effect := obj(completed["effect"])
	var audits int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM business_admin_audit_v1 WHERE operation_id=$1`, effect["operationId"]).Scan(&audits); e != nil || audits != 1 {
		t.Fatalf("business effect repeated %d %v", audits, e)
	}
	beforeWrites := writes
	code, replay := private("step", step)
	if code != 200 || !same(replay, completed) || writes != beforeWrites {
		t.Fatal("completed native callback repeated business effect")
	}
	metadata["status"] = "COMPLETED"
	view, e := strategy.RunDetail(ctx, human, runID)
	if e != nil {
		t.Fatal(e)
	}
	publicRead := httptest.NewRequest("GET", "https://admin.example.invalid/v1/operations/strategies/runs/"+runID, nil)
	publicRead.Header.Set("Origin", "https://admin.example.invalid")
	publicRead.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	publicResponse := httptest.NewRecorder()
	handler.ServeHTTP(publicResponse, publicRead)
	var publicView Object
	if e = json.Unmarshal(publicResponse.Body.Bytes(), &publicView); e != nil {
		t.Fatal(e)
	}
	if publicResponse.Code != 200 || !same(view, publicView) {
		t.Fatalf("completed run HTTP projection differs status%d\nDomain%s\nHTTP%s", publicResponse.Code, str(view["state"]), publicResponse.Body.String())
	}
	step["phase"], step["failure"] = "failed", "workflow-failed"
	code, stopped := private("step", step)
	if code != 200 || stopped["state"] != "blocked" || stopped["recovered"] != false {
		t.Fatalf("original automatic stop %d %#v", code, stopped)
	}
	var terminal string
	if e = owner.QueryRow(ctx, `SELECT state FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND id=$2`, endpoint, runID).Scan(&terminal); e != nil || terminal != "completed" {
		t.Fatal("automatic stop changed completed effect")
	}

	publication2 := publicationfixture.Prepare(t, owner, endpoint, now)
	payload2 := obj(publication2["payload"])
	raw2, _ := json.Marshal(payload2)
	if _, e = forum.Publish(ctx, publication2["accounts"].([]any)[0].(string), string(raw2)); e != nil {
		t.Fatal(e)
	}
	secondFixture := seedStrategyExecution(t, currentFixture, str(payload2["postId"]))
	executionID = str(obj(secondFixture["original"])["executionId"])
	humanConfig := deepClone(parsed)
	humanStrategy := obj(list(humanConfig["strategies"])[0])
	humanStrategy["mode"] = "human-led"
	humanStrategy["ordinaryBounds"] = nil
	humanSaved, e := strategy.SaveDraft(ctx, human, Object{"operationId": uuid.NewString(), "expectedRevision": 3, "configuration": humanConfig, "reason": "原人工主导事项"}, authorize)
	if e != nil {
		t.Fatal(e)
	}
	humanRehearsal, e := strategy.Rehearsal(ctx, human, Object{"operationId": uuid.NewString(), "versionId": humanSaved["versionId"], "executionIds": []string{executionID}})
	if e != nil || humanRehearsal["valid"] != true {
		t.Fatalf("human rehearsal %v %#v", e, humanRehearsal)
	}
	if _, e = strategy.Publish(ctx, human, Object{"operationId": uuid.NewString(), "expectedRevision": 4, "versionId": humanSaved["versionId"], "rehearsalId": humanRehearsal["rehearsalId"], "reason": "原人工主导发布"}, authorize); e != nil {
		t.Fatal(e)
	}
	nativeRun = "human-native-run"
	metadata["runId"], metadata["status"], metadata["awaitingHuman"], metadata["pauseId"], metadata["pauseKind"] = nativeRun, "PAUSED", true, "human-native-run:1", "confirmation"
	humanRunID := uuid.NewString()
	if _, e = strategy.Run(ctx, human, Object{"operationId": humanRunID, "strategyId": humanStrategy["id"], "executionId": executionID}, authorize); e != nil {
		t.Fatal(e)
	}
	humanStep := Object{"runId": humanRunID, "executionId": executionID, "nativeRunId": nativeRun, "phase": "prepare"}
	code, humanPrepared := private("step", humanStep)
	if code != 200 || humanPrepared["requiresHuman"] != true {
		t.Fatalf("human prepare %d %#v", code, humanPrepared)
	}
	humanView, e := strategy.RunDetail(ctx, human, humanRunID)
	if e != nil || obj(humanView["run"])["canContinue"] != true {
		t.Fatalf("actual original pause not continuable %v %#v", e, humanView)
	}
	role, e := currentFixture.Permissions.SaveRole(ctx, currentFixture.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Strategy preparation reader", "description": "Review a specific paused run", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"strategies.read", "strategies.run"}})
	if e != nil {
		t.Fatal(e)
	}
	roleID := str(obj(role["role"])["id"])
	if _, e = currentFixture.Permissions.AIWorkAssignment(ctx, currentFixture.Root, "overview", Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": roleID, "enabled": true}); e != nil {
		t.Fatal(e)
	}
	var aiID string
	if e = owner.QueryRow(ctx, `SELECT id::text FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain='overview'`, endpoint).Scan(&aiID); e != nil {
		t.Fatal(e)
	}
	stored, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) {
		return permissions.StoredHumanAIWithin(ctx, tx, human.ID, "overview", aiID, "prepare", "strategies.read")
	})
	if e != nil {
		t.Fatal(e)
	}
	reader := strategy.WithAuthority(&p.BusinessAuthority{Human: permissions.PreparationReader()})
	preparedView, e := reader.RunDetail(ctx, stored, humanRunID)
	if e != nil || obj(preparedView["run"])["canContinue"] != true || obj(preparedView["run"])["capabilityPurpose"] != "human-confirmation-preparation" {
		t.Fatalf("stored prepare eligibility: %v %#v", e, preparedView)
	}
	queryView, e := strategy.QueryRead(ctx, stored, &p.BusinessAuthority{Human: permissions.PreparationReader()}, "strategy-run", humanRunID, nil)
	if e != nil || obj(queryView["run"])["canContinue"] != true || obj(queryView["run"])["capabilityPurpose"] != "human-confirmation-preparation" {
		t.Fatalf("stored prepare QueryRead: %v %#v", e, queryView)
	}
	metadata["status"], metadata["awaitingHuman"] = "RUNNING", false
	preparedView, e = reader.RunDetail(ctx, stored, humanRunID)
	if e != nil || obj(preparedView["run"])["canContinue"] != false {
		t.Fatalf("unpaused run eligible: %v %#v", e, preparedView)
	}
	metadata["status"], metadata["awaitingHuman"] = "PAUSED", true
	if _, e = owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['strategies.read'] WHERE endpoint=$1 AND id=$2`, endpoint, roleID); e != nil {
		t.Fatal(e)
	}
	preparedView, e = reader.RunDetail(ctx, stored, humanRunID)
	if e != nil || obj(preparedView["run"])["canContinue"] != false || obj(preparedView["run"])["continueCode"] != "permission-denied" {
		t.Fatalf("revoked run eligibility: %v %#v", e, preparedView)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['strategies.read','strategies.run'] WHERE endpoint=$1 AND id=$2`, endpoint, roleID); e != nil {
		t.Fatal(e)
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) {
		return permissions.PreparationReader().RequireWithin(ctx, tx, stored, "strategies.run")
	}); e == nil {
		t.Fatal("stored preparation authorized a run write")
	}
	decision := Object{"operationId": uuid.NewString(), "confirmed": true}
	if _, e = strategy.Continue(ctx, human, humanRunID, decision, authorize); e == nil {
		t.Fatal("lost continuation ACK incorrectly known")
	}
	recovered, e := strategy.Continue(ctx, human, humanRunID, decision, authorize)
	if e != nil || obj(recovered["continuation"])["state"] != "accepted" || continuePosts != 1 {
		t.Fatalf("same original pause receipt did not recover %v %#v POST%d", e, recovered, continuePosts)
	}
	humanStep["phase"] = "effect"
	code, humanEffect := private("step", humanStep)
	if code != 200 || humanEffect["state"] != "completed" {
		t.Fatalf("stored human approval did not reach actual effect %d %#v", code, humanEffect)
	}
	executionID = str(obj(executionFixture["original"])["executionId"])
	if _, e = owner.Exec(ctx, `UPDATE operations_automation_grants_v1 SET version=version+1 WHERE id=$1`, obj(executionFixture["grant"])["id"]); e != nil {
		t.Fatal(e)
	}
	if code, _ = private("context", Object{"runId": runID, "executionId": executionID, "operation": "read"}); code != 403 {
		t.Fatalf("revocation disclosed stale original native context %d", code)
	}
}
