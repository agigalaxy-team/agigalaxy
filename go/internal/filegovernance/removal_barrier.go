package filegovernance

import (
	"context"
	"github.com/jackc/pgx/v5"
	"time"
)

// AutomaticRemovalBarrierWithin prevents an automatic/subject cleanup from
// turning the existing approved-plan in-flight/unknown item into a new DELETE.
// It reads metadata only and does not grant or replace plan approval.
func AutomaticRemovalBarrierWithin(ctx context.Context, tx pgx.Tx, endpoint, kind, id string, now time.Time) (Object, error) {
	var busy, unknown bool
	e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_file_cleanup_items_v1 i JOIN operations_file_cleanup_plans_v1 p ON p.id=i.plan_id WHERE p.endpoint=$1 AND i.kind=$2 AND i.file_id=$3 AND i.state='removing' AND i.next_attempt_at>$4),EXISTS(SELECT 1 FROM operations_file_cleanup_items_v1 i JOIN operations_file_cleanup_plans_v1 p ON p.id=i.plan_id WHERE p.endpoint=$1 AND i.kind=$2 AND i.file_id=$3 AND (i.state='result-unknown' OR i.state='removing' AND (i.next_attempt_at IS NULL OR i.next_attempt_at<=$4)))`, endpoint, kind, id, now).Scan(&busy, &unknown)
	return Object{"busy": busy, "unknown": unknown}, e
}
