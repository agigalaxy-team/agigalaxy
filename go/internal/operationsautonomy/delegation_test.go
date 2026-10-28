package operationsautonomy_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
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
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRealDutyDelegatedAIOnlyRoleAndPromptOriginalInterop(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	encode := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	node := func(script, mode string, input a.Object) a.Object {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/"+script), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		if input != nil {
			cmd.Stdin = strings.NewReader(encode(input))
		}
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original %s %v %s", mode, e, out)
		}
		var o a.Object
		if json.Unmarshal(out, &o) != nil {
			t.Fatal("invalid source fixture result")
		}
		return o
	}
	base := node("operations-permissions-interop.mjs", "setup", nil)
	fixture := node("operations-permissions-interop.mjs", "automation-setup", nil)
	node("operations-permissions-interop.mjs", "delegated-setup", nil)
	endpoint := base["endpoint"].(string)
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
	original := func(method string, input a.Object) a.Object {
		return node("operations-autonomy-interop.mjs", "duty-delegated", a.Object{"endpoint": endpoint, "taskId": taskID, "method": method, "input": input})
	}
	eq := func(label string, v, w any) {
		t.Helper()
		normalize := func(v any) any { var o any; json.Unmarshal([]byte(encode(v)), &o); return o }
		if !reflect.DeepEqual(normalize(v), normalize(w)) {
			t.Fatalf("%s\nGo%s\nJS%s", label, encode(v), encode(w))
		}
	}
	directory, e := permissions.DelegatedDirectory(ctx, actor)
	if e != nil {
		t.Fatal(e)
	}
	eq("real duty delegation directory", directory, original("directory", nil))
	roleInput := a.Object{"operationId": uuid.NewString(), "kind": "role-create", "expectedVersion": 0, "name": "Real duty bounded role", "description": "No human permission source", "enabled": true, "permissions": []any{"feedback.read"}, "targetAiAccountIds": []any{targetID}}
	saved, e := permissions.DelegatedRoleSave(ctx, actor, roleInput, p.DelegatedOptions{})
	if e != nil {
		t.Fatal(e)
	}
	js := original("role", roleInput)
	js["replayed"] = false
	eq("original replays actual duty role", saved, js)
	prompt, e := permissions.DelegatedPrompt(ctx, actor, a.Object{"aiAccountId": targetID})
	if e != nil {
		t.Fatal(e)
	}
	eq("real duty prompt read", prompt, original("prompt", a.Object{"aiAccountId": targetID}))
	promptMeta := prompt["prompt"].(map[string]any)
	promptInput := a.Object{"operationId": uuid.NewString(), "aiAccountId": targetID, "expectedRevision": promptMeta["revision"], "expectedPromptVersion": promptMeta["promptVersion"], "prompt": "True task-bound prompt"}
	saved, e = permissions.DelegatedPromptSave(ctx, actor, promptInput, p.DelegatedOptions{})
	if e != nil {
		t.Fatal(e)
	}
	js = original("savePrompt", promptInput)
	js["replayed"] = false
	eq("original replays actual duty prompt", saved, js)
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
	eq("private current task authorize", result, node("operations-autonomy-interop.mjs", "private", a.Object{"endpoint": endpoint, "method": "authorize", "input": a.Object{"taskId": taskID, "operation": "tool"}}))
	toolRole := a.Object{"kind": "role-create", "expectedVersion": 0, "name": "Private duty tool role", "description": "Server original intent", "enabled": true, "permissions": []any{"feedback.read"}, "targetAiAccountIds": []any{targetID}}
	toolInput := a.Object{"taskId": taskID, "callId": uuid.NewString(), "tool": "manage-ai-role", "arguments": toolRole}
	status, result = post("tools/execute", toolInput, true)
	if status != 200 || result["state"] != "completed" {
		t.Fatalf("tool%d %s", status, encode(result))
	}
	js = node("operations-autonomy-interop.mjs", "private", a.Object{"endpoint": endpoint, "method": "tool", "input": toolInput})
	js["replayed"] = false
	eq("original resolves server-owned tool operation", result, js)
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
