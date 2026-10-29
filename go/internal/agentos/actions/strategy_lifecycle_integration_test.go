package actions_test

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestPreparedStrategyLifecycleAndOriginalRecoveryPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	ctx := context.Background()
	role, err := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Strategy reviewer", "description": "Review strategy cards", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"strategies.read", "strategies.configure", "strategies.publish"}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "overview", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true})
	if err != nil {
		t.Fatal(err)
	}
	strategies := &operationsstrategies.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Strategies: strategies, Now: f.Now}
	call := func(request map[string]any, permission string) map[string]any {
		t.Helper()
		op := uuid.NewString()
		proposal, err := service.Prepare(ctx, f.Root, "overview", request, op)
		if err != nil {
			t.Fatalf("prepare %s: %v", request["kind"], err)
		}
		authorize := func(ctx context.Context, tx pgx.Tx) (p.Actor, error) {
			if tx == nil {
				return f.Root, nil
			}
			return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "overview", "prepare", permission)
		}
		result, err := service.ExecutePrepared(ctx, f.Root, proposal, op, authorize)
		if err != nil || result["state"] != "completed" {
			t.Fatalf("execute %s: %#v %v", request["kind"], result, err)
		}
		recovered, err := service.RecoverPrepared(ctx, f.Root, proposal, op)
		if err != nil || recovered["state"] != "completed" {
			t.Fatalf("recover %s: %#v %v", request["kind"], recovered, err)
		}
		return result["receipt"].(map[string]any)
	}
	draft := call(map[string]any{"kind": "strategy-draft", "configuration": operationsstrategies.EmptyConfiguration(), "reason": "Create reviewed configuration"}, "strategies.configure")
	version := draft["versionId"]
	rehearsal := call(map[string]any{"kind": "strategy-rehearsal", "versionId": version, "executionIds": []any{}}, "strategies.read")
	call(map[string]any{"kind": "strategy-publish", "versionId": version, "rehearsalId": rehearsal["rehearsalId"], "reason": "Publish reviewed configuration"}, "strategies.publish")
}
