package cases

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// RowsForLockedCaseWithin reuses the owning ledger read after an internal
// consumer has locked and qualified its Case container. The CI worker first
// uses the original request-bound galaxy_worker_lock_ci_case function; this
// method confers no request identity or HTTP access by itself.
func (s *Service) RowsForLockedCaseWithin(ctx context.Context, tx pgx.Tx, id string) ([]Object, error) {
	return events(ctx, tx, id)
}
