package feedback

import (
	"context"
	"errors"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// OwnerDataAuthorize must re-read the real online account session. It runs
// outside source transactions, matching the original separate account store.
type OwnerDataAuthorize func() (string, Authorization, error)

func (s *Service) OwnerDataContent(ctx context.Context, account, operation, id string, authorize OwnerDataAuthorize) (AttachmentContent, error) {
	var empty AttachmentContent
	if !uuidPattern.MatchString(operation) || !uuidPattern.MatchString(id) {
		return empty, ownerDataInvalid()
	}
	if authorize == nil {
		return empty, fault.New("official_account_unavailable", 503)
	}
	before, authority, e := authorize()
	if e != nil {
		return empty, e
	}
	if before != account {
		return empty, fault.New("official_account_changed", 409)
	}
	current := *s
	current.Authority = authority
	repo, e := s.attachmentRepo()
	if e != nil {
		return empty, e
	}
	result, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (AttachmentContent, error) {
		if e := current.account(ctx, tx, account); e != nil {
			return empty, e
		}
		intent, e := s.ownerExport(ctx, tx, account, operation)
		if e != nil {
			return empty, e
		}
		var feedback string
		e = tx.QueryRow(ctx, `SELECT f.id::text FROM operations_feedback_v1 f JOIN feedback_attachments_v1 a ON a.feedback_id=f.id AND a.endpoint=f.endpoint AND a.account_id=f.account_id AND a.submission_operation_id=f.submission_operation_id WHERE a.id=$1 AND f.endpoint=$2 AND f.account_id=$3 AND f.sequence<=$4::bigint AND f.owner_deleted_at IS NULL`, id, s.Endpoint, account, intent.cutoff).Scan(&feedback)
		if errors.Is(e, pgx.ErrNoRows) {
			return empty, fault.New("feedback_attachment_unavailable", 404)
		}
		if e != nil {
			return empty, e
		}
		return repo.ContentWithin(ctx, tx, feedback, id, func() (string, string, error) {
			if e := current.account(ctx, tx, account); e != nil {
				return "", "", e
			}
			var owner, submission string
			e := tx.QueryRow(ctx, "SELECT account_id::text,submission_operation_id::text FROM operations_feedback_v1 WHERE id=$1 AND endpoint=$2 AND account_id=$3 AND owner_deleted_at IS NULL", feedback, s.Endpoint, account).Scan(&owner, &submission)
			if errors.Is(e, pgx.ErrNoRows) {
				return "", "", fault.New("feedback_attachment_content_unavailable", 404)
			}
			return owner, submission, e
		}, s.now)
	})
	if e != nil {
		return empty, e
	}
	after, authority, e := authorize()
	if e != nil {
		return empty, e
	}
	if after != account {
		return empty, fault.New("official_account_changed", 409)
	}
	current.Authority = authority
	_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		if e := current.account(ctx, tx, account); e != nil {
			return false, e
		}
		intent, e := s.ownerExport(ctx, tx, account, operation)
		if e != nil {
			return false, e
		}
		var feedback, submission string
		e = tx.QueryRow(ctx, `SELECT f.id::text,f.submission_operation_id::text FROM operations_feedback_v1 f WHERE f.endpoint=$1 AND f.account_id=$2 AND f.sequence<=$3::bigint AND f.owner_deleted_at IS NULL AND EXISTS(SELECT 1 FROM feedback_attachments_v1 a WHERE a.id=$4 AND a.feedback_id=f.id AND a.account_id=f.account_id AND a.endpoint=f.endpoint AND a.submission_operation_id=f.submission_operation_id)`, s.Endpoint, account, intent.cutoff, id).Scan(&feedback, &submission)
		if errors.Is(e, pgx.ErrNoRows) {
			return false, fault.New("feedback_attachment_content_unavailable", 404)
		}
		if e != nil {
			return false, e
		}
		a, e := repo.row(ctx, tx, id, "SHARE")
		if errors.Is(e, pgx.ErrNoRows) || e == nil && (a.feedback == nil || *a.feedback != feedback || a.account != account || a.operation != submission || a.purge || a.status(s.now()) != "available" || a.scan["state"] != "clean" || a.hash != result.SHA256 || a.size != int64(len(result.Bytes))) {
			return false, fault.New("feedback_attachment_content_unavailable", 404)
		}
		return true, e
	})
	if e != nil {
		return empty, e
	}
	return result, nil
}
