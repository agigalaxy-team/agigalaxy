package discovery

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// QualifyRetryWithin is the original prepared-operation current source check.
// Its caller owns real operation authority in this same transaction. It does
// not replace RetryFailed's locked generation check or enqueue another job.
func (s *LegacyIndex) QualifyRetryWithin(ctx context.Context, tx pgx.Tx, id string, generation int64) error {
	if !validID(id) || generation < 1 {
		return qualityFailure("invalid_search_recovery", 400)
	}
	row, e := rowObject(ctx, tx, `SELECT to_jsonb(j) FROM jobs j JOIN search_index_control c ON c.singleton AND c.endpoint=$2 AND c.enabled WHERE j.id=$1 AND j.kind='search-index'`, id, s.Endpoint)
	if e != nil {
		return e
	}
	if row == nil || str(row, "state") != "failed" || number(object(row["payload"]), "generation") != generation {
		return qualityFailure("search_recovery_conflict")
	}
	return nil
}
