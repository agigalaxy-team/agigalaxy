package operationspermissions_test

import (
	"context"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/jackc/pgx/v5"
)

type capabilityCountTx struct {
	pgx.Tx
	accounts, assignments, delegations int
}

func (tx *capabilityCountTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "SELECT id::text,enabled,authorization_version FROM operations_ai_work_accounts_v1") {
		tx.accounts++
	}
	if strings.Contains(sql, "FROM operations_ai_role_delegations_v1 d") {
		tx.delegations++
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}
func (tx *capabilityCountTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.Contains(sql, "FROM operations_ai_work_assignments_v1") {
		tx.assignments++
	}
	return tx.Tx.Query(ctx, sql, args...)
}

func TestManagementCapabilitiesReadProjectionsAndRevocation(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	accounts := object(f.Automation(t)["accounts"])
	f.Delegated(t)
	ctx := context.Background()
	f.Permissions.StoredAuthority = f.Gateway.StoredOperators()
	actor, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (perms.Actor, error) {
		return f.Permissions.StoredHumanAIWithin(ctx, tx, f.Root.ID, "overview", text(accounts["overview"]), "query", "workbench.read")
	})
	if err != nil {
		t.Fatal(err)
	}
	stored := &countedReadPerson{StoredPersonAuthority: f.Gateway.StoredOperators()}
	f.Permissions.StoredAuthority = stored
	realTx, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	tx := &capabilityCountTx{Tx: realTx}
	capabilities, err := f.Permissions.ManagementCapabilitiesWithin(ctx, tx, actor)
	if err != nil {
		t.Fatal(err)
	}
	if stored.reads != 2 || tx.accounts != 2 || tx.assignments != 2 || tx.delegations != 1 {
		t.Fatalf("person=%d accounts=%d assignments=%d delegations=%d", stored.reads, tx.accounts, tx.assignments, tx.delegations)
	}
	if object(object(capabilities["role"])["read"])["available"] != true || object(object(capabilities["prompt"])["update"])["available"] != true || object(capabilities["delegation"])["enabled"] != true {
		t.Fatalf("current delegated capability changed: %#v", capabilities)
	}
	if err = realTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, "UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE endpoint=$1 AND domain='overview'", f.Endpoint); err != nil {
		t.Fatal(err)
	}
	realTx, err = f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer realTx.Rollback(ctx)
	if _, err = f.Permissions.ManagementCapabilitiesWithin(ctx, realTx, actor); fault.Code(err) != "operations_ai_work_disabled" {
		t.Fatalf("disabled fixed AI retained capability: %v", err)
	}
}
