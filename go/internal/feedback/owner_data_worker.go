package feedback

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// OwnerDeletionStore is deliberately narrower than a site cleanup service.
// Only a recorded exact owner's selection can reach these object operations.
type OwnerDeletionStore interface {
	Head(context.Context, string, string) (*attachments.Head, error)
	Erase(context.Context, string) error
}
type ownerClaim struct {
	operation, attachment, attempt string
	verificationOnly               bool
}

func (s *Service) finishOwnerDeletion(ctx context.Context, tx pgx.Tx, operation string) error {
	var pending, unknown int
	e := tx.QueryRow(ctx, `SELECT count(*) FILTER(WHERE state IN('pending','removing') OR state='result-unknown' AND attempt_count<3)::int,count(*) FILTER(WHERE state='result-unknown')::int FROM account_feedback_data_items_v1 WHERE operation_id=$1`, operation).Scan(&pending, &unknown)
	if e != nil {
		return e
	}
	state := "completed"
	if pending > 0 {
		state = "pending"
	} else if unknown > 0 {
		state = "attention"
	}
	_, e = tx.Exec(ctx, "UPDATE account_feedback_data_operations_v1 SET state=$2,updated_at=$3 WHERE operation_id=$1 AND kind='delete'", operation, state, s.now())
	return e
}
func (s *Service) claimOwnerDeletion(ctx context.Context) (ownerClaim, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (ownerClaim, error) {
		var r ownerClaim
		var attempts int
		e := tx.QueryRow(ctx, `SELECT i.operation_id::text,i.attachment_id::text,i.attempt_count FROM account_feedback_data_items_v1 i JOIN account_feedback_data_operations_v1 o ON o.operation_id=i.operation_id WHERE o.endpoint=$1 AND o.kind='delete' AND o.metadata_deleted AND o.state IN('pending','attention') AND (i.state='pending' OR i.state IN('removing','result-unknown') AND i.next_attempt_at<=$2) ORDER BY o.created_at,i.attachment_id LIMIT 1 FOR UPDATE OF i SKIP LOCKED`, s.Endpoint, s.now()).Scan(&r.operation, &r.attachment, &attempts)
		if e != nil {
			return r, e
		}
		r.attempt = uuid.NewString()
		r.verificationOnly = attempts >= 3
		increment := 1
		if r.verificationOnly {
			increment = 0
		}
		_, e = tx.Exec(ctx, "UPDATE account_feedback_data_items_v1 SET state='removing',attempt_count=attempt_count+$3,attempt_id=$4,attempted_at=$5,next_attempt_at=$6 WHERE operation_id=$1 AND attachment_id=$2", r.operation, r.attachment, increment, r.attempt, s.now(), s.now().Add(120*time.Second))
		return r, e
	})
}
func (s *Service) removeOwnerAttachment(ctx context.Context, claim ownerClaim) error {
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		var state string
		var attempt *string
		e := tx.QueryRow(ctx, "SELECT state,attempt_id::text FROM account_feedback_data_items_v1 WHERE operation_id=$1 AND attachment_id=$2 FOR UPDATE", claim.operation, claim.attachment).Scan(&state, &attempt)
		if errors.Is(e, pgx.ErrNoRows) {
			return false, nil
		}
		if e != nil {
			return false, e
		}
		if state != "removing" || attempt == nil || *attempt != claim.attempt {
			return false, nil
		}
		var id, key, keyID, hash string
		var size int64
		e = tx.QueryRow(ctx, `SELECT a.id::text,a.storage_key,a.encryption_key_id,a.sha256,a.byte_size FROM feedback_attachments_v1 a JOIN operations_feedback_v1 f ON f.id=a.feedback_id AND f.endpoint=a.endpoint AND f.account_id=a.account_id AND f.submission_operation_id=a.submission_operation_id JOIN account_feedback_data_operations_v1 o ON o.operation_id=f.owner_delete_operation_id AND o.account_id=f.account_id AND o.endpoint=f.endpoint WHERE a.id=$1 AND o.operation_id=$2 AND o.endpoint=$3 AND o.kind='delete' AND o.metadata_deleted AND f.owner_deleted_at IS NOT NULL AND f.sequence<=o.cutoff_sequence FOR UPDATE OF a`, claim.attachment, claim.operation, s.Endpoint).Scan(&id, &key, &keyID, &hash, &size)
		if errors.Is(e, pgx.ErrNoRows) {
			return false, fault.New("account_feedback_delete_source_changed", 409)
		}
		if e != nil {
			return false, e
		}
		repo, e := s.attachmentRepo()
		if e != nil {
			return false, e
		}
		store, ok := repo.Store.(OwnerDeletionStore)
		if !ok {
			return false, fault.New("attachment_service_unavailable", 503)
		}
		before, e := store.Head(ctx, key, keyID)
		if e != nil {
			return false, e
		}
		if before != nil && (before.Size != size || before.SHA256 != nil && *before.SHA256 != hash) {
			return false, fault.New("attachment_storage_integrity_failed", 502)
		}
		resultCode := "object-already-absent"
		if before != nil {
			if claim.verificationOnly {
				return false, fault.New("account_feedback_attachment_clear_unconfirmed", 503)
			}
			if e = store.Erase(ctx, key); e != nil {
				return false, e
			}
			after, e := store.Head(ctx, key, keyID)
			if e != nil {
				return false, e
			}
			if after != nil {
				return false, fault.New("account_feedback_attachment_clear_unconfirmed", 503)
			}
			resultCode = "object-removed"
		}
		now := s.now()
		_, e = tx.Exec(ctx, "UPDATE feedback_attachments_v1 SET state='erased',name='',media_type='',scan_result=NULL,purge_pending=false,purged_at=COALESCE(purged_at,$2),lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1", id, now)
		if e != nil {
			return false, e
		}
		_, e = tx.Exec(ctx, "UPDATE account_feedback_data_items_v1 SET state='removed',object_removed=true,result_code=$3,completed_at=$4,next_attempt_at=NULL WHERE operation_id=$1 AND attachment_id=$2", claim.operation, id, resultCode, now)
		if e != nil {
			return false, e
		}
		return true, s.finishOwnerDeletion(ctx, tx, claim.operation)
	})
	return e
}

// ProcessOwnerDeletions is explicit worker work. It never creates an owner
// intent and does not activate the separate administrator file-cleanup flow.
func (s *Service) ProcessOwnerDeletions(ctx context.Context, limit int, diagnostic func(string, string, string)) (Object, error) {
	if limit < 1 || limit > 4 {
		return nil, ownerDataInvalid()
	}
	processed := 0
	for n := 0; n < limit; n++ {
		claim, e := s.claimOwnerDeletion(ctx)
		if errors.Is(e, pgx.ErrNoRows) {
			break
		}
		if e != nil {
			return nil, e
		}
		e = s.removeOwnerAttachment(ctx, claim)
		if e != nil {
			code := fault.Code(e)
			switch code {
			case "attachment_service_unavailable", "attachment_storage_unavailable", "attachment_storage_integrity_failed", "attachment_encryption_key_unavailable", "account_feedback_attachment_clear_unconfirmed":
			default:
				code = "account_feedback_attachment_clear_unconfirmed"
			}
			if diagnostic != nil {
				func() { defer func() { _ = recover() }(); diagnostic("feedback-owner-deletion", claim.operation, code) }()
			}
			delay := 30 * time.Second
			if claim.verificationOnly {
				delay = 300 * time.Second
			}
			// Cancellation does not turn a sent object erase back into unsent work.
			recovery, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			_, recordErr := postgres.InTx(recovery, s.Pool, func(tx pgx.Tx) (bool, error) {
				_, e := tx.Exec(recovery, "UPDATE account_feedback_data_items_v1 SET state='result-unknown',object_removed=NULL,result_code=$4,next_attempt_at=$5 WHERE operation_id=$1 AND attachment_id=$2 AND attempt_id=$3 AND state='removing'", claim.operation, claim.attachment, claim.attempt, code, s.now().Add(delay))
				if e != nil {
					return false, e
				}
				return true, s.finishOwnerDeletion(recovery, tx, claim.operation)
			})
			cancel()
			if recordErr != nil {
				return nil, recordErr
			}
		}
		processed++
	}
	return Object{"processed": processed, "physicalBlocksReleased": nil}, nil
}
