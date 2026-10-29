package actions_test

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestOldMessageCardCannotConfirmWithoutFullReviewPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	ctx := context.Background()
	role, err := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Message reviewer", "description": "Isolated test", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"notices.read", "notices.publish"}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "messaging", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true})
	if err != nil {
		t.Fatal(err)
	}
	source := &messaging.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	created, err := source.Create(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "config": map[string]any{"channels": []any{"inapp"}, "content": map[string]any{"purpose": "service-update", "title": "Test title", "body": "Test body", "expiresAt": "2099-01-01T00:00:00Z"}, "audience": map[string]any{"kind": "all-accounts"}, "schedule": map[string]any{"kind": "immediate"}}})
	if err != nil {
		t.Fatal(err)
	}
	plan := created["plan"].(map[string]any)
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Messaging: source, Now: f.Now}
	op := uuid.NewString()
	proposal, err := service.Prepare(ctx, f.Root, "messaging", map[string]any{"kind": "messaging-state", "targetId": plan["id"], "action": "activate"}, op)
	if err != nil {
		t.Fatal(err)
	}
	proposal["impact"] = []any{"legacy generic review"}
	authorize := func(ctx context.Context, tx pgx.Tx) (p.Actor, error) {
		if tx == nil {
			return f.Root, nil
		}
		return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "messaging", "prepare", "notices.publish")
	}
	if _, err = service.ExecutePrepared(ctx, f.Root, proposal, op, authorize); fault.Code(err) != "operations_agentos_review_changed" {
		t.Fatalf("old card: %v", err)
	}
	var count int
	if err = f.Pool.QueryRow(ctx, `SELECT count(*) FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op).Scan(&count); err != nil || count != 0 {
		t.Fatalf("old card caused command: %d %v", count, err)
	}
}
