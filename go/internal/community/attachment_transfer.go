package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"io"
	"time"
)

func (f *AttachmentService) Upload(ctx context.Context, a AttachmentActor, id string, stream io.ReadCloser, length int64, media string, onBytes func(int)) (Object, error) {
	if !validID(id) {
		return nil, fail("invalid_attachment_request", 400)
	}
	if e := f.configured(); e != nil {
		return nil, e
	}
	if media != "application/octet-stream" {
		return nil, fail("attachment_media_type_required", 415)
	}
	lease := uuid.NewString()
	started, e := f.run(ctx, a, true, func(s *Service, tx pgx.Tx, account string) (Object, error) {
		r, e := f.owned(ctx, tx, account, id, true)
		if e != nil {
			return nil, e
		}
		state := s.attachmentState(r)
		if hasString([]string{"scan-pending", "scanning", "available"}, state) {
			return Object{"done": true}, nil
		}
		if state == "expired" || r["revoked_at"] != nil || r["purged_at"] != nil || r["published_at"] != nil || !hasString([]string{"prepared", "uploading"}, str(r, "state")) {
			return nil, fail("attachment_upload_unavailable", 409)
		}
		if length != num(r, "byte_size") {
			return nil, fail("attachment_size_mismatch", 400)
		}
		if r["lease_until"] != nil && seconds(r["lease_until"]) > s.clock() {
			return nil, fail("attachment_upload_in_progress", 409)
		}
		if e = f.rule(ctx, tx, s, account, id, "upload-start", num(r, "byte_size")); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912320,0)"); e != nil {
			return nil, e
		}
		var n int
		e = tx.QueryRow(ctx, "SELECT (SELECT count(*) FROM chat_attachments WHERE state='uploading' AND lease_until>$1)+(SELECT count(*) FROM forum_attachments_v1 WHERE state='uploading' AND lease_until>$1)+(SELECT count(*) FROM feedback_attachments_v1 WHERE state='uploading' AND lease_until>$1)", s.now()).Scan(&n)
		if e != nil {
			return nil, e
		}
		if n >= 4 {
			return nil, fail("attachment_upload_capacity", 429)
		}
		return row(ctx, tx, "UPDATE forum_attachments_v1 SET state='uploading',lease_id=$2,lease_until=$3,uploaded_at=COALESCE(uploaded_at,$4),expires_at=COALESCE(expires_at,$5),last_error=NULL WHERE id=$1 RETURNING to_jsonb(forum_attachments_v1)", id, lease, s.now().Add(120*time.Second), s.now(), s.now().Add(7*24*time.Hour))
	})
	if e != nil {
		return nil, e
	}
	if truth(started, "done") {
		return f.Get(ctx, a, encode(Object{"attachmentId": id}))
	}
	putAttempted := false
	bytes, e := attachments.ReadPayload(ctx, stream, attachments.Payload{Size: num(started, "byte_size"), SHA256: str(started, "sha256"), MediaType: str(started, "media_type"), MaxFileBytes: f.policy().MaxFileBytes, OnBytes: onBytes})
	if e == nil {
		_, e = f.run(ctx, a, true, func(s *Service, tx pgx.Tx, account string) (Object, error) {
			r, e := f.owned(ctx, tx, account, id, true)
			if e != nil {
				return nil, e
			}
			if str(r, "lease_id") != lease || r["revoked_at"] != nil || s.attachmentState(r) == "expired" {
				return nil, fail("attachment_upload_no_longer_allowed", 409)
			}
			if e = f.rule(ctx, tx, s, account, id, "upload-bytes", num(r, "byte_size")); e != nil {
				return nil, e
			}
			putAttempted = true
			e = f.Store.Put(ctx, str(started, "storage_key"), bytes, str(started, "sha256"))
			return Object{}, e
		})
	}
	if e == nil {
		var receipt Object
		receipt, e = f.run(ctx, a, true, func(s *Service, tx pgx.Tx, account string) (Object, error) {
			r, e := f.owned(ctx, tx, account, id, true)
			if e != nil {
				return nil, e
			}
			if str(r, "lease_id") != lease || r["revoked_at"] != nil || s.attachmentState(r) == "expired" {
				return nil, fail("attachment_upload_no_longer_allowed", 409)
			}
			r, e = row(ctx, tx, "UPDATE forum_attachments_v1 SET state='scan-pending',lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 RETURNING to_jsonb(forum_attachments_v1)", id)
			if e != nil {
				return nil, e
			}
			return s.attachmentReceipt(ctx, tx, r)
		})
		if e == nil {
			return receipt, nil
		}
	}
	code := fault.Code(e)
	invalid := hasString([]string{"attachment_too_large", "attachment_digest_mismatch", "attachment_file_format_invalid", "attachment_media_type_mismatch", "attachment_media_type_unrecognized"}, code)
	if code == "internal_error" {
		code = "attachment_upload_failed"
	}
	_, _ = f.Forum.Pool.Exec(ctx, "UPDATE forum_attachments_v1 SET lease_until=$3,last_error=$4,purge_pending=purge_pending OR revoked_at IS NOT NULL OR $5,state=CASE WHEN $5 THEN 'blocked' WHEN $6 THEN 'uploading' ELSE 'prepared' END WHERE id=$1 AND lease_id=$2", id, lease, f.Forum.now(), code, invalid, putAttempted)
	return nil, e
}

type AttachmentContent struct {
	Bytes                                 []byte
	Name, MediaType, SHA256, AttachmentID string
}

func parseAttachmentSource(v any) (Object, bool) {
	x, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	if strict(x, "replyId") && validID(str(x, "replyId")) {
		return x, true
	}
	return x, strict(x, "postId", "versionId") && validID(str(x, "postId")) && validID(str(x, "versionId"))
}
func (f *AttachmentService) readable(ctx context.Context, tx pgx.Tx, s *Service, account string, r, source Object) error {
	if r == nil || s.attachmentState(r) != "available" {
		return fail("attachment_content_unavailable", 404)
	}
	access, e := s.attachmentAccess(ctx, tx, str(r, "id"))
	if e != nil {
		return e
	}
	if truth(access, "stopped") {
		return fail("attachment_content_unavailable", 404)
	}
	var view Object
	key := "post:" + str(source, "versionId")
	if source["replyId"] != nil {
		key = "reply:" + str(source, "replyId")
		view, e = s.readReply(ctx, tx, str(source, "replyId"), account)
	} else {
		view, e = s.readVersion(ctx, tx, str(source, "postId"), str(source, "versionId"), account)
	}
	if e != nil {
		return e
	}
	if str(view, "availability") != "available" || source["replyId"] != nil && str(view, "parentAvailability") != "available" {
		return fail("attachment_source_unavailable", 404)
	}
	found := false
	refs, _ := obj(view, "payload")["attachments"].([]any)
	for _, value := range refs {
		ref, _ := value.(map[string]any)
		found = found || str(ref, "id") == str(r, "id") && ref["sha256"] == r["sha256"]
	}
	if !found {
		return fail("attachment_source_unavailable", 404)
	}
	var linked bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM forum_attachment_links_v1 WHERE attachment_id=$1 AND source_key=$2 AND published_until>$3)", r["id"], key, s.now()).Scan(&linked)
	if e != nil {
		return e
	}
	if !linked {
		return fail("attachment_source_unavailable", 404)
	}
	return nil
}
func (f *AttachmentService) Content(ctx context.Context, a AttachmentActor, raw []byte) (AttachmentContent, error) {
	var out AttachmentContent
	x, e := attachmentInput(raw, "attachmentId", "source")
	if e != nil || !validID(str(x, "attachmentId")) {
		return out, fail("invalid_attachment_request", 400)
	}
	source, ok := parseAttachmentSource(x["source"])
	if !ok {
		return out, fail("invalid_attachment_request", 400)
	}
	if e = f.configured(); e != nil {
		return out, e
	}
	s := f.scoped(a, false)
	_, e = s.run(ctx, a.AccountID, func(tx pgx.Tx) (Object, error) {
		r, e := f.row(ctx, tx, str(x, "attachmentId"), false)
		if e != nil {
			return nil, e
		}
		if e = f.readable(ctx, tx, s, a.AccountID, r, source); e != nil {
			return nil, e
		}
		bytes, e := f.Store.Get(ctx, str(r, "storage_key"), str(r, "encryption_key_id"), num(r, "byte_size"))
		if e != nil {
			return nil, e
		}
		if bytes == nil || attachments.Digest(bytes) != str(r, "sha256") {
			return nil, fail("attachment_storage_integrity_failed", 502)
		}
		r, e = f.row(ctx, tx, str(x, "attachmentId"), false)
		if e != nil {
			return nil, e
		}
		if e = f.readable(ctx, tx, s, a.AccountID, r, source); e != nil {
			return nil, e
		}
		out = AttachmentContent{Bytes: bytes, Name: str(r, "name"), MediaType: str(r, "media_type"), SHA256: str(r, "sha256"), AttachmentID: str(r, "id")}
		return Object{}, nil
	})
	return out, e
}
