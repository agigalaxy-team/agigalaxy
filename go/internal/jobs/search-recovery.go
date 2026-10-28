package jobs

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// The caller holds the actual source-job lock and its current manual-retry
// authority in this transaction. This cannot reset a business result or replay
// a message: only cancelled recovery transports for that source/generation are
// marked, leaving their original state, payload, hash and receipt intact.
func (q *Queue) SupersedeSearchRecoveryWithin(ctx context.Context, tx pgx.Tx, endpoint, sourceID string, generation int64) (int64, error) {
	if endpoint == "" || generation < 1 || generation > 2147483647 {
		return 0, fault.New("operations_job_payload_invalid", 400)
	}
	result, err := tx.Exec(ctx, `UPDATE galaxy_go_jobs.executions_v1 e SET superseded_at=clock_timestamp() FROM galaxy_river.river_job j WHERE e.endpoint=$1 AND e.action='search-recovery' AND e.source_id=$2 AND e.state='cancelled' AND e.superseded_at IS NULL AND j.id=e.river_id AND (j.args->>'generation')::bigint=$3 AND j.state='cancelled'`, endpoint, sourceID, generation)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}
