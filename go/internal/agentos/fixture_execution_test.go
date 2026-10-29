package agentos

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"testing"
)

func seedExecution(t *testing.T, f *operationsfixture.Fixture, authority *Executions, human operationspermissions.Actor, target string, accounts Object, ai bool) Object {
	t.Helper()
	ctx := context.Background()
	var role Object
	grantInput := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Original prepared execution", "executorKind": "program", "mode": "assisted", "enabled": true, "permissions": []any{"content.read", "content.hide", "content.restore"}, "resourceIds": []any{target}}
	if ai {
		saved, e := f.Permissions.SaveRole(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Original current executor AI", "description": "Synthetic execution-only role", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"content.read", "content.hide", "content.restore"}})
		if e != nil {
			t.Fatal(e)
		}
		role = object(saved["role"])
		if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, "governance", Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["id"], "enabled": true}); e != nil {
			t.Fatal(e)
		}
		grantInput["executorKind"], grantInput["resourceIds"], grantInput["resourceScope"], grantInput["aiAccountId"] = "ai", []any{}, Object{"kind": "eligible"}, accounts["governance"]
	}
	saved, e := f.Permissions.SaveAutomation(ctx, f.Root, grantInput)
	if e != nil {
		t.Fatal(e)
	}
	grant := object(saved["automation"])
	create := Object{"operationId": uuid.NewString(), "grantId": grant["id"], "expectedGrantVersion": grant["version"], "domain": "governance", "actions": []any{"content.read", "content.hide", "content.restore"}, "resourceIds": []any{target}, "preparedCommand": Object{"tool": "content-visibility", "targetKind": "post", "targetId": target, "input": Object{"expectedVersion": 1, "expectedRevision": 0, "kind": "hide", "until": f.Now().Unix() + 600, "reason": "Original prepared moderation"}}}
	result, e := authority.Create(ctx, human, create, func(ctx context.Context, tx pgx.Tx) (operationspermissions.Actor, error) {
		return authority.Permissions.Authority.RequireWithin(ctx, tx, human, "workbench.read")
	})
	if e != nil {
		t.Fatal(e)
	}
	return Object{"grant": grant, "role": role, "create": create, "original": result}
}
