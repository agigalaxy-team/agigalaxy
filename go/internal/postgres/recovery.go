package postgres

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// AssertRecoveryReady preserves the existing restored-database quarantine.
// Runtime startup must not reopen writes or claim jobs before recovery is ready.
func AssertRecoveryReady(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) error {
	var ready bool
	if err := db.QueryRow(ctx, "SELECT NOT EXISTS(SELECT 1 FROM recovery_state WHERE status IS DISTINCT FROM 'ready')").Scan(&ready); err != nil {
		return fault.New("database_recovery_state_unavailable", 503)
	}
	if !ready {
		return fault.New("database_recovery_quarantined", 503)
	}
	return nil
}
