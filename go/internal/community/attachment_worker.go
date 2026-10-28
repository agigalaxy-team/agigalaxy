package community

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
		r, e := postgres.InTx(ctx, f.Forum.Pool, func(tx pgx.Tx) (Object, error) {
			r, e := row(ctx, tx, "SELECT to_jsonb(a) FROM forum_attachments_v1 a WHERE state IN ('scan-pending','scanning') AND revoked_at IS NULL AND purge_pending=false AND expires_at>$1 AND (lease_until IS NULL OR lease_until<=$1) ORDER BY uploaded_at LIMIT 1 FOR UPDATE SKIP LOCKED", f.Forum.now())
			if e != nil || r == nil {
				return r, e
			}
			return row(ctx, tx, "UPDATE forum_attachments_v1 SET state='scanning',lease_id=$2,lease_until=$3,scan_attempts=scan_attempts+1 WHERE id=$1 RETURNING to_jsonb(forum_attachments_v1)", r["id"], lease, f.Forum.now().Add(120*time.Second))
		})
		if e != nil {
			return nil, e
		}
		if r == nil {
			break
		}
		scanError := func() error {
			bytes, e := f.Store.Get(ctx, str(r, "storage_key"), str(r, "encryption_key_id"), num(r, "byte_size"))
			if e != nil {
				return e
			}
			if bytes == nil || attachments.Digest(bytes) != str(r, "sha256") {
				return fail("attachment_storage_integrity_failed", 409)
			}
			result, e := f.Scanner.Scan(ctx, bytes)
			if e != nil {
				return e
			}
			if !hasString([]string{"clean", "blocked"}, str(result, "state")) {
				return fail("attachment_scan_incomplete", 503)
			}
			_, e = postgres.InTx(ctx, f.Forum.Pool, func(tx pgx.Tx) (Object, error) {
				current, e := f.row(ctx, tx, str(r, "id"), true)
				if e != nil {
					return nil, e
				}
				if current == nil || str(current, "lease_id") != lease {
					return Object{}, nil
				}
				invalid := current["revoked_at"] != nil || f.Forum.attachmentState(current) == "expired"
				blocked := invalid || str(result, "state") == "blocked"
				state := "available"
				if blocked {
					state = "blocked"
				}
				_, e = tx.Exec(ctx, "UPDATE forum_attachments_v1 SET state=$2,scan_result=$3,lease_id=NULL,lease_until=NULL,last_error=NULL,purge_pending=$4 WHERE id=$1", r["id"], state, encode(result), blocked)
				return Object{}, e
			})
			return e
		}()
		if scanError == nil {
			scanned++
			continue
		}
		code := fault.Code(scanError)
		if code == "internal_error" {
			code = "attachment_scan_failed"
		}
		if f.Diagnostic != nil {
			func() {
				defer func() { _ = recover() }()
				f.Diagnostic(Object{"event": "attachment_processing_deferred", "stage": "attachment-scan", "resourceId": r["id"], "error": code})
			}()
		}
		if _, e = f.Forum.Pool.Exec(ctx, "UPDATE forum_attachments_v1 SET state='scan-pending',lease_id=NULL,lease_until=$3,last_error=$4 WHERE id=$1 AND lease_id=$2", r["id"], lease, f.Forum.now().Add(time.Minute), code); e != nil {
			return nil, e
		}
	}
	return Object{"scanned": scanned}, nil
}

var forumInvalidUploads = []string{"attachment_too_large", "attachment_digest_mismatch", "attachment_file_format_invalid", "attachment_media_type_mismatch", "attachment_media_type_unrecognized"}

const forumAutomaticCleanup = `(a.revoked_at IS NOT NULL OR a.scan_result->>'state'='blocked' OR a.last_error IN('attachment_too_large','attachment_digest_mismatch','attachment_file_format_invalid','attachment_media_type_mismatch','attachment_media_type_unrecognized') OR (EXISTS(SELECT 1 FROM forum_attachment_links_v1 l WHERE l.attachment_id=a.id) AND NOT EXISTS(SELECT 1 FROM forum_attachment_links_v1 l LEFT JOIN forum_posts_v1 p ON p.id=l.post_id LEFT JOIN forum_versions_v1 v ON v.id=l.version_id LEFT JOIN forum_replies_v1 r ON r.id=l.reply_id WHERE l.attachment_id=a.id AND NOT COALESCE(CASE WHEN l.reply_id IS NOT NULL THEN r.state='withdrawn' ELSE p.state='withdrawn' OR v.state='withdrawn' END,false))) OR ((a.published_at IS NULL AND NOT EXISTS(SELECT 1 FROM forum_attachment_links_v1 l WHERE l.attachment_id=a.id)) AND COALESCE(a.expires_at,a.prepare_expires_at)<=$1 AND a.state IN('prepared','uploading','scan-pending','scanning') AND COALESCE(a.scan_result->>'state','')<>'clean'))`

func (f *AttachmentService) automaticCleanup(ctx context.Context, tx pgx.Tx, r Object) (bool, error) {
	if r["revoked_at"] != nil || str(obj(r, "scan_result"), "state") == "blocked" || hasString(forumInvalidUploads, str(r, "last_error")) {
		return true, nil
	}
	links, e := rows(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT l.source_key,l.reply_id,p.state post_state,v.state version_state,r.state reply_state FROM forum_attachment_links_v1 l LEFT JOIN forum_posts_v1 p ON p.id=l.post_id LEFT JOIN forum_versions_v1 v ON v.id=l.version_id LEFT JOIN forum_replies_v1 r ON r.id=l.reply_id WHERE l.attachment_id=$1 ORDER BY l.source_key LIMIT 201)q`, r["id"])
	if e != nil {
		return false, e
	}
	if len(links) > 200 {
		return false, nil
	}
	withdrawn := len(links) > 0
	for _, link := range links {
		if link["reply_id"] != nil {
			withdrawn = withdrawn && str(link, "reply_state") == "withdrawn"
		} else {
			withdrawn = withdrawn && (str(link, "post_state") == "withdrawn" || str(link, "version_state") == "withdrawn")
		}
	}
	if withdrawn {
		return true, nil
	}
	return r["published_at"] == nil && len(links) == 0 && f.Forum.attachmentState(r) == "expired" && hasString([]string{"prepared", "uploading", "scan-pending", "scanning"}, str(r, "state")) && str(obj(r, "scan_result"), "state") != "clean", nil
}
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
	if _, e := f.Forum.Pool.Exec(ctx, "UPDATE forum_attachments_v1 a SET purge_pending=true WHERE a.purged_at IS NULL AND "+forumAutomaticCleanup, f.Forum.now()); e != nil {
		return nil, e
	}
	rr, e := f.Forum.Pool.Query(ctx, "SELECT a.id::text FROM forum_attachments_v1 a WHERE a.purge_pending=true AND a.purged_at IS NULL AND (a.lease_until IS NULL OR a.lease_until<=$1) AND ("+forumAutomaticCleanup+" OR a.last_error='attachment_cleanup_failed' OR EXISTS(SELECT 1 FROM galaxy_go_storage.object_removals_v1 removal WHERE removal.endpoint=$3 AND removal.domain='forum' AND removal.object_id=a.id)) ORDER BY a.created_at LIMIT $2", f.Forum.now(), limit, f.Forum.Endpoint)
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
			return nil, e
		}
		if truth(result, "removed") {
			removed++
		}
		if truth(result, "pending") {
			pending++
		}
	}
	tag, e := f.Forum.Pool.Exec(ctx, "DELETE FROM forum_attachments_v1 WHERE purged_at<$1", f.Forum.now().Add(-180*24*time.Hour))
	if e != nil {
		return nil, e
	}
	return Object{"objectRemoved": removed, "metadataRemoved": tag.RowsAffected(), "pendingObjects": pending}, nil
}
