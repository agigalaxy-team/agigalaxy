package hubs

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

type ContentErasure struct {
	Table, Key, SubjectID, OriginalHash, Reason string
	At, RetainedUntil                           int64
}
type ErasureRecorder func(context.Context, pgx.Tx, ContentErasure) error

// CleanupRetentionWithin is the original bounded product-retention consumer.
// The owning lifecycle recorder and all mutations share the supplied Worker tx.
func CleanupRetentionWithin(ctx context.Context, tx pgx.Tx, at int64, record ErasureRecorder) (Object, error) {
	rows, e := query(ctx, tx, `SELECT e.id,e.subject_id,e.payload_hash FROM hub_events_v2 e JOIN hub_intake_v2 t ON t.id=e.object_id WHERE e.kind IN ('intake-open','intake-reply','intake-close') AND t.expires_at<=$1 AND e.payload_text<>'' ORDER BY t.expires_at,e.id LIMIT 100 FOR UPDATE OF e`, at)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for _, row := range rows {
		if record == nil {
			return nil, fault.New("hub_content_erasure_recorder_unavailable", 503)
		}
		id := txt(row, "id")
		if e = record(ctx, tx, ContentErasure{Table: "hub_events_v2", Key: id, SubjectID: txt(row, "subject_id"), OriginalHash: txt(row, "payload_hash"), Reason: "temporary-content-expired", At: at, RetainedUntil: at + 180*86400}); e != nil {
			return nil, e
		}
		ids = append(ids, id)
	}
	if len(ids) > 0 {
		if _, e = tx.Exec(ctx, "UPDATE hub_events_v2 SET payload_text='' WHERE id=ANY($1::uuid[])", ids); e != nil {
			return nil, e
		}
	}
	expired, e := query(ctx, tx, "SELECT id FROM hub_intake_v2 WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 50", at-180*86400)
	if e != nil {
		return nil, e
	}
	threadIDs := []string{}
	for _, row := range expired {
		threadIDs = append(threadIDs, txt(row, "id"))
	}
	if len(threadIDs) > 0 {
		if _, e = tx.Exec(ctx, "DELETE FROM hub_events_v2 WHERE object_id=ANY($1::uuid[]) AND kind IN ('intake-open','intake-reply','intake-close')", threadIDs); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "DELETE FROM hub_intake_v2 WHERE id=ANY($1::uuid[])", threadIDs); e != nil {
			return nil, e
		}
	}
	receipts, e := tx.Exec(ctx, "DELETE FROM hub_peering_receipts_v2 WHERE (query_id,side) IN (SELECT query_id,side FROM hub_peering_receipts_v2 WHERE created_at<=$1 ORDER BY created_at,query_id,side LIMIT 100)", at-180*86400)
	if e != nil {
		return nil, e
	}
	return Object{"hubIntakeBodies": len(rows), "hubIntakeReceipts": len(threadIDs), "hubQueryReceipts": receipts.RowsAffected()}, nil
}
