package jobs

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

func (q *Queue) EnqueueInformationWatchWithin(ctx context.Context, tx pgx.Tx, endpoint string, payload map[string]any, key string, startAfter time.Time) error {
	return q.enqueueActiveWithin(ctx, tx, endpoint, InformationWatch, payload, key, &startAfter)
}

// Only the current transport generation represents this original watch key.
// Historical completed generations never permanently suppress reconciliation.
func (q *Queue) HasInformationWatchOutstandingWithin(ctx context.Context, tx pgx.Tx, endpoint, watchID string, revision, checkRevision int64) (bool, error) {
	key := fmt.Sprintf("watch:%s:%d:%d", watchID, revision, checkRevision)
	var id string
	err := tx.QueryRow(ctx, `SELECT execution_id::text FROM galaxy_go_jobs.singleton_slots_v1 WHERE endpoint=$1 AND action='information-watch' AND slot_key=$2`, endpoint, key).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	row, err := q.GetTransportWithin(ctx, tx, endpoint, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	switch string(row.State) {
	case "completed", "discarded":
		return false, nil
	default:
		return true, nil
	}
}
