package postgres_test

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
)

func TestRecoveryQuarantineBlocksRuntimeUntilReady(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if fault.Code(postgres.AssertRecoveryReady(ctx, pool)) != "database_recovery_state_unavailable" {
		t.Fatal("missing recovery state was accepted")
	}
	if _, err := pool.Exec(ctx, "CREATE TABLE recovery_state(status text)"); err != nil {
		t.Fatal(err)
	}
	if err := postgres.AssertRecoveryReady(ctx, pool); err != nil {
		t.Fatal(err)
	}
	for _, state := range []any{"quarantined", "restoring", nil} {
		if _, err := pool.Exec(ctx, "TRUNCATE recovery_state"); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, "INSERT INTO recovery_state(status) VALUES ($1)", state); err != nil {
			t.Fatal(err)
		}
		if fault.Code(postgres.AssertRecoveryReady(ctx, pool)) != "database_recovery_quarantined" {
			t.Fatal("unready recovery accepted")
		}
	}
	if _, err := pool.Exec(ctx, "UPDATE recovery_state SET status='ready'"); err != nil {
		t.Fatal(err)
	}
	if err := postgres.AssertRecoveryReady(ctx, pool); err != nil {
		t.Fatal(err)
	}
}
