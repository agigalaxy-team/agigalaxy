package jobs

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// SnapshotWithin reports the current adopted transport, not business effects
// or every platform queue. The caller owns authorization and its read snapshot.
func (q *Queue) SnapshotWithin(ctx context.Context, tx pgx.Tx, endpoint string) (map[string]any, error) {
	if q == nil || tx == nil || endpoint == "" {
		return nil, fault.New("operations_job_backend_unavailable", 503)
	}
	var enabled bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 AND backend='river')`, endpoint).Scan(&enabled); err != nil {
		return nil, err
	}
	if !enabled {
		return nil, fault.New("operations_job_backend_not_adopted", 503)
	}
	rows, err := tx.Query(ctx, `SELECT e.action, CASE
 WHEN j.state IN ('available','pending','scheduled') THEN 'created'
 WHEN j.state='retryable' THEN 'retry' WHEN j.state='running' THEN 'active'
 WHEN j.state='discarded' THEN 'failed' ELSE j.state::text END AS state, count(*)::integer
 FROM galaxy_go_jobs.executions_v1 e JOIN galaxy_river.river_job j ON j.id=e.river_id
 WHERE e.endpoint=$1 AND e.action=ANY($2::text[])
 GROUP BY e.action,2 ORDER BY e.action,2`, endpoint, []string{InformationWatch, SearchRecovery, ContentPublication, AccountNotice, MessagingRun, MessagingDelivery, AutonomyTask, AutonomyTick})
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []any{}
	var current map[string]any
	var counts map[string]any
	for rows.Next() {
		var queue, state string
		var count int
		if err := rows.Scan(&queue, &state, &count); err != nil {
			return nil, err
		}
		if current == nil || current["name"] != queue {
			counts = map[string]any{"created": 0, "retry": 0, "active": 0, "completed": 0, "cancelled": 0, "failed": 0}
			current = map[string]any{"name": queue, "counts": counts}
			items = append(items, current)
		}
		counts[state] = count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"backend": "river", "scope": "adopted-galaxy-river-transport", "includesAllPlatformQueues": false,
		"availability": map[string]any{"state": "available", "code": nil}, "items": items}, nil
}

func (q *Queue) Snapshot(ctx context.Context, endpoint string) (map[string]any, error) {
	if q == nil || q.pool == nil {
		return nil, fault.New("operations_job_backend_unavailable", 503)
	}
	tx, err := q.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.Background())
	out, err := q.SnapshotWithin(ctx, tx, endpoint)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// SummaryWithin projects the same source for the workbench's active/failure
// overview. Terminal success remains a transport fact, not a handled-item count.
func (q *Queue) SummaryWithin(ctx context.Context, tx pgx.Tx, endpoint string) (map[string]any, error) {
	snapshot, err := q.SnapshotWithin(ctx, tx, endpoint)
	if err != nil {
		return nil, err
	}
	byQueue, failed := []any{}, 0
	for _, raw := range snapshot["items"].([]any) {
		item := raw.(map[string]any)
		counts := item["counts"].(map[string]any)
		for _, state := range []string{"created", "retry", "active", "failed"} {
			count := counts[state].(int)
			if count > 0 {
				byQueue = append(byQueue, map[string]any{"queue": item["name"], "state": state, "count": count})
			}
			if state == "failed" {
				failed += count
			}
		}
	}
	return map[string]any{"backend": snapshot["backend"], "scope": snapshot["scope"], "failed": failed, "byQueue": byQueue}, nil
}
