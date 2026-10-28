package feedback

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (r *AttachmentRepository) policy() attachments.Policy {
	if r.Policy.Version == 0 {
		return attachments.DefaultPolicy()
	}
	return r.Policy
}
func (r *AttachmentRepository) draftDays() int {
	if r.DraftRetentionDays == 0 {
		return 7
	}
	return r.DraftRetentionDays
}
func (r *AttachmentRepository) submittedDays() int {
	if r.SubmittedRetentionDays == 0 {
		return 30
	}
	return r.SubmittedRetentionDays
}
func (r *AttachmentRepository) ready() bool {
	return r.Store != nil && r.Scanner != nil && r.policy().Valid() && r.draftDays() >= 1 && r.draftDays() <= 30 && r.submittedDays() >= r.draftDays() && r.submittedDays() <= 365
}
func (r *AttachmentRepository) configured() error {
	if !r.ready() {
		return fault.New("attachment_service_unavailable", 503)
	}
	return nil
}
func (r *AttachmentRepository) maxFiles() int {
	n := r.policy().MaxFilesPerMessage
	if n > 4 {
		n = 4
	}
	return n
}
func (r *AttachmentRepository) Specification() Object {
	return Object{"supported": r.ready(), "storageRuntimeVerified": false, "maxFileBytes": r.policy().MaxFileBytes, "maxFilesPerFeedback": r.maxFiles(), "draftRetentionDays": r.draftDays(), "submittedRetentionDays": r.submittedDays(), "retentionPolicySource": "configurable-engineering-default", "startsAt": "first-upload-start", "purpose": "private-feedback-attachment", "publicStorageUrls": false, "automaticEvidence": false, "scanGuaranteesSafety": false, "automaticPhysicalCleanup": false}
}
func (r *AttachmentRepository) row(ctx context.Context, tx pgx.Tx, id, lock string) (attachmentRow, error) {
	return attachmentScan(tx.QueryRow(ctx, "SELECT "+attachmentColumns+" FROM feedback_attachments_v1 WHERE id=$1 AND endpoint=$2 FOR "+lock, id, r.Endpoint))
}
func (r *AttachmentRepository) owned(ctx context.Context, tx pgx.Tx, account string, x attachmentTarget, lock string) (attachmentRow, error) {
	a, e := r.row(ctx, tx, x.AttachmentID, lock)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && (a.account != account || a.operation != x.OperationID || a.feedback != nil) {
		return a, fault.New("feedback_attachment_unavailable", 404)
	}
	return a, e
}
func (r *AttachmentRepository) lockDraft(ctx context.Context, tx pgx.Tx, account, operation string) error {
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912395))", r.Endpoint+":feedback-intake:"+account); e != nil {
		return e
	}
	var exists bool
	if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operations_feedback_v1 WHERE endpoint=$1 AND account_id=$2 AND submission_operation_id=$3)", r.Endpoint, account, operation).Scan(&exists); e != nil {
		return e
	}
	if exists {
		return fault.New("feedback_attachment_draft_closed", 409)
	}
	return nil
}
func (a attachmentRow) receipt(now time.Time) Object {
	state := a.status(now)
	var retry, scan any
	if a.leaseUntil != nil {
		retry = iso(*a.leaseUntil)
	}
	if a.scan["state"] == "clean" || a.scan["state"] == "blocked" {
		scan = a.scan["state"]
	}
	return Object{"attachmentId": a.id, "operationId": a.operation, "name": a.name, "mediaType": a.media, "size": a.size, "sha256": a.hash, "state": state, "expiresAt": iso(a.expiry()), "uploadRetryAt": retry, "uploadRetryable": (state == "prepared" || state == "uploading") && (a.leaseUntil == nil || !a.leaseUntil.After(now)), "scanState": scan}
}

type attachmentTarget struct {
	OperationID  string `json:"operationId"`
	AttachmentID string `json:"attachmentId"`
}
type attachmentPrepare struct {
	OperationID  string `json:"operationId"`
	AttachmentID string `json:"attachmentId"`
	Name         string `json:"name"`
	MediaType    string `json:"mediaType"`
	Size         int64  `json:"size"`
	SHA256       string `json:"sha256"`
}

var mediaPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$`)

func attachmentInvalid() error { return fault.New("invalid_feedback_attachment_request", 400) }
func parseAttachmentTarget(raw []byte) (attachmentTarget, error) {
	var x attachmentTarget
	if protocol.Decode(raw, &x) != nil || !uuidPattern.MatchString(x.OperationID) || !uuidPattern.MatchString(x.AttachmentID) {
		return x, attachmentInvalid()
	}
	return x, nil
}
func parseAttachmentPrepare(raw []byte) (attachmentPrepare, error) {
	var x attachmentPrepare
	// Zod accepts integral JSON numbers including 1.0 and 1e0. Decode the
	// lexical number separately, then retain its normalized integer in the hash.
	var wire struct {
		OperationID  string          `json:"operationId"`
		AttachmentID string          `json:"attachmentId"`
		Name         string          `json:"name"`
		MediaType    string          `json:"mediaType"`
		Size         json.RawMessage `json:"size"`
		SHA256       string          `json:"sha256"`
	}
	if protocol.Decode(raw, &wire) != nil {
		return x, attachmentInvalid()
	}
	n, e := strconv.ParseFloat(string(wire.Size), 64)
	if e != nil || math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n < 1 || n > 67108864 {
		return x, attachmentInvalid()
	}
	x = attachmentPrepare{wire.OperationID, wire.AttachmentID, wire.Name, wire.MediaType, int64(n), wire.SHA256}
	x.Name = strings.TrimSpace(x.Name)
	if !uuidPattern.MatchString(x.OperationID) || !uuidPattern.MatchString(x.AttachmentID) || x.Name == "" || x.Name == "." || x.Name == ".." || protocol.TextLength(x.Name) > 180 || len(x.MediaType) > 120 || !mediaPattern.MatchString(x.MediaType) || x.Size < 1 || x.Size > 67108864 || !hashPattern.MatchString(x.SHA256) {
		return x, attachmentInvalid()
	}
	for _, c := range x.Name {
		if c < 32 || c == 127 || c == '/' || c == '\\' {
			return x, attachmentInvalid()
		}
	}
	return x, nil
}
func (s *Service) attachmentRepo() (*AttachmentRepository, error) {
	r, ok := s.Attachments.(*AttachmentRepository)
	if !ok || r == nil {
		return nil, fault.New("attachment_service_unavailable", 503)
	}
	return r, nil
}
func (s *Service) AttachmentConfig(ctx context.Context, account string) (Object, error) {
	r, e := s.attachmentRepo()
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.account(ctx, tx, account); e != nil {
			return nil, e
		}
		return r.Specification(), nil
	})
}

const storageUsage = `SELECT byte_size,subject_id AS owner_ref FROM chat_attachments WHERE purged_at IS NULL UNION ALL SELECT byte_size,'account:'||account_id::text AS owner_ref FROM forum_attachments_v1 WHERE purged_at IS NULL UNION ALL SELECT byte_size,'account:'||account_id::text AS owner_ref FROM feedback_attachments_v1 WHERE purged_at IS NULL`

func (s *Service) AttachmentPrepare(ctx context.Context, account string, raw []byte) (Object, error) {
	x, e := parseAttachmentPrepare(raw)
	if e != nil {
		return nil, e
	}
	r, e := s.attachmentRepo()
	if e != nil {
		return nil, e
	}
	if e = r.configured(); e != nil {
		return nil, e
	}
	if x.Size > r.policy().MaxFileBytes {
		return nil, fault.New("attachment_too_large", 413)
	}
	b, e := identity.Canonical(x)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(b)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.account(ctx, tx, account); e != nil {
			return nil, e
		}
		if e := r.lockDraft(ctx, tx, account, x.OperationID); e != nil {
			return nil, e
		}
		old, e := r.row(ctx, tx, x.AttachmentID, "UPDATE")
		if e == nil {
			if old.account != account || old.operation != x.OperationID || old.requestHash != hash || old.feedback != nil {
				return nil, fault.New("attachment_operation_conflict", 409)
			}
			return old.receipt(s.now()), nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		now := s.now()
		var count int
		e = tx.QueryRow(ctx, `SELECT count(*)::int FROM feedback_attachments_v1 WHERE endpoint=$1 AND account_id=$2 AND submission_operation_id=$3 AND revoked_at IS NULL AND purged_at IS NULL AND NOT purge_pending AND COALESCE(expires_at,prepare_expires_at)>$4`, s.Endpoint, account, x.OperationID, now).Scan(&count)
		if e != nil {
			return nil, e
		}
		if count >= r.maxFiles() {
			return nil, fault.New("feedback_attachment_count_exceeded", 400)
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912320,0)"); e != nil {
			return nil, e
		}
		var within bool
		e = tx.QueryRow(ctx, `SELECT COALESCE(sum(byte_size),0)+$2<=$3 AND COALESCE(sum(CASE WHEN owner_ref=$1 THEN byte_size ELSE 0 END),0)+$2<=$4 FROM (`+storageUsage+`) storage`, "account:"+account, x.Size, r.policy().MaxGlobalBytes, r.policy().MaxSubjectBytes).Scan(&within)
		if e != nil {
			return nil, e
		}
		if !within {
			return nil, fault.New("attachment_storage_quota_exceeded", 409)
		}
		a, e := attachmentScan(tx.QueryRow(ctx, `INSERT INTO feedback_attachments_v1(id,endpoint,account_id,submission_operation_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,created_at,prepare_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING `+attachmentColumns, x.AttachmentID, s.Endpoint, account, x.OperationID, hash, x.Name, x.MediaType, x.Size, x.SHA256, "feedback-attachments/"+x.AttachmentID, r.Store.KeyID(), now, now.Add(time.Hour)))
		if e != nil {
			return nil, e
		}
		return a.receipt(now), nil
	})
}
func (s *Service) AttachmentTarget(ctx context.Context, account string, raw []byte, revoke bool) (Object, error) {
	x, e := parseAttachmentTarget(raw)
	if e != nil {
		return nil, e
	}
	r, e := s.attachmentRepo()
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.account(ctx, tx, account); e != nil {
			return nil, e
		}
		lock := "SHARE"
		if revoke {
			lock = "UPDATE"
			if e := r.lockDraft(ctx, tx, account, x.OperationID); e != nil {
				return nil, e
			}
		}
		a, e := r.owned(ctx, tx, account, x, lock)
		if e != nil {
			return nil, e
		}
		if revoke {
			a, e = attachmentScan(tx.QueryRow(ctx, "UPDATE feedback_attachments_v1 SET revoked_at=COALESCE(revoked_at,$2),purge_pending=true WHERE id=$1 RETURNING "+attachmentColumns, a.id, s.now()))
			if e != nil {
				return nil, e
			}
		}
		return a.receipt(s.now()), nil
	})
}
func (s *Service) AttachmentUpload(ctx context.Context, account, id string, stream io.ReadCloser, length int64, media string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, attachmentInvalid()
	}
	r, e := s.attachmentRepo()
	if e != nil {
		return nil, e
	}
	operation, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (string, error) {
		if e := s.account(ctx, tx, account); e != nil {
			return "", e
		}
		a, e := r.row(ctx, tx, id, "SHARE")
		if errors.Is(e, pgx.ErrNoRows) || e == nil && (a.account != account || a.feedback != nil) {
			return "", fault.New("feedback_attachment_unavailable", 404)
		}
		return a.operation, e
	})
	if e != nil {
		return nil, e
	}
	if e = r.configured(); e != nil {
		return nil, e
	}
	if media != "application/octet-stream" {
		return nil, fault.New("attachment_media_type_required", 415)
	}
	lease := uuid.NewString()
	done := false
	a, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (attachmentRow, error) {
		if e := s.account(ctx, tx, account); e != nil {
			return attachmentRow{}, e
		}
		if e := r.lockDraft(ctx, tx, account, operation); e != nil {
			return attachmentRow{}, e
		}
		a, e := r.owned(ctx, tx, account, attachmentTarget{operation, id}, "UPDATE")
		if e != nil {
			return a, e
		}
		now := s.now()
		state := a.status(now)
		if !a.purge && (state == "scan-pending" || state == "scanning" || state == "available") {
			done = true
			return a, nil
		}
		if a.revoked != nil || a.purge || !a.expiry().After(now) || state != "prepared" && state != "uploading" {
			return a, fault.New("attachment_upload_unavailable", 409)
		}
		if length != a.size {
			return a, fault.New("attachment_size_mismatch", 400)
		}
		if a.leaseUntil != nil && a.leaseUntil.After(now) {
			return a, fault.New("attachment_upload_in_progress", 409)
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912320,0)"); e != nil {
			return a, e
		}
		var count int
		e = tx.QueryRow(ctx, `SELECT count(*)::int FROM (SELECT id FROM chat_attachments WHERE state='uploading' AND lease_until>$1 UNION ALL SELECT id FROM forum_attachments_v1 WHERE state='uploading' AND lease_until>$1 UNION ALL SELECT id FROM feedback_attachments_v1 WHERE state='uploading' AND lease_until>$1) uploading`, now).Scan(&count)
		if e != nil {
			return a, e
		}
		if count >= 4 {
			return a, fault.New("attachment_upload_capacity", 429)
		}
		return attachmentScan(tx.QueryRow(ctx, `UPDATE feedback_attachments_v1 SET state='uploading',lease_id=$2,lease_until=$3,uploaded_at=COALESCE(uploaded_at,$4),expires_at=COALESCE(expires_at,$5),last_error=NULL WHERE id=$1 RETURNING `+attachmentColumns, id, lease, now.Add(120*time.Second), now, now.Add(time.Duration(r.draftDays())*24*time.Hour)))
	})
	if e != nil {
		return nil, e
	}
	if done {
		return a.receipt(s.now()), nil
	}
	putAttempted := false
	bytes, e := attachments.ReadPayload(ctx, stream, attachments.Payload{Size: a.size, SHA256: a.hash, MediaType: a.media, MaxFileBytes: r.policy().MaxFileBytes})
	if e == nil {
		putAttempted = true
		e = r.Store.Put(ctx, a.storageKey, bytes, a.hash)
	}
	var result Object
	if e == nil {
		result, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
			if e := s.account(ctx, tx, account); e != nil {
				return nil, e
			}
			if e := r.lockDraft(ctx, tx, account, operation); e != nil {
				return nil, e
			}
			current, e := r.owned(ctx, tx, account, attachmentTarget{operation, id}, "UPDATE")
			if e != nil {
				return nil, e
			}
			if current.lease == nil || *current.lease != lease || current.revoked != nil || current.purge || !current.expiry().After(s.now()) {
				return nil, fault.New("attachment_upload_no_longer_allowed", 409)
			}
			current, e = attachmentScan(tx.QueryRow(ctx, "UPDATE feedback_attachments_v1 SET state='scan-pending',lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 RETURNING "+attachmentColumns, id))
			if e != nil {
				return nil, e
			}
			if e = s.queueAttachmentScanWithin(ctx, tx, current); e != nil {
				return nil, e
			}
			return current.receipt(s.now()), nil
		})
	}
	if e != nil {
		invalid := false
		switch fault.Code(e) {
		case "attachment_too_large", "attachment_size_mismatch", "attachment_digest_mismatch", "attachment_file_format_invalid", "attachment_media_type_mismatch", "attachment_media_type_unrecognized":
			invalid = true
		}
		code := fault.Code(e)
		if code == "internal_error" {
			code = "attachment_upload_failed"
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_, _ = s.Pool.Exec(cleanup, `UPDATE feedback_attachments_v1 SET lease_until=$3,last_error=$4,purge_pending=purge_pending OR revoked_at IS NOT NULL OR $5,state=CASE WHEN $5 THEN 'blocked' WHEN $6 THEN 'uploading' ELSE 'prepared' END WHERE id=$1 AND lease_id=$2`, id, lease, s.now(), code, invalid, putAttempted)
		return nil, e
	}
	return result, nil
}
