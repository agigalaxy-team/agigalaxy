package feedback

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"sort"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// Repository shares the current attachment ledger; it neither manufactures a
// clean scan nor assumes a configured byte store is actually available.
type AttachmentRepository struct {
	Endpoint               string
	Store                  attachments.Store
	Scanner                attachments.Scanner
	Policy                 attachments.Policy
	DraftRetentionDays     int
	SubmittedRetentionDays int
	Now                    func() time.Time
}
type attachmentRow struct {
	id, account, operation, name, media, hash, state string
	size                                             int64
	feedback                                         *string
	created, prepare                                 time.Time
	uploaded, expires, revoked, purged               *time.Time
	purge                                            bool
	scan                                             map[string]any
	requestHash, storageKey, keyID                   string
	lease                                            *string
	leaseUntil                                       *time.Time
}

const attachmentColumns = `id::text,account_id::text,submission_operation_id::text,feedback_id::text,name,media_type,byte_size,sha256,state,created_at,prepare_expires_at,uploaded_at,expires_at,revoked_at,purged_at,purge_pending,scan_result,request_hash,storage_key,encryption_key_id,lease_id::text,lease_until`

func attachmentScan(row pgx.Row) (r attachmentRow, e error) {
	e = row.Scan(&r.id, &r.account, &r.operation, &r.feedback, &r.name, &r.media, &r.size, &r.hash, &r.state, &r.created, &r.prepare, &r.uploaded, &r.expires, &r.revoked, &r.purged, &r.purge, &r.scan, &r.requestHash, &r.storageKey, &r.keyID, &r.lease, &r.leaseUntil)
	return
}
func (r attachmentRow) expiry() time.Time {
	if r.expires != nil {
		return *r.expires
	}
	return r.prepare
}
func (r attachmentRow) status(now time.Time) string {
	if r.purged != nil {
		return "erased"
	}
	if r.revoked != nil {
		return "revoked"
	}
	if !r.expiry().After(now) {
		return "expired"
	}
	return r.state
}
func (r *AttachmentRepository) Bind(ctx context.Context, tx pgx.Tx, account, operation, feedback string, refs []Reference, now time.Time) error {
	if len(refs) == 0 {
		return nil
	}
	if !r.ready() {
		return fault.New("attachment_service_unavailable", 503)
	}
	ordered := append([]Reference(nil), refs...)
	if len(refs) > r.maxFiles() {
		return fault.New("feedback_attachment_count_exceeded", 400)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	for _, ref := range ordered {
		a, e := attachmentScan(tx.QueryRow(ctx, "SELECT "+attachmentColumns+" FROM feedback_attachments_v1 WHERE id=$1 AND endpoint=$2 FOR UPDATE", ref.ID, r.Endpoint))
		if errors.Is(e, pgx.ErrNoRows) {
			return fault.New("feedback_attachment_unavailable", 404)
		}
		if e != nil {
			return e
		}
		if a.account != account || a.operation != operation || a.feedback != nil {
			return fault.New("feedback_attachment_unavailable", 404)
		}
		if a.hash != ref.SHA256 || a.purge || a.status(now) != "available" || a.scan["state"] != "clean" || a.uploaded == nil {
			return fault.New("feedback_attachment_not_ready", 409)
		}
		_, e = tx.Exec(ctx, "UPDATE feedback_attachments_v1 SET feedback_id=$2,bound_at=$3,expires_at=$4 WHERE id=$1", a.id, feedback, now, a.uploaded.Add(time.Duration(r.submittedDays())*24*time.Hour))
		if e != nil {
			return e
		}
	}
	return nil
}
func (r *AttachmentRepository) List(ctx context.Context, tx pgx.Tx, feedback string) ([]Object, error) {
	rows, e := tx.Query(ctx, "SELECT "+attachmentColumns+" FROM feedback_attachments_v1 WHERE endpoint=$1 AND feedback_id=$2 ORDER BY created_at,id", r.Endpoint, feedback)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	now := time.Now()
	if r.Now != nil {
		now = r.Now()
	}
	for rows.Next() {
		a, e := attachmentScan(rows)
		if e != nil {
			return nil, e
		}
		state := a.status(now)
		availability := "unavailable"
		if r.ready() && state == "available" && a.scan["state"] == "clean" && !a.purge {
			availability = "available"
		}
		name := a.name
		if name == "" {
			name = "已移除的附件"
		}
		out = append(out, Object{"id": a.id, "name": name, "mediaType": a.media, "byteSize": a.size, "sha256": a.hash, "state": state, "expiresAt": iso(a.expiry()), "url": nil, "availability": availability})
	}
	return out, rows.Err()
}
