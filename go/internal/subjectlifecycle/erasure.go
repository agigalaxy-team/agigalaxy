package subjectlifecycle

import (
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

// ContentErasure carries only the original minimal receipt, never source text.
// Its owning approved deletion or bounded-retention consumer holds authority.
type ContentErasure struct {
	Table, Key, SubjectID, RequestID, Reason string
	OriginalHash                             *string
	At, RetainedUntil                        int64
}

func RecordContentErasureWithin(ctx context.Context, tx pgx.Tx, r ContentErasure) error {
	var request any
	if r.RequestID != "" {
		request = r.RequestID
	}
	reason := r.Reason
	if reason == "" {
		reason = "subject-deletion"
	}
	_, e := tx.Exec(ctx, `INSERT INTO lifecycle_erasure_records(id,table_name,object_key,subject_id,reason,policy_version,original_payload_hash,request_id,erased_at,retained_until,account_id) VALUES($1,$2,$3,$4,$5,'galaxy-retention/v1-product-v2',$6,$7,$8,$9,NULL) ON CONFLICT(table_name,object_key) DO NOTHING`, uuid.NewString(), r.Table, r.Key, r.SubjectID, reason, r.OriginalHash, request, time.Unix(r.At, 0), time.Unix(r.RetainedUntil, 0))
	return e
}
