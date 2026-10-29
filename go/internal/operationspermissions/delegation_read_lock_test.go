package operationspermissions_test

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/jackc/pgx/v5"
)

type directoryPersonCounter struct {
	perms.StoredPersonAuthority
	reads, denyAt int
}
func (s *directoryPersonCounter) PersonWithin(ctx context.Context, tx pgx.Tx, id string, eligibility bool) (perms.Actor, error) {
	s.reads++
	if s.denyAt != 0 && s.reads == s.denyAt {
		return perms.Actor{}, fault.New("business_admin_denied", 403)
	}
	return s.StoredPersonAuthority.PersonWithin(ctx, tx, id, eligibility)
}

func TestDelegatedDirectoryReadDoesNotLockRolesAndRechecksAuthority(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	accounts := object(f.Automation(t)["accounts"])
	delegated := f.Delegated(t)
	ctx := context.Background()
	baseline := f.DelegatedRead(t, nil)["directory"]
	service := f.Permissions
	service.StoredAuthority = f.Gateway.StoredOperators()
	actor, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (perms.Actor, error) {
		return service.StoredHumanAIWithin(ctx, tx, f.Root.ID, "overview", text(accounts["overview"]), "query", "workbench.read")
	})
	if err != nil {
		t.Fatal(err)
	}
	counter := &directoryPersonCounter{StoredPersonAuthority: f.Gateway.StoredOperators()}
	service.StoredAuthority = counter

	// A concurrent transaction holding an AI role row must not block the
	// directory read. The role is still checked and filtered by the real code.
	locked, err := owner.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(ctx)
	var id string
	if err = locked.QueryRow(ctx, "SELECT id::text FROM operations_business_roles_v1 WHERE id=$1 FOR UPDATE", object(delegated["role"])["id"]).Scan(&id); err != nil {
		t.Fatal(err)
	}
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	result, err := service.DelegatedDirectory(readCtx, actor)
	cancel()
	if err != nil || !equal(result, baseline) {
		t.Fatalf("directory blocked or changed: %v", err)
	}
	if counter.reads != 3 {
		t.Fatalf("directory human rechecks=%d, want two initial projections and one final", counter.reads)
	}

	// Mutating/preparation consumers still acquire the original role lock. A
	// conflicting transaction must prevent the role preparation from proceeding.
	counter.reads = 0
	prepare := map[string]any{"kind": "role-update", "id": id, "expectedVersion": 1, "name": "Synthetic role", "description": "Locked role", "permissions": []any{"feedback.read"}, "targetAiAccountIds": []any{text(accounts["governance"])}, "enabled": true}
	writeCtx, stop := context.WithTimeout(ctx, time.Second)
	_, err = service.DelegatedRolePreparation(writeCtx, actor, prepare)
	stop()
	if err == nil || writeCtx.Err() != context.DeadlineExceeded {
		t.Fatalf("role preparation did not wait for original row lock: %v", err)
	}
	if err = locked.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	// Revocation at the final independent read barrier must suppress output.
	counter.reads, counter.denyAt = 0, 3
	if _, err = service.DelegatedDirectory(ctx, actor); fault.Code(err) != "business_admin_denied" {
		t.Fatalf("final directory authority barrier: %v", err)
	}
	counter.reads, counter.denyAt = 0, 0
	tool, err := service.ReadManagementTool(ctx, actor, "overview", map[string]any{})
	if err != nil || tool["availability"] != "available" {
		t.Fatalf("management tool: %v", err)
	}
	if counter.reads != 5 {
		t.Fatalf("management tool human rechecks=%d, want initial, three directory, final", counter.reads)
	}
}
