package actions_test

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestStrategyConfirmedCardProjectsQueryProofInsideWritePG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	ctx := context.Background()
	role, e := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Query proof strategy", "description": "Confirm fixed account", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"strategies.read", "strategies.configure"}})
	if e != nil {
		t.Fatal(e)
	}
	roleID := role["role"].(map[string]any)["id"]
	for _, domain := range []string{"overview", "governance"} {
		if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, domain, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": roleID, "enabled": true}); e != nil {
			t.Fatal(e)
		}
	}
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Strategies: &operationsstrategies.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}, Now: f.Now}
	op := uuid.NewString()
	proposal, e := service.Prepare(ctx, f.Root, "overview", map[string]any{"kind": "strategy-draft", "configuration": operationsstrategies.EmptyConfiguration(), "reason": "Reviewed card"}, op)
	if e != nil {
		t.Fatal(e)
	}
	queryProof := func(domain string) actions.Authorize {
		return func(ctx context.Context, tx pgx.Tx) (p.Actor, error) {
			read := func(tx pgx.Tx) (p.Actor, error) {
				return f.Permissions.HumanAIWithin(ctx, tx, f.Root, domain, "query", "strategies.read")
			}
			if tx != nil {
				return read(tx)
			}
			return postgres.InTx(ctx, f.Pool, read)
		}
	}
	denied := func(context.Context, pgx.Tx) (p.Actor, error) {
		return p.Actor{}, fault.New("business_admin_denied", 403)
	}
	if _, e = service.ExecutePrepared(ctx, f.Root, proposal, op, denied); fault.Status(e) != 403 {
		t.Fatalf("revoked callback must fail: %v", e)
	}
	if _, e = service.ExecutePrepared(ctx, f.Root, proposal, op, queryProof("governance")); fault.Status(e) != 403 {
		t.Fatalf("other fixed AI must fail: %v", e)
	}
	queryActor, e := queryProof("overview")(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	scope, e := f.Permissions.AIWorkContext(queryActor)
	if e != nil {
		t.Fatal(e)
	}
	accountID := scope["accountId"].(string)
	stored := func(ctx context.Context, tx pgx.Tx) (p.Actor, error) {
		read := func(tx pgx.Tx) (p.Actor, error) {
			return f.Permissions.StoredHumanAIWithin(ctx, tx, f.Root.ID, "overview", accountID, "query", "strategies.read")
		}
		if tx != nil {
			return read(tx)
		}
		return postgres.InTx(ctx, f.Pool, read)
	}
	if _, e = service.ExecutePrepared(ctx, f.Root, proposal, op, stored); fault.Status(e) != 403 {
		t.Fatalf("stored query proof must not authorize writing: %v", e)
	}
	got, e := service.ExecutePrepared(ctx, f.Root, proposal, op, queryProof("overview"))
	if e != nil || got["state"] != "completed" {
		t.Fatalf("query proof confirmation: %#v %v", got, e)
	}
	got, e = service.ExecutePrepared(ctx, f.Root, proposal, op, queryProof("overview"))
	if e != nil || got["state"] != "completed" {
		t.Fatalf("original replay: %#v %v", got, e)
	}
	var n int
	if e = f.Pool.QueryRow(ctx, "SELECT count(*) FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2", f.Endpoint, op).Scan(&n); e != nil || n != 1 {
		t.Fatalf("one original operation: %d %v", n, e)
	}
}
