// Package autonomyfixture prepares narrow synthetic authorities and strategy
// rows in a disposable test database; worker transitions use Go services.
package autonomyfixture

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"testing"
	"time"
)

type Object = map[string]any

func Setup(t *testing.T, f *operationsfixture.Fixture, automation Object) Object {
	t.Helper()
	ctx := context.Background()
	role, e := f.Permissions.SaveRole(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Isolated autonomy role", "description": "Isolated test", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"feedback.read", "feedback.update"}})
	if e != nil {
		t.Fatal(e)
	}
	_, e = f.Permissions.AIWorkAssignment(ctx, f.Root, "overview", Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true})
	if e != nil {
		t.Fatal(e)
	}
	var assignment string
	if e = f.Pool.QueryRow(ctx, "SELECT id::text FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND role_id=$2", f.Endpoint, role["role"].(map[string]any)["id"]).Scan(&assignment); e != nil {
		t.Fatal(e)
	}
	return Object{"endpoint": f.Endpoint, "aiAccountId": automation["accounts"].(map[string]any)["overview"], "role": role["role"].(map[string]any)["id"], "assignment": assignment}
}
func Operation(t *testing.T, pool *pgxpool.Pool, endpoint, principal, taskID, aiID, targetID, permission string, code bool) Object {
	t.Helper()
	ctx := context.Background()
	now := time.Unix(2000000000, 0)
	if targetID == "" {
		targetID = uuid.NewString()
	}
	if permission == "" {
		permission = "feedback.update"
	}
	grantID, strategyID, versionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	kind, mode, strategyMode := "ai", "ai", "ai-autonomous"
	var ai any = aiID
	if code {
		kind, mode, strategyMode = "program", "code", "code-automatic"
		ai = nil
	}
	if _, e := pool.Exec(ctx, `INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at,ai_account_id,resource_scope_kind) VALUES($1,$2,'Isolated automatic grant',$7,'automatic',true,1,$8,$3,$4,$4,$5,$5,$6,'selected')`, grantID, endpoint, []string{targetID}, principal, now, ai, kind, []string{permission}); e != nil {
		t.Fatal(e)
	}
	domains := []any{}
	for _, domain := range operationsai.Domains {
		domains = append(domains, Object{"key": domain, "objective": nil, "priority": nil, "executionEnabled": domain == "overview"})
	}
	execution := Object{"aiDomain": "overview", "trigger": Object{"kind": "manual", "eventTypes": []any{}}, "mode": mode, "grantIds": []any{grantID}, "resourceScope": Object{"kind": "selected", "resourceIds": []any{targetID}}, "requiredRehearsal": false, "actions": []any{permission}}
	strategy := Object{"id": strategyID, "name": "Isolated bounded strategy", "domain": "overview", "objective": nil, "enabled": true, "mode": strategyMode, "template": "business-action", "execution": execution, "judgment": "prepared-command", "instructions": nil, "condition": nil, "ordinaryBounds": nil, "recovery": Object{"versionId": nil, "conditions": []any{}}}
	configuration := Object{"common": Object{"objective": nil, "automationEnabled": true}, "domains": domains, "strategies": []any{strategy}}
	if _, e := pool.Exec(ctx, `INSERT INTO operations_p13_strategy_versions_v1(id,endpoint,version,configuration,created_by,created_at) VALUES($1,$2,1,$3,$4,$5)`, versionID, endpoint, configuration, principal, now); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `INSERT INTO operations_p13_strategy_heads_v1(endpoint,revision,active_id,paused,updated_at) VALUES($1,1,$2,false,$3)`, endpoint, versionID, now); e != nil {
		t.Fatal(e)
	}
	plan := Object{"strategyIds": []any{strategyID}, "grantIds": []any{grantID}, "actions": []any{permission}, "resourceIds": []any{targetID}, "eventTypes": []any{}}
	bindings := Object{"grants": []any{Object{"id": grantID, "version": 1}}, "strategyVersionId": versionID}
	if _, e := pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET mode=$6,state='running',human_decision=NULL,lease_until=$3,configuration=jsonb_set(jsonb_set(configuration,'{plan}',$4::jsonb),'{versionBindings}',$5::jsonb) WHERE endpoint=$1 AND id=$2`, endpoint, taskID, now.Add(10*time.Minute), plan, bindings, mode); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, "UPDATE operations_ai_work_assignments_v1 SET enabled=true WHERE endpoint=$1", endpoint); e != nil {
		t.Fatal(e)
	}
	return Object{"grantId": grantID, "strategyId": strategyID, "versionId": versionID, "targetId": targetID}
}
