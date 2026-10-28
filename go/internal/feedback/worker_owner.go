package feedback

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (w *WorkerConsumers) ownerDelete(ctx context.Context, t jobs.Task) (jobs.Outcome, error) {
	s := w.Service
	repo, e := s.attachmentRepo()
	if e != nil {
		return deferred(s.now().Add(time.Second), "not-configured"), nil
	}
	if _, ok := repo.Store.(OwnerDeletionStore); !ok {
		return deferred(s.now().Add(time.Second), "not-configured"), nil
	}
	var retry time.Time
	claimed := false
	claim, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (ownerClaim, error) {
		r := ownerClaim{operation: t.OperationID, attachment: t.SourceID}
		var state string
		var attempts int
		var next *time.Time
		e := tx.QueryRow(ctx, `SELECT i.state,i.attempt_count,i.next_attempt_at FROM account_feedback_data_items_v1 i JOIN account_feedback_data_operations_v1 o ON o.operation_id=i.operation_id WHERE i.operation_id=$1 AND i.attachment_id=$2 AND o.endpoint=$3 AND o.kind='delete' AND o.metadata_deleted FOR UPDATE OF i`, t.OperationID, t.SourceID, s.Endpoint).Scan(&state, &attempts, &next)
		if e != nil {
			return r, e
		}
		if state == "removed" {
			return r, nil
		}
		if state != "pending" && (next == nil || next.After(s.now())) {
			if next != nil {
				retry = *next
			} else {
				retry = s.now().Add(120 * time.Second)
			}
			return r, nil
		}
		r.attempt = uuid.NewString()
		r.verificationOnly = attempts >= 3
		increment := 1
		if r.verificationOnly {
			increment = 0
		}
		claimed = true
		_, e = tx.Exec(ctx, "UPDATE account_feedback_data_items_v1 SET state='removing',attempt_count=attempt_count+$3,attempt_id=$4,attempted_at=$5,next_attempt_at=$6 WHERE operation_id=$1 AND attachment_id=$2", r.operation, r.attachment, increment, r.attempt, s.now(), s.now().Add(120*time.Second))
		return r, e
	})
	if errors.Is(e, pgx.ErrNoRows) {
		return jobs.Outcome{}, fault.New("operations_job_source_changed", 409)
	}
	if e != nil {
		return jobs.Outcome{}, e
	}
	if !retry.IsZero() {
		return deferred(retry, "leased"), nil
	}
	if !claimed {
		return jobs.Outcome{Result: map[string]any{"state": "removed", "operationId": t.OperationID, "attachmentId": t.SourceID}}, nil
	}
	e = s.removeOwnerAttachment(ctx, claim)
	if e == nil {
		var state string
		var next *time.Time
		e = s.Pool.QueryRow(ctx, "SELECT state,next_attempt_at FROM account_feedback_data_items_v1 WHERE operation_id=$1 AND attachment_id=$2", claim.operation, claim.attachment).Scan(&state, &next)
		if e != nil {
			return jobs.Outcome{}, e
		}
		if state != "removed" {
			at := s.now().Add(time.Second)
			if next != nil {
				at = *next
			}
			return deferred(at, state), nil
		}
		return jobs.Outcome{Result: map[string]any{"state": "removed", "operationId": t.OperationID, "attachmentId": t.SourceID}}, nil
	}
	code := fault.Code(e)
	switch code {
	case "attachment_service_unavailable", "attachment_storage_unavailable", "attachment_storage_integrity_failed", "attachment_encryption_key_unavailable", "account_feedback_attachment_clear_unconfirmed":
	default:
		code = "account_feedback_attachment_clear_unconfirmed"
	}
	w.report("feedback-owner-deletion", claim.operation, code)
	delay := 30 * time.Second
	if claim.verificationOnly {
		delay = 300 * time.Second
	}
	retry = s.now().Add(delay)
	recovery, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, e = postgres.InTx(recovery, s.Pool, func(tx pgx.Tx) (bool, error) {
		_, e := tx.Exec(recovery, "UPDATE account_feedback_data_items_v1 SET state='result-unknown',object_removed=NULL,result_code=$4,next_attempt_at=$5 WHERE operation_id=$1 AND attachment_id=$2 AND attempt_id=$3 AND state='removing'", claim.operation, claim.attachment, claim.attempt, code, retry)
		if e != nil {
			return false, e
		}
		return true, s.finishOwnerDeletion(recovery, tx, claim.operation)
	})
	if e != nil {
		return jobs.Outcome{}, e
	}
	return deferred(retry, "result-unknown"), nil
}
