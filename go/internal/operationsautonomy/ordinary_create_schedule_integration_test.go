package operationsautonomy_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/publicationfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ordinaryPublicationAuthority struct{}

func (ordinaryPublicationAuthority) Account(context.Context, pgx.Tx, string, string) error {
	return nil
}

type noStrategyRead struct{ p.Authority }

func (a noStrategyRead) RequireWithin(ctx context.Context, tx pgx.Tx, actor p.Actor, action string) (p.Actor, error) {
	if action == "strategies.read" {
		return p.Actor{}, fault.New("operations_permission_denied", 403)
	}
	return a.Authority.RequireWithin(ctx, tx, actor, action)
}

func TestOrdinaryCreatedStrategySchedulesOriginalAuthorizedBusinessOperation(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	base := autonomyfixture.Setup(t, f, automation)
	clock := time.Unix(2000000000, 0)
	now := func() time.Time { return clock }
	work := &operationsai.Service{Endpoint: f.Endpoint}
	duty := &a.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, AIWork: work, Now: now, EnqueueWithin: func(context.Context, pgx.Tx, string, a.Object, string, *time.Time) error { return nil }}
	permissions := &p.Service{Pool: f.Pool, Endpoint: f.Endpoint, AIWork: work, Duty: duty, Now: now}
	strategy := &operationsstrategies.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: &p.BusinessAuthority{Duty: duty}, Duty: duty, Autonomy: duty, Now: now}
	duty.OriginalStrategyArtifactWithin = strategy.OriginalCreationArtifactWithin
	forum := &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: ordinaryPublicationAuthority{}, Now: now, OperationsHandling: true}
	content := &operationscommunity.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: &p.BusinessAuthority{Duty: duty}, Forum: forum, Now: now}
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: permissions, Autonomy: duty, Strategies: strategy, Content: content, Now: now}
	duty.Permissions, duty.ActionReady, duty.QualifyTargetWithin, duty.ExecuteDutyOperation = permissions, service.ActionReady, service.QualifyTargetWithin, service.ExecuteDutyOperation
	publication := publicationfixture.Prepare(t, f.Pool, f.Endpoint, now)
	payload := publication["payload"].(community.Object)
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = forum.Publish(ctx, publication["accounts"].([]any)[0].(string), string(raw)); err != nil {
		t.Fatal(err)
	}
	target, source, task := payload["postId"].(string), uuid.NewString(), uuid.NewString()
	strategy.ActionReady = func(code, mode string) bool {
		return mode != "code" && (code == "content.read" || code == "content.hide" || code == "content.restore")
	}
	strategy.PreviewObjectWithin = func(ctx context.Context, tx pgx.Tx, _ p.Actor, kind, id string) (a.Object, error) {
		if kind != "content-visibility" {
			return a.Object{"available": false, "version": nil}, nil
		}
		v, e := forum.OperationsContentSourceWithin(ctx, tx, "post", id, false)
		if e != nil {
			return nil, e
		}
		head := v["head"].(map[string]any)
		source := v["source"].(map[string]any)
		return a.Object{"kind": "post", "available": v["available"], "version": source["id"], "revision": head["head_version"]}, nil
	}
	if _, err = postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (a.Object, error) {
		return duty.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: task, Domain: "overview", AIAccountID: base["aiAccountId"].(string)})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine' WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); err != nil {
		t.Fatal(err)
	}
	policy := autonomyfixture.Operation(t, owner, f.Endpoint, f.IDs["root"], task, base["aiAccountId"].(string), source, "strategies.ordinary.configure", false)
	if _, err = owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['strategies.read','strategies.ordinary.configure','strategies.ordinary.publish','content.read','content.hide'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, base["role"]); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_automation_grants_v1 SET permissions=ARRAY['strategies.ordinary.configure','strategies.ordinary.publish','content.hide'],resource_ids=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["grantId"], []string{source, target}); err != nil {
		t.Fatal(err)
	}
	var cfg a.Object
	if err = owner.QueryRow(ctx, `SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["versionId"]).Scan(&cfg); err != nil {
		t.Fatal(err)
	}
	strategies := cfg["strategies"].([]any)
	cfg["common"].(map[string]any)["objective"] = "Approved objective"
	for _, value := range cfg["domains"].([]any) {
		domain := value.(map[string]any)
		if domain["key"] == "overview" {
			domain["objective"] = "Approved domain"
		}
	}
	manager := strategies[0].(map[string]any)
	manager["execution"].(map[string]any)["actions"] = []any{"strategies.ordinary.configure", "strategies.ordinary.publish"}
	execution := a.Object{"aiDomain": "overview", "trigger": a.Object{"kind": "interval", "minutes": 5, "eventTypes": []any{}}, "mode": "ai", "grantIds": []any{policy["grantId"]}, "resourceScope": a.Object{"kind": "selected", "resourceIds": []any{target}}, "requiredRehearsal": false, "actions": []any{"content.hide"}}
	sourceStrategy := a.Object{"id": source, "name": "Synthetic source", "domain": "overview", "objective": "Approved strategy", "enabled": false, "mode": "ai-autonomous", "template": "business-action", "execution": execution, "judgment": "prepared-command", "instructions": nil, "condition": nil, "ordinaryBounds": a.Object{"parameters": []any{}, "modes": []any{"ai-autonomous"}, "canEnable": true, "canDisable": true, "canCreate": true}, "recovery": a.Object{"versionId": nil, "conditions": []any{}}}
	cfg["strategies"] = append(strategies, sourceStrategy)
	if _, err = owner.Exec(ctx, `UPDATE operations_p13_strategy_versions_v1 SET configuration=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["versionId"], cfg); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET configuration=jsonb_set(configuration,'{plan,actions}','["strategies.ordinary.configure","strategies.ordinary.publish"]'::jsonb) WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); err != nil {
		t.Fatal(err)
	}
	actor, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (a.Actor, error) { return duty.DutyForTaskWithin(ctx, tx, task, "query") })
	if err != nil {
		t.Fatal(err)
	}
	createID := uuid.NewString()
	created, err := service.ExecuteDutyOperation(ctx, actor, createID, a.Object{"kind": "ordinary-strategy-create-draft", "sourceStrategyId": source, "sourceVersionId": policy["versionId"], "expectedRevision": 1, "name": "Synthetic new strategy", "reason": "Approved source", "enabled": true}, false)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	createdReceipt := created["receipt"].(map[string]any)
	newID := createdReceipt["newStrategyId"].(string)
	versionID := createdReceipt["versionId"].(string)
	if newID == source || newID == createID || createdReceipt["sourceStrategyId"] != source {
		t.Fatalf("source/new binding %#v", createdReceipt)
	}
	readOwnArtifacts := func(caller a.Actor, taskID string) (a.Object, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (a.Object, error) { return duty.DutyStrategyArtifactsWithin(ctx, tx, caller, taskID) })
	}
	own, err := readOwnArtifacts(actor, task)
	if err != nil || own["availability"] != "available" || own["currentPublishEligibility"] != "not-checked" {
		t.Fatalf("duty original artifact %#v %v", own, err)
	}
	items := own["items"].([]a.Object)
	if len(items) != 1 || items[0]["operationId"] != createID || items[0]["sourceStrategyId"] != source || items[0]["newStrategyId"] != newID || items[0]["versionId"] != versionID {
		t.Fatalf("duty artifact identity %#v", own)
	}
	summary, err := duty.Tool(ctx, a.Object{"taskId": task, "nativeRunId": "synthetic-run", "callId": uuid.NewString(), "tool": "current-summary", "arguments": a.Object{}}, false)
	if err != nil {
		t.Fatalf("duty current-summary: %v", err)
	}
	summaryArtifacts, ok := summary["strategyArtifacts"].(map[string]any)
	if !ok || summaryArtifacts["availability"] != "available" || summaryArtifacts["currentPublishEligibility"] != "not-checked" {
		t.Fatalf("summary original artifacts %#v", summary)
	}
	summaryItems, ok := summaryArtifacts["items"].([]a.Object)
	if !ok || len(summaryItems) != 1 || summaryItems[0]["operationId"] != createID || summaryItems[0]["sourceStrategyId"] != source || summaryItems[0]["sourceVersionId"] != policy["versionId"] || summaryItems[0]["newStrategyId"] != newID || summaryItems[0]["versionId"] != versionID {
		t.Fatalf("summary artifact identity %#v", summaryArtifacts)
	}
	if _, err = readOwnArtifacts(actor, uuid.NewString()); err == nil {
		t.Fatal("cross-task artifact accepted")
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['strategies.ordinary.configure','strategies.ordinary.publish','content.read','content.hide'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, base["role"]); err != nil {
		t.Fatal(err)
	}
	own, err = readOwnArtifacts(actor, task)
	if err != nil || own["availability"] != "not-authorized" || len(own["items"].([]a.Object)) != 0 {
		t.Fatalf("revoked duty read %#v %v", own, err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['strategies.read','strategies.ordinary.configure','strategies.ordinary.publish','content.read','content.hide'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, base["role"]); err != nil {
		t.Fatal(err)
	}
	view, err := duty.GetTask(ctx, f.Root, task)
	if err != nil {
		t.Fatalf("original task artifact: %v", err)
	}
	artifactSet := view["task"].(map[string]any)["strategyArtifacts"].(map[string]any)
	artifacts := artifactSet["items"].([]a.Object)
	if artifactSet["availability"] != "available" || len(artifacts) != 1 || artifacts[0]["operationId"] != createID || artifacts[0]["newStrategyId"] != newID || artifacts[0]["sourceStrategyId"] != source || artifacts[0]["sourceVersionId"] != policy["versionId"] || artifacts[0]["versionId"] != versionID {
		t.Fatalf("task artifact mismatch %#v", artifactSet)
	}
	duty.Authority = noStrategyRead{Authority: f.Gateway}
	if _, err = duty.GetTask(ctx, f.Root, task); fault.Status(err) != 403 {
		t.Fatalf("source read revocation accepted: %v", err)
	}
	duty.Authority = f.Gateway
	if _, err = service.ExecuteDutyOperation(ctx, actor, uuid.NewString(), a.Object{"kind": "ordinary-strategy-publish", "strategyId": source, "versionId": versionID}, false); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='completed',lease_until=NULL WHERE endpoint=$1 AND id=$2`, f.Endpoint, task); err != nil {
		t.Fatal(err)
	}
	if _, err = databaseschema.Migrate(ctx, owner, []string{"worker"}); err != nil {
		t.Fatal(err)
	}
	workerConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	workerConfig.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, err := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return err
	}
	workerPool, err := pgxpool.NewWithConfig(ctx, workerConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer workerPool.Close()
	workerService := &a.Service{Pool: workerPool, Endpoint: f.Endpoint, AIWork: work, Now: now, EnqueueWithin: func(context.Context, pgx.Tx, string, a.Object, string, *time.Time) error { return nil }}
	worker := a.NewWorker(workerService)
	if _, err = worker.Tick(ctx); err != nil {
		t.Fatalf("initialize schedule: %v", err)
	}
	clock = clock.Add(6 * time.Minute)
	if _, err = worker.Tick(ctx); err != nil {
		t.Fatalf("due schedule: %v", err)
	}
	var nextID string
	var frozen a.Object
	if err = owner.QueryRow(ctx, `SELECT id::text,configuration FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND source_key LIKE $2`, f.Endpoint, "strategy-due:"+newID+":%").Scan(&nextID, &frozen); err != nil {
		t.Fatalf("scheduled original strategy ID: %v", err)
	}
	plan := frozen["plan"].(map[string]any)
	ids := plan["strategyIds"].([]any)
	if len(ids) != 1 || ids[0] != newID || frozen["versionBindings"].(map[string]any)["strategyVersionId"] != versionID {
		t.Fatalf("scheduled binding %#v", frozen)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='running',dispatch_started_at=$3,lease_until=$4,native_run_id='synthetic-run' WHERE endpoint=$1 AND id=$2`, f.Endpoint, nextID, now(), now().Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	result, err := duty.Tool(ctx, a.Object{"taskId": nextID, "nativeRunId": "synthetic-run", "callId": uuid.NewString(), "tool": "execute-operation", "arguments": a.Object{"kind": "content-visibility", "targetKind": "post", "targetId": target, "action": "hide", "reason": "Synthetic authorized test", "until": now().Add(30 * time.Minute).Unix()}}, false)
	if err != nil {
		t.Fatalf("scheduled business operation: %v", err)
	}
	if result["state"] != "completed" || result["businessReceipt"].(map[string]any)["state"] != "completed" {
		t.Fatalf("business receipt %#v", result)
	}
	var operationID string
	if err = owner.QueryRow(ctx, `SELECT operation_id::text FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 AND target_id=$3 AND state='completed'`, f.Endpoint, nextID, target).Scan(&operationID); err != nil {
		t.Fatalf("original operation receipt: %v", err)
	}
	if operationID != result["operationId"] {
		t.Fatal("receipt operation changed")
	}
}
