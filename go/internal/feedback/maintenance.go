package feedback

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// TaskProducer records only an exact source in the caller's source transaction.
// It does not start a scheduler, perform scans, or authorize physical cleanup.
type TaskProducer interface {
	AttachmentScanWithin(context.Context, pgx.Tx, string, string, string) error
	OwnerDeletionWithin(context.Context, pgx.Tx, string, string, string) error
}

func (s *Service) queueAttachmentScanWithin(ctx context.Context, tx pgx.Tx, row attachmentRow) error {
	if s.Tasks == nil {
		return nil
	}
	return s.Tasks.AttachmentScanWithin(ctx, tx, s.Endpoint, row.id, row.operation)
}
func (s *Service) queueOwnerDeletionWithin(ctx context.Context, tx pgx.Tx, operation string) error {
	if s.Tasks == nil {
		return nil
	}
	// The original security-definer function, not the producer, selects and
	// tombstones the owner's scope. Already absent objects need no new work.
	rows, e := tx.Query(ctx, `SELECT attachment_id::text FROM account_feedback_data_items_v1 WHERE operation_id=$1 AND state<>'removed' ORDER BY attachment_id`, operation)
	if e != nil {
		return e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return e
		}
		ids = append(ids, id)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return e
	}
	for _, id := range ids {
		if e = s.Tasks.OwnerDeletionWithin(ctx, tx, s.Endpoint, operation, id); e != nil {
			return e
		}
	}
	return nil
}

// There is intentionally no feedback expiry/revocation/orphan eraser here.
// The source feedback service and lifecycle registry stop reads immediately
// but have no automatic physical cleanup consumer. Chat/forum purge rules are
// not feedback rules; owner deletion retains its distinct exact recorded scope.
