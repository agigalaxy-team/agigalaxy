package operationsfixture

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (f *Fixture) Automation(t *testing.T) Object {
	t.Helper()
	ctx := context.Background()
	accounts := Object{}
	for _, domain := range operationsai.Domains {
		id := uuid.NewString()
		accounts[domain] = id
		if _, err := f.owner.Exec(ctx, `INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,$3,$4,'Synthetic isolated test',true,1,1,$5,$5)`, id, f.Endpoint, domain, "Synthetic "+domain, f.Now()); err != nil {
			t.Fatal(err)
		}
	}
	role, err := f.Permissions.SaveRole(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Synthetic AI business role", "description": "No inherited human rights", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"feedback.read", "feedback.update"}})
	if err != nil {
		t.Fatal(err)
	}
	roleValue := role["role"].(map[string]any)
	if _, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "governance", Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": roleValue["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	resource := uuid.NewString()
	originalInput := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Original program", "executorKind": "program", "mode": "assisted", "enabled": true, "permissions": []any{"feedback.read"}, "resourceIds": []any{resource}}
	original, err := f.Permissions.SaveAutomation(ctx, f.Root, originalInput)
	if err != nil {
		t.Fatal(err)
	}
	delegationInput := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "enabled": true, "targetAiAccountIds": []any{accounts["governance"]}, "grantablePermissions": []any{"feedback.read", "feedback.update"}, "allowedManagementActions": []any{"read", "create", "update", "assign", "revoke", "prompt-read", "prompt-update"}}
	delegation, err := f.Permissions.SaveDelegation(ctx, f.Root, delegationInput)
	if err != nil {
		t.Fatal(err)
	}
	return Object{"accounts": accounts, "resource": resource, "role": roleValue, "originalInput": originalInput, "original": original, "delegationInput": delegationInput, "delegation": delegation}
}

func (f *Fixture) Delegated(t *testing.T) Object {
	t.Helper()
	ctx := context.Background()
	role, err := f.Permissions.SaveRole(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Synthetic overview current role", "description": "Explicit AI management actions", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"ai.roles.read", "ai.roles.create", "ai.roles.update", "ai.roles.assign", "ai.roles.revoke", "ai.prompts.read", "ai.prompts.update"}})
	if err != nil {
		t.Fatal(err)
	}
	roleValue := role["role"].(map[string]any)
	if _, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "overview", Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": roleValue["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	accounts := map[string]Object{}
	rows, err := f.Pool.Query(ctx, "SELECT id::text,domain FROM operations_ai_work_accounts_v1 WHERE endpoint=$1", f.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, domain string
		if err = rows.Scan(&id, &domain); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		accounts[domain] = Object{"id": id, "domain": domain}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	configuration := Object{"prompt": "Original synthetic prompt", "model": Object{"retained": "unchanged"}, "plan": Object{"retained": []any{"same"}}}
	configID := uuid.NewString()
	if _, err = f.owner.Exec(ctx, `INSERT INTO operations_autonomy_configs_v1(id,endpoint,domain,revision,enabled,configuration,prompt_version,plan_version,delegation_version,updated_by,created_at,updated_at) VALUES($1,$2,'governance',1,false,$3,1,1,1,$4,$5,$5)`, configID, f.Endpoint, configuration, f.Root.ID, f.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = f.owner.Exec(ctx, `INSERT INTO operations_autonomy_versions_v1(config_id,revision,configuration,prompt_version,plan_version,delegation_version,operator_id,created_at) VALUES($1,1,$2,1,1,1,$3,$4)`, configID, configuration, f.Root.ID, f.Now()); err != nil {
		t.Fatal(err)
	}
	actor, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "overview", "prepare", "ai.roles.create")
	})
	if err != nil {
		t.Fatal(err)
	}
	originalInput := Object{"kind": "role-create", "operationId": uuid.NewString(), "expectedVersion": 0, "name": "Original delegated role", "description": "Original narrow role", "enabled": true, "permissions": []any{"feedback.read"}, "targetAiAccountIds": []any{accounts["governance"]["id"]}}
	version := int64(1)
	original, err := f.Permissions.DelegatedRoleSave(ctx, actor, originalInput, operationspermissions.DelegatedOptions{ExpectedDelegationVersion: &version})
	if err != nil {
		t.Fatal(err)
	}
	return Object{"overview": accounts["overview"], "governance": accounts["governance"], "role": roleValue, "configId": configID, "configuration": configuration, "originalInput": originalInput, "original": original}
}
