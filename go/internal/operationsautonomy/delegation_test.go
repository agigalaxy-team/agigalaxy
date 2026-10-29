package operationsautonomy_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRealDutyDelegatedAIOnlyRoleAndPromptOriginalInterop(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	encode := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	f := operationsfixture.New(t, owner)
	fixture := f.Automation(t)
	f.Delegated(t)
	endpoint := f.Endpoint
	accounts := fixture["accounts"].(map[string]any)
	sourceID, targetID := accounts["overview"].(string), accounts["governance"].(string)
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(2000000000, 0) }
	service := &a.Service{Pool: pool, Endpoint: endpoint, AIWork: &operationsai.Service{Endpoint: endpoint}, Now: now}
	permissions := &p.Service{Pool: pool, Endpoint: endpoint, AIWork: service.AIWork, Duty: service, Now: now}
	service.Permissions = permissions
	taskID := uuid.NewString()
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (a.Object, error) {
		return service.LinkWorkbenchWithin(ctx, tx, a.WorkbenchLink{OperationID: taskID, Domain: "overview", AIAccountID: sourceID})
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
	if _, e = admin.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',mode='ai',state='running',lease_until=$3,configuration=jsonb_set(configuration,'{plan,actions}','["ai.roles.read","ai.roles.create","ai.roles.update","ai.roles.assign","ai.roles.revoke","ai.prompts.read","ai.prompts.update"]') WHERE endpoint=$1 AND id=$2`, endpoint, taskID, time.Unix(2000000600, 0)); e != nil {
		t.Fatal(e)
	}
	actor, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (a.Actor, error) { return service.DutyForTaskWithin(ctx, tx, taskID, "query") })
	if e != nil {
		t.Fatal(e)
	}
	directory, e := permissions.DelegatedDirectory(ctx, actor)
	if e != nil {
		t.Fatal(e)
	}
	if directory["availability"] == nil {
		t.Fatal("delegated directory unavailable")
	}
	roleInput := a.Object{"operationId": uuid.NewString(), "kind": "role-create", "expectedVersion": 0, "name": "Real duty bounded role", "description": "No human permission source", "enabled": true, "permissions": []any{"feedback.read"}, "targetAiAccountIds": []any{targetID}}
	saved, e := permissions.DelegatedRoleSave(ctx, actor, roleInput, p.DelegatedOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if saved == nil {
		t.Fatal("delegated role missing")
	}
	replay, e := permissions.DelegatedRoleSave(ctx, actor, roleInput, p.DelegatedOptions{})
	if e != nil || replay["replayed"] != true {
		t.Fatal("delegated role receipt replay", e)
	}
	prompt, e := permissions.DelegatedPrompt(ctx, actor, a.Object{"aiAccountId": targetID})
	if e != nil {
		t.Fatal(e)
	}
	if prompt["prompt"] == nil {
		t.Fatal("delegated prompt unavailable")
	}
	promptMeta := prompt["prompt"].(map[string]any)
	promptInput := a.Object{"operationId": uuid.NewString(), "aiAccountId": targetID, "expectedRevision": promptMeta["revision"], "expectedPromptVersion": promptMeta["promptVersion"], "prompt": "True task-bound prompt"}
	saved, e = permissions.DelegatedPromptSave(ctx, actor, promptInput, p.DelegatedOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if saved == nil {
		t.Fatal("prompt write missing")
	}
	replay, e = permissions.DelegatedPromptSave(ctx, actor, promptInput, p.DelegatedOptions{})
	if e != nil || replay["replayed"] != true {
		t.Fatal("prompt receipt replay", e)
	}
	var humanWriter *string
	var aiWriter, actorKind string
	var auditRole *string
	var contextJSON []byte
	if e = pool.QueryRow(ctx, `SELECT r.created_by,r.created_by_ai_account_id::text,a.actor_kind,a.operator_role,a.actor_context FROM operations_business_roles_v1 r JOIN business_admin_audit_v1 a ON a.endpoint=r.endpoint AND a.operation_id=$2 WHERE r.endpoint=$1 AND r.id=$2`, endpoint, roleInput["operationId"]).Scan(&humanWriter, &aiWriter, &actorKind, &auditRole, &contextJSON); e != nil {
		t.Fatal(e)
	}
	if humanWriter != nil || aiWriter != sourceID || actorKind != "operations-ai-service" || auditRole != nil {
		t.Fatal("AI role writer fabricated a human principal")
	}
	var audit a.Object
	json.Unmarshal(contextJSON, &audit)
	if audit["taskId"] != taskID || audit["aiAccountId"] != sourceID {
		t.Fatal("real task provenance missing")
	}
	// Real private service verification happens before parsing; task identity and
	// operation IDs come from the durable task/tool rows, never request actors.
	client, e := agentos.New(agentos.Configuration{URL: "http://127.0.0.1:1", SigningKey: strings.Repeat("s", 32), ServiceKey: strings.Repeat("v", 32)}, agentos.Options{})
	if e != nil {
		t.Fatal(e)
	}
	nativeHandler := agentos.NativeHandler{Client: client}
	api := httptest.NewServer(a.PrivateHandler{Service: service, VerifyService: nativeHandler.VerifyService})
	defer api.Close()
	post := func(path string, input any, authorized bool) (int, a.Object) {
		t.Helper()
		r, _ := http.NewRequest("POST", api.URL+"/v1/internal/agentos/autonomy/"+path, strings.NewReader(encode(input)))
		r.Header.Set("Content-Type", "application/json")
		if authorized {
			r.Header.Set("Authorization", "Bearer "+strings.Repeat("v", 32))
		}
		response, e := api.Client().Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		var out a.Object
		if json.NewDecoder(response.Body).Decode(&out) != nil {
			t.Fatal("invalid HTTP result")
		}
		return response.StatusCode, out
	}
	status, result := post("authorize", a.Object{"taskId": taskID, "operation": "tool"}, false)
	if status != 403 || result["error"] != "operations_agentos_service_denied" {
		t.Fatalf("private auth%d %s", status, encode(result))
	}
	status, result = post("authorize", a.Object{"taskId": taskID, "operation": "tool"}, true)
	if status != 200 {
		t.Fatalf("authorize%d %s", status, encode(result))
	}
	if result["allowed"] != true || result["task"] == nil {
		t.Fatal("private task authority missing")
	}
	toolRole := a.Object{"kind": "role-create", "expectedVersion": 0, "name": "Private duty tool role", "description": "Server original intent", "enabled": true, "permissions": []any{"feedback.read"}, "targetAiAccountIds": []any{targetID}}
	toolInput := a.Object{"taskId": taskID, "callId": uuid.NewString(), "tool": "manage-ai-role", "arguments": toolRole}
	status, result = post("tools/execute", toolInput, true)
	if status != 200 || result["state"] != "completed" {
		t.Fatalf("tool%d %s", status, encode(result))
	}
	status, replayed := post("tools/execute", toolInput, true)
	if status != 200 || replayed["replayed"] != true || replayed["operationId"] != result["operationId"] {
		t.Fatal("private operation did not replay", status, replayed)
	}
	var receiptCount int
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3`, endpoint, taskID, result["operationId"]).Scan(&receiptCount); e != nil || receiptCount != 1 {
		t.Fatalf("original receipt count %d %v", receiptCount, e)
	}
	var judgment *string
	if e = pool.QueryRow(ctx, `SELECT actor_context->>'judgmentKind' FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2`, endpoint, result["operationId"]).Scan(&judgment); e != nil || judgment != nil {
		t.Fatalf("unbound native run invented judgment %v %v", judgment, e)
	}
	if _, e = admin.Exec(ctx, `UPDATE operations_ai_role_delegations_v1 SET version=version+1 WHERE endpoint=$1 AND source_ai_account_id=$2`, endpoint, sourceID); e != nil {
		t.Fatal(e)
	}
	if _, e = permissions.DelegatedDirectory(ctx, actor); fault.Code(e) != "operations_ai_delegation_denied" {
		t.Fatalf("pinned delegation changed %v", e)
	}
}
