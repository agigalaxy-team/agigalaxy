package jobs

import (
	"context"
	"github.com/jackc/pgx/v5"
	"time"
)

// The original retention run is also its transport and operation identity.
// Its owning ledger, cancellation and current approver remain in retention.
func (q *Queue) EnqueueRetentionWithin(ctx context.Context, tx pgx.Tx, endpoint, runID string) (string, error) {
	return q.EnqueueWithin(ctx, tx, Task{ID: runID, Endpoint: endpoint, SourceID: runID, OperationID: runID, Action: RetentionCleanup}, time.Now())
}
