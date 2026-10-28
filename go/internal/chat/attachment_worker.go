package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

func (f *AttachmentService) diagnostic(stage, id string, e error) {
	if f.Diagnostic != nil {
		func() {
			defer func() { _ = recover() }()
			f.Diagnostic(Object{"event": "attachment_processing_deferred", "stage": stage, "resourceId": id, "error": fault.Code(e)})
		}()
	}
}
func (f *AttachmentService) pendingOutside(ctx context.Context, r Object) (bool, error) {
	var pending bool
	_, e := postgres.InTx(ctx, f.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		var e error
		pending, e = f.authorPending(ctx, tx, r)
		return Object{}, e
	})
	return pending, e
}
func (f *AttachmentService) ScanPending(ctx context.Context, limit int) (Object, error) {
	if e := f.configured(); e != nil {
		return nil, e
	}
	if limit < 1 || limit > 4 {
		return nil, fail("invalid_attachment_scan_limit", 400)
	}
	scanned := 0
	for i := 0; i < limit; i++ {
		lease := uuid.NewString()
		r, e := postgres.InTx(ctx, f.Chat.Pool, func(tx pgx.Tx) (Object, error) {
			r, e := row(ctx, tx, "SELECT to_jsonb(a) FROM chat_attachments a WHERE state IN ('scan-pending','scanning') AND revoked_at IS NULL AND purge_pending=false AND expires_at>$1 AND (lease_until IS NULL OR lease_until<=$1) ORDER BY uploaded_at LIMIT 1 FOR UPDATE SKIP LOCKED", f.Chat.now())
			if e != nil || r == nil {
				return nil, e
			}
			return row(ctx, tx, "UPDATE chat_attachments SET state='scanning',lease_id=$2,lease_until=$3,scan_attempts=scan_attempts+1 WHERE id=$1 RETURNING to_jsonb(chat_attachments)", r["id"], lease, f.Chat.now().Add(120*time.Second))
		})
		if e != nil {
			return nil, e
		}
		if r == nil {
			break
		}
		scanError := func() error {
			pending, e := f.pendingOutside(ctx, r)
			if e != nil {
				return e
			}
			if pending {
				return fail("attachment_author_unavailable")
			}
			bytes, e := f.Store.Get(ctx, str(r, "storage_key"), str(r, "encryption_key_id"), num(r, "byte_size"))
			if e != nil {
				return e
			}
			if bytes == nil || attachments.Digest(bytes) != str(r, "sha256") {
				return fail("attachment_storage_integrity_failed")
			}
			result, e := f.Scanner.Scan(ctx, bytes)
			if e != nil {
				return e
			}
			if !has([]string{"clean", "blocked"}, str(result, "state")) {
				return fail("attachment_scan_incomplete", 503)
			}
			_, e = postgres.InTx(ctx, f.Chat.Pool, func(tx pgx.Tx) (Object, error) {
				current, e := f.row(ctx, tx, str(r, "id"), true)
				if e != nil {
					return nil, e
				}
				if str(current, "lease_id") != lease {
					return Object{}, nil
				}
				pending, e := f.authorPending(ctx, tx, current)
				if e != nil {
					return nil, e
				}
				if pending {
					return nil, fail("attachment_author_unavailable")
				}
				invalid := current["revoked_at"] != nil || f.expired(current)
				state := "available"
				if invalid || str(result, "state") == "blocked" {
					state = "blocked"
				}
				_, e = tx.Exec(ctx, "UPDATE chat_attachments SET state=$2,scan_result=$3,lease_id=NULL,lease_until=NULL,last_error=NULL,purge_pending=$4 WHERE id=$1", r["id"], state, encode(result), invalid || str(result, "state") == "blocked")
				return Object{}, e
			})
			return e
		}()
		if scanError == nil {
			scanned++
			continue
		}
		f.diagnostic("attachment-scan", str(r, "id"), scanError)
		code := fault.Code(scanError)
		if code == "internal_error" {
			code = "attachment_scan_failed"
		}
		if _, e = f.Chat.Pool.Exec(ctx, "UPDATE chat_attachments SET state='scan-pending',lease_id=NULL,lease_until=$3,last_error=$4 WHERE id=$1 AND lease_id=$2", r["id"], lease, f.Chat.now().Add(60*time.Second), code); e != nil {
			return nil, e
		}
	}
	return Object{"scanned": scanned}, nil
}

const automaticChatCleanup = `(a.revoked_at IS NOT NULL OR a.scan_result->>'state'='blocked' OR a.last_error IN('attachment_too_large','attachment_digest_mismatch','attachment_file_format_invalid','attachment_media_type_mismatch','attachment_media_type_unrecognized') OR EXISTS(SELECT 1 FROM chat_message_refs m WHERE m.message_id=a.message_id AND m.state='retracted') OR (a.message_id IS NULL AND COALESCE(a.expires_at,a.prepare_expires_at)<=$1 AND a.state IN('prepared','uploading','scan-pending','scanning') AND COALESCE(a.scan_result->>'state','')<>'clean'))`

func (f *AttachmentService) automatic(ctx context.Context, tx pgx.Tx, r Object) (bool, error) {
	if r["purged_at"] != nil || str(r, "state") == "erased" {
		return false, nil
	}
	if r["lease_id"] != nil && r["lease_until"] != nil && millis(r["lease_until"]) > f.Chat.now().UnixMilli() {
		return false, nil
	}
	if r["revoked_at"] != nil || str(obj(r, "scan_result"), "state") == "blocked" || has([]string{"attachment_too_large", "attachment_digest_mismatch", "attachment_file_format_invalid", "attachment_media_type_mismatch", "attachment_media_type_unrecognized"}, str(r, "last_error")) {
		return true, nil
	}
	if r["message_id"] != nil {
		var withdrawn bool
		e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM chat_message_refs WHERE message_id=$1 AND state='retracted')", r["message_id"]).Scan(&withdrawn)
		return withdrawn, e
	}
	return f.expired(r) && has([]string{"prepared", "uploading", "scan-pending", "scanning"}, str(r, "state")) && str(obj(r, "scan_result"), "state") != "clean", nil
}

// Cleanup consumes only the original automatic owner/security/withdrawal cases.
// A clean retained file's elapsed lifetime still requires an approved plan.
func (f *AttachmentService) PurgeExpired(ctx context.Context, limit int) (Object, error) {
	if e := f.configured(); e != nil {
		return nil, e
	}
	if limit < 1 || limit > 100 {
		return nil, fail("invalid_attachment_cleanup_limit", 400)
	}
	if !objectremoval.Capable(f.Store) {
		return nil, fail("attachment_cleanup_unavailable", 503)
	}
	if _, e := f.Chat.Pool.Exec(ctx, "UPDATE chat_attachments a SET purge_pending=true WHERE a.purged_at IS NULL AND "+automaticChatCleanup, f.Chat.now()); e != nil {
		return nil, e
	}
	rr, e := f.Chat.Pool.Query(ctx, "SELECT a.id::text FROM chat_attachments a WHERE a.purge_pending=true AND a.purged_at IS NULL AND (a.lease_until IS NULL OR a.lease_until<=$1) AND ("+automaticChatCleanup+" OR a.last_error='attachment_cleanup_failed' OR EXISTS(SELECT 1 FROM galaxy_go_storage.object_removals_v1 removal WHERE removal.endpoint=$3 AND removal.domain='chat' AND removal.object_id=a.id)) ORDER BY a.created_at LIMIT $2", f.Chat.now(), limit, f.Chat.Endpoint)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for rr.Next() {
		var id string
		if e = rr.Scan(&id); e != nil {
			rr.Close()
			return nil, e
		}
		ids = append(ids, id)
	}
	e = rr.Err()
	rr.Close()
	if e != nil {
		return nil, e
	}
	removed, pending := 0, 0
	for _, id := range ids {
		result, e := f.removeObject(ctx, id)
		if e != nil {
			f.diagnostic("attachment-cleanup", id, e)
			if fault.Code(e) == "internal_error" {
				return nil, e
			}
			pending++
			continue
		}
		if truth(result, "removed") {
			removed++
		}
		if truth(result, "pending") {
			pending++
		}
	}
	tag, e := f.Chat.Pool.Exec(ctx, "DELETE FROM chat_attachments a WHERE a.purged_at IS NOT NULL AND (a.purged_at<$1 OR EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=a.subject_id AND d.state IN ('partial','primary-erased')))", f.Chat.now().Add(-180*24*time.Hour))
	if e != nil {
		return nil, e
	}
	return Object{"objectRemoved": removed, "metadataRemoved": tag.RowsAffected(), "pendingObjects": pending, "physicalBlockErasure": "storage-garbage-collection"}, nil
}
