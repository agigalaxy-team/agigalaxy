package feedback

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type AttachmentContent struct {
	Bytes                                 []byte
	Name, MediaType, SHA256, AttachmentID string
}

// ContentWithin rechecks source linkage and access after fetching private bytes.
// Owner exports can reuse this port with their original export authorization.
func (r *AttachmentRepository) ContentWithin(ctx context.Context, tx pgx.Tx, feedback, id string, assertReadable func() (string, string, error), now func() time.Time) (AttachmentContent, error) {
	var out AttachmentContent
	if e := r.configured(); e != nil {
		return out, e
	}
	if !uuidPattern.MatchString(feedback) || !uuidPattern.MatchString(id) || assertReadable == nil {
		return out, fault.New("feedback_attachment_unavailable", 404)
	}
	current := func() (attachmentRow, error) {
		account, operation, e := assertReadable()
		if e != nil {
			return attachmentRow{}, e
		}
		a, e := r.row(ctx, tx, id, "SHARE")
		if errors.Is(e, pgx.ErrNoRows) || e == nil && (a.feedback == nil || *a.feedback != feedback || a.account != account || a.operation != operation || a.purge || a.status(now()) != "available" || a.scan["state"] != "clean") {
			return a, fault.New("feedback_attachment_content_unavailable", 404)
		}
		return a, e
	}
	a, e := current()
	if e != nil {
		return out, e
	}
	b, e := r.Store.Get(ctx, a.storageKey, a.keyID, a.size)
	if e != nil {
		return out, e
	}
	if e = attachments.Integrity(b, a.size, a.hash); e != nil {
		return out, e
	}
	a, e = current()
	if e != nil {
		return out, e
	}
	return AttachmentContent{b, a.name, a.media, a.hash, a.id}, nil
}
func (s *Service) AttachmentContent(ctx context.Context, operator, feedback, id string, reauthorize func() error) (AttachmentContent, error) {
	var out AttachmentContent
	if !uuidPattern.MatchString(feedback) || !uuidPattern.MatchString(id) {
		return out, invalid()
	}
	r, e := s.attachmentRepo()
	if e != nil {
		return out, e
	}
	_, e = s.read(ctx, operator, "feedback-read", Object{"id": feedback, "attachmentId": id}, func(tx pgx.Tx, _ Operator) (Object, error) {
		var e error
		out, e = r.ContentWithin(ctx, tx, feedback, id, func() (string, string, error) {
			if reauthorize != nil {
				if e := reauthorize(); e != nil {
					return "", "", e
				}
			}
			if _, e := s.operator(ctx, tx, operator, "feedback.attachments.read"); e != nil {
				return "", "", e
			}
			a, e := s.head(ctx, tx, feedback, false)
			if e != nil {
				return "", "", e
			}
			var operation string
			e = tx.QueryRow(ctx, "SELECT submission_operation_id::text FROM operations_feedback_v1 WHERE id=$1 AND endpoint=$2 AND owner_deleted_at IS NULL", feedback, s.Endpoint).Scan(&operation)
			return a.account, operation, e
		}, s.now)
		return Object{}, e
	})
	return out, e
}

// ScanPending is an explicit worker action. Constructing a repository or API
// never starts scans or physical cleanup.
func (r *AttachmentRepository) ScanPending(ctx context.Context, pool *pgxpool.Pool, limit int, diagnostic func(string, string, string)) (Object, error) {
	if e := r.configured(); e != nil {
		return nil, e
	}
	if limit < 1 || limit > 4 {
		return nil, fault.New("invalid_attachment_scan_limit", 400)
	}
	now := time.Now
	if r.Now != nil {
		now = r.Now
	}
	scanned := 0
	for i := 0; i < limit; i++ {
		lease := uuid.NewString()
		a, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (attachmentRow, error) {
			a, e := attachmentScan(tx.QueryRow(ctx, `SELECT `+attachmentColumns+` FROM feedback_attachments_v1 WHERE endpoint=$1 AND state IN ('scan-pending','scanning') AND revoked_at IS NULL AND NOT purge_pending AND expires_at>$2 AND (lease_until IS NULL OR lease_until<=$2) ORDER BY uploaded_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, r.Endpoint, now()))
			if e != nil {
				return a, e
			}
			return attachmentScan(tx.QueryRow(ctx, "UPDATE feedback_attachments_v1 SET state='scanning',lease_id=$2,lease_until=$3,scan_attempts=scan_attempts+1 WHERE id=$1 RETURNING "+attachmentColumns, a.id, lease, now().Add(120*time.Second)))
		})
		if errors.Is(e, pgx.ErrNoRows) {
			break
		}
		if e != nil {
			return nil, e
		}
		b, e := r.Store.Get(ctx, a.storageKey, a.keyID, a.size)
		if e == nil {
			e = attachments.Integrity(b, a.size, a.hash)
		}
		var result map[string]any
		if e == nil {
			result, e = r.Scanner.Scan(ctx, b)
		}
		if e == nil && result["state"] != "clean" && result["state"] != "blocked" {
			e = fault.New("attachment_scan_incomplete", 503)
		}
		if e == nil {
			_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
				current, e := r.row(ctx, tx, a.id, "UPDATE")
				if errors.Is(e, pgx.ErrNoRows) || e == nil && (current.lease == nil || *current.lease != lease) {
					return false, nil
				}
				if e != nil {
					return false, e
				}
				blocked := current.revoked != nil || current.purge || !current.expiry().After(now()) || result["state"] == "blocked"
				state := "available"
				if blocked {
					state = "blocked"
				}
				scan, e := json.Marshal(result)
				if e != nil {
					return false, e
				}
				_, e = tx.Exec(ctx, "UPDATE feedback_attachments_v1 SET state=$2,scan_result=$3,lease_id=NULL,lease_until=NULL,last_error=NULL,purge_pending=$4 WHERE id=$1", a.id, state, scan, blocked)
				return true, e
			})
			if e == nil {
				scanned++
				continue
			}
		}
		code := fault.Code(e)
		if code == "internal_error" {
			code = "attachment_scan_failed"
		}
		if diagnostic != nil {
			func() { defer func() { _ = recover() }(); diagnostic("feedback-attachment-scan", a.id, code) }()
		}
		if _, e = pool.Exec(ctx, "UPDATE feedback_attachments_v1 SET state='scan-pending',lease_id=NULL,lease_until=$3,last_error=$4 WHERE id=$1 AND lease_id=$2", a.id, lease, now().Add(60*time.Second), code); e != nil {
			return nil, e
		}
	}
	return Object{"scanned": scanned}, nil
}
