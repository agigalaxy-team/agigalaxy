package cases

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// RequireOwnerSourceWithin is the original Assistance source liveness check.
// owner must come from the caller's already locked source row; this read port
// neither authenticates that owner nor replaces the actual caller's grant.
func (s *Service) RequireOwnerSourceWithin(ctx context.Context, tx pgx.Tx, caseID, ownerID string) error {
	return s.requireOwnerSource(ctx, tx, caseID, ownerID)
}
