package accountarchive

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// CleanupRetentionWithin expires only copies with the owner's existing explicit
// expires_at. The deletion marker prevents an old upload from resurrecting them.
// Its caller supplies the existing bounded Worker transaction, never a browser
// account selection or a new default archive lifetime.
func CleanupRetentionWithin(ctx context.Context, tx pgx.Tx, at int64) (Object, error) {
	result, err := tx.Exec(ctx, `WITH expired AS (
 DELETE FROM private_conversation_archives_v1 WHERE id IN
 (SELECT id FROM private_conversation_archives_v1 WHERE expires_at<=$1
 ORDER BY expires_at,id LIMIT 100) RETURNING id,account_id,selection,origin_subject_id
 ) INSERT INTO private_conversation_deletions_v1(archive_id,account_id,scope_id,origin_subject_id,reason,deleted_at)
 SELECT id,account_id,(selection->>'scopeId')::uuid,origin_subject_id,'expired',$1 FROM expired
 ON CONFLICT(archive_id) DO NOTHING`, time.Unix(at, 0))
	if err != nil {
		return nil, err
	}
	return Object{"privateConversationArchives": result.RowsAffected()}, nil
}
