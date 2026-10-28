package operationsautonomy

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOriginalWorkbenchLedgerAndCurrentDuty(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	node := func(mode string, input Object) Object {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/operations-autonomy-interop.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		cmd.Stdin = strings.NewReader(jsonText(input))
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original %s %v %s", mode, e, out)
		}
		var o Object
		if json.Unmarshal(out, &o) != nil {
			t.Fatal("invalid fixture result")
		}
		return o
	}
	base := node("setup", Object{})
	endpoint, aiID := str(base["endpoint"]), str(base["aiAccountId"])
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(2000000000, 0) }
	service := &Service{Pool: pool, Endpoint: endpoint, AIWork: &operationsai.Service{Endpoint: endpoint}, Now: now}
	id, conversationID, sessionID, operatorID := uuid.NewString(), uuid.NewString(), uuid.NewString(), strings.Repeat("a", 64)
	nativeRun := "native-run"
	in := WorkbenchLink{OperationID: id, Domain: "overview", AIAccountID: aiID, ConversationID: &conversationID, SessionID: &sessionID, OperatorID: &operatorID, NativeRunID: &nativeRun}
	row, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.LinkWorkbenchWithin(ctx, tx, in) })
	if e != nil {
		t.Fatal(e)
	}
	js := node("link", Object{"operationId": id, "domain": "overview", "aiAccountId": aiID, "conversationId": conversationID, "sessionId": sessionID, "operatorId": operatorID, "nativeRunId": nativeRun})
	projection := func(row Object) Object {
		o := Object{}
		for _, k := range []string{"id", "source", "mode", "state", "model_state", "business_state", "configuration", "ai_account_id", "model_usage", "native_run_id", "prompt_version", "plan_version"} {
			o[k] = row[k]
		}
		return o
	}
	eq := func(label string, a, b any) {
		t.Helper()
		normalize := func(v any) any { var o any; json.Unmarshal([]byte(jsonText(v)), &o); return o }
		if !reflect.DeepEqual(normalize(a), normalize(b)) {
			t.Fatalf("%s\nGo%s\nJS%s", label, jsonText(a), jsonText(b))
		}
	}
	eq("original original-ID workbench replay", projection(row), projection(js))
	turn := uuid.NewString()
	bind := WorkbenchBind{TaskID: id, OperatorID: operatorID, Domain: "overview", AIAccountID: aiID, TurnOperationID: turn, ConversationID: &conversationID, SessionID: &sessionID}
	bound, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.BindWorkbenchTaskWithin(ctx, tx, bind) })
	if e != nil {
		t.Fatal(e)
	}
	eq("bind", bound, node("bind", Object{"taskId": id, "operatorId": operatorID, "domain": "overview", "aiAccountId": aiID, "turnOperationId": turn, "conversationId": conversationID, "sessionId": sessionID}))
	wrong := bind
	wrong.OperatorID = strings.Repeat("b", 64)
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.BindWorkbenchTaskWithin(ctx, tx, wrong) }); fault.Code(e) != "operations_autonomy_scope_denied" {
		t.Fatalf("owner %v", e)
	}
	status, model := "running", "running"
	nativeRun = "native-next-turn"
	usage := Object{"calls": 2, "inputTokens": 3, "outputTokens": 4, "totalTokens": 7, "durationMs": 10}
	update := WorkbenchUpdate{OperationID: id, TurnOperationID: &turn, NativeRunID: &nativeRun, Status: &status, ModelState: &model, Usage: usage}
	row, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.UpdateWorkbenchWithin(ctx, tx, update) })
	if e != nil {
		t.Fatal(e)
	}
	js = node("update", Object{"operationId": id, "turnOperationId": turn, "nativeRunId": nativeRun, "status": status, "modelState": model, "usage": usage})
	eq("replacing same native usage does not double count", projection(row), projection(js))
	// Same task becomes a routine only in the isolated fixture, to check the
	// original current duty gate against persisted config/task/lease and AI roles.
	admin, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer admin.Close()
	if _, e = admin.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e = admin.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',mode='ai',lease_until=$3,state='running' WHERE endpoint=$1 AND id=$2`, endpoint, id, time.Unix(2000000600, 0)); e != nil {
		t.Fatal(e)
	}
	actor, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) { return service.DutyForTaskWithin(ctx, tx, id, "query") })
	if e != nil {
		t.Fatal(e)
	}
	metadata, e := service.DutyMetadata(actor)
	if e != nil {
		t.Fatal(e)
	}
	eq("original real duty actor", Object{"metadata": metadata, "id": actor.ID, "role": nil, "version": actor.Version, "permissions": actor.Permissions}, node("duty", Object{"taskId": id}))
	if _, e = service.DutyMetadata(Actor{ID: actor.ID, Endpoint: endpoint, Permissions: actor.Permissions}); fault.Code(e) != "business_admin_denied" {
		t.Fatal("public actor forged duty")
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) {
		return service.RequireDutyAction(ctx, tx, actor, "feedback.update", "")
	}); fault.Code(e) != "operations_permission_denied" {
		t.Fatalf("query write gate %v", e)
	}
	if _, e = admin.Exec(ctx, `UPDATE operations_ai_work_assignments_v1 SET enabled=false WHERE endpoint=$1 AND id=$2`, endpoint, base["assignment"]); e != nil {
		t.Fatal(e)
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) { return service.RequireDutyAction(ctx, tx, actor, "feedback.read", "") }); fault.Code(e) != "operations_permission_denied" {
		t.Fatalf("current role revoke %v", e)
	}
	if _, e = admin.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='paused' WHERE endpoint=$1 AND id=$2`, endpoint, id); e != nil {
		t.Fatal(e)
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) { return service.RequireDutyAction(ctx, tx, actor, "workbench.read", "") }); fault.Code(e) != "operations_autonomy_task_inactive" {
		t.Fatalf("task stop gate %v", e)
	}
	continuation, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.TaskContinuationWithin(ctx, tx, id) })
	if e != nil {
		t.Fatal(e)
	}
	eq("no model-only continuation", continuation, node("continuation", Object{"taskId": id}))
	var enabled int
	if e = admin.QueryRow(ctx, `SELECT count(*) FROM operations_autonomy_configs_v1 WHERE endpoint=$1 AND domain<>'overview' AND enabled`, endpoint).Scan(&enabled); e != nil || enabled != 0 {
		t.Fatalf("default enabled plans %d %v", enabled, e)
	}
	policy := node("operation-setup", Object{"taskId": id, "aiAccountId": aiID})
	operationID := uuid.NewString()
	request := Object{"kind": "feedback-update", "targetId": policy["targetId"]}
	command := Object{"state": "acknowledged", "note": "Original bounded note"}
	operation := DutyOperation{Permission: "feedback.update", TargetID: str(policy["targetId"]), OperationID: operationID, Request: request, Command: command}
	boundActor, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) {
		a, e := service.DutyForTaskWithin(ctx, tx, id, "query")
		if e != nil {
			return Actor{}, e
		}
		return service.BindDutyOperationWithin(ctx, tx, a, operation)
	})
	if e != nil {
		t.Fatal(e)
	}
	boundMeta, e := service.DutyMetadata(boundActor)
	if e != nil {
		t.Fatal(e)
	}
	selection := Object{"id": policy["targetId"], "operationId": operationID, "command": command}
	businessAction := "feedback-update"
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) {
		return service.RequireDutyOperation(ctx, tx, boundActor, []string{"feedback.update"}, selection, &businessAction)
	}); e != nil {
		t.Fatal(e)
	}
	eq("original bounded grant and strategy authority", boundMeta, node("operation", Object{"taskId": id, "operation": operationObject(operation), "selection": selection}))
	wrongSelection := Object{"id": policy["targetId"], "operationId": operationID, "command": Object{"state": "invented"}}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) {
		return service.RequireDutyOperation(ctx, tx, boundActor, []string{"feedback.update"}, wrongSelection, &businessAction)
	}); fault.Code(e) != "operations_ai_duty_operation_denied" {
		t.Fatalf("command pin %v", e)
	}
	if _, e = admin.Exec(ctx, `UPDATE operations_automation_grants_v1 SET version=version+1 WHERE endpoint=$1 AND id=$2`, endpoint, policy["grantId"]); e != nil {
		t.Fatal(e)
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) {
		return service.RequireDutyOperation(ctx, tx, boundActor, []string{"feedback.update"}, selection, &businessAction)
	}); fault.Code(e) != "operations_autonomy_authorization_changed" {
		t.Fatalf("frozen grant %v", e)
	}
	if _, e = admin.Exec(ctx, `UPDATE operations_automation_grants_v1 SET version=1 WHERE endpoint=$1 AND id=$2`, endpoint, policy["grantId"]); e != nil {
		t.Fatal(e)
	}
	if _, e = admin.Exec(ctx, `UPDATE operations_p13_strategy_heads_v1 SET paused=true WHERE endpoint=$1`, endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) {
		return service.RequireDutyOperation(ctx, tx, boundActor, []string{"feedback.update"}, selection, &businessAction)
	}); fault.Code(e) != "operations_autonomy_strategy_stopped" {
		t.Fatalf("strategy current stop %v", e)
	}
}
