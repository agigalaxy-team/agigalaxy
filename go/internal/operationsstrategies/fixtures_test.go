package operationsstrategies

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func seedStrategyExecution(t *testing.T, f *operationsfixture.Fixture, target string) Object {
	t.Helper()
	ctx := context.Background()
	grant, err := f.Permissions.SaveAutomation(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Original prepared execution", "executorKind": "program", "mode": "assisted", "enabled": true, "permissions": []any{"content.read", "content.hide", "content.restore"}, "resourceIds": []any{target}})
	if err != nil {
		t.Fatal(err)
	}
	automation := obj(grant["automation"])
	create := Object{"operationId": uuid.NewString(), "grantId": automation["id"], "expectedGrantVersion": automation["version"], "domain": "governance", "actions": []any{"content.read", "content.hide", "content.restore"}, "resourceIds": []any{target}, "preparedCommand": Object{"tool": "content-visibility", "targetKind": "post", "targetId": target, "input": Object{"expectedVersion": 1, "expectedRevision": 0, "kind": "hide", "until": f.Now().Unix() + 600, "reason": "Original prepared moderation"}}}
	executions := &agentos.Executions{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	original, err := executions.Create(ctx, f.Root, create, func(ctx context.Context, tx pgx.Tx) (operationspermissions.Actor, error) {
		return f.Gateway.RequireWithin(ctx, tx, f.Root, "workbench.read")
	})
	if err != nil {
		t.Fatal(err)
	}
	return Object{"grant": automation, "create": create, "original": original}
}
