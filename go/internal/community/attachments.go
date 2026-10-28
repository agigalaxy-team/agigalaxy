package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/jackc/pgx/v5"
	"sort"
	"time"
)

func (s *Service) attachmentAccess(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	var until *time.Time
	e := tx.QueryRow(ctx, "SELECT (SELECT stopped_until FROM operations_file_access_heads_v1 WHERE endpoint=$1 AND kind='forum' AND file_id=$2)", s.Endpoint, id).Scan(&until)
	if e != nil {
		return nil, e
	}
	var value any
	if until != nil {
		value = until.Unix()
	}
	return Object{"stopped": until != nil && until.Unix() > s.clock(), "until": value}, nil
}
func (s *Service) attachmentState(r Object) string {
	if r["purged_at"] != nil {
		return "erased"
	}
	if r["revoked_at"] != nil {
		return "revoked"
	}
	expires := r["expires_at"]
	if expires == nil {
		expires = r["prepare_expires_at"]
	}
	if seconds(expires) <= s.clock() {
		return "expired"
	}
	return str(r, "state")
}
func attachmentTime(v any) any {
	if v == nil {
		return nil
	}
	t, e := time.Parse(time.RFC3339Nano, asString(v))
	if e != nil {
		return nil
	}
	return stamp(t)
}
func (s *Service) attachmentReceipt(ctx context.Context, tx pgx.Tx, r Object) (Object, error) {
	state := s.attachmentState(r)
	expires := r["expires_at"]
	if expires == nil {
		expires = r["prepare_expires_at"]
	}
	retryable := r["published_at"] == nil && r["revoked_at"] == nil && r["purged_at"] == nil && seconds(expires) > s.clock() && (str(r, "state") == "prepared" || str(r, "state") == "uploading") && (r["lease_until"] == nil || seconds(r["lease_until"]) <= s.clock())
	access, e := s.attachmentAccess(ctx, tx, str(r, "id"))
	if e != nil {
		return nil, e
	}
	out := Object{"attachmentId": r["id"], "name": r["name"], "mediaType": r["media_type"], "size": num(r, "byte_size"), "sha256": r["sha256"], "state": state, "createdAt": attachmentTime(r["created_at"]), "uploadedAt": attachmentTime(r["uploaded_at"]), "expiresAt": attachmentTime(expires), "uploadRetryAt": attachmentTime(r["lease_until"]), "uploadRetryable": retryable, "scan": r["scan_result"], "cleanupPending": truth(r, "purge_pending"), "objectRemoved": r["purged_at"] != nil, "processingState": state, "access": access}

	if truth(r, "purge_pending") || r["purged_at"] != nil {
		removal, e := (&objectremoval.Service{Endpoint: s.Endpoint}).ReadStateWithin(ctx, tx, "forum", str(r, "id"))
		if e != nil {
			return nil, e
		}
		if removal != nil {
			out["cleanup"] = Object{"state": objectremoval.CleanupState(removal), "objectRemoved": removal["objectRemoved"], "operationId": removal["operationId"]}
		}
	}
	if truth(access, "stopped") {
		if state != "erased" && state != "revoked" && state != "expired" && state != "blocked" {
			out["state"] = "unavailable"
		}
		out["contentAvailable"] = false
	}
	return out, nil
}
func (s *Service) attachmentMetadata(ctx context.Context, tx pgx.Tx, references []any) ([]Object, error) {
	ids := []string{}
	for _, v := range references {
		r, _ := v.(map[string]any)
		ids = append(ids, str(r, "id"))
	}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(a) FROM forum_attachments_v1 a WHERE id=ANY($1::uuid[])", ids)
	if e != nil {
		return nil, e
	}
	byID := map[string]Object{}
	for _, r := range rr {
		byID[str(r, "id")] = r
	}
	out := []Object{}
	for _, v := range references {
		ref, _ := v.(map[string]any)
		r := byID[str(ref, "id")]
		if r == nil || str(r, "sha256") != str(ref, "sha256") {
			out = append(out, Object{"attachmentId": ref["id"], "state": "unavailable", "contentAvailable": false})
			continue
		}
		receipt, e := s.attachmentReceipt(ctx, tx, r)
		if e != nil {
			return nil, e
		}
		out = append(out, receipt)
	}
	return out, nil
}
func (s *Service) bindAttachments(ctx context.Context, tx pgx.Tx, account string, p Object) error {
	if s.Attachments != nil {
		return s.Attachments.Bind(ctx, tx, account, p)
	}
	refs, _ := p["attachments"].([]any)
	sorted := append([]any{}, refs...)
	sort.Slice(sorted, func(i, j int) bool {
		a, _ := sorted[i].(map[string]any)
		b, _ := sorted[j].(map[string]any)
		return str(a, "id") < str(b, "id")
	})
	for _, value := range sorted {
		ref, _ := value.(map[string]any)
		r, e := row(ctx, tx, "SELECT to_jsonb(a) FROM forum_attachments_v1 a WHERE id=$1 FOR UPDATE", ref["id"])
		if e != nil {
			return e
		}
		if r == nil || str(r, "account_id") != account || str(r, "sha256") != str(ref, "sha256") || truth(r, "purge_pending") || s.attachmentState(r) != "available" {
			return fail("attachment_reference_unavailable", 409)
		}
		access, e := s.attachmentAccess(ctx, tx, str(r, "id"))
		if e != nil {
			return e
		}
		if truth(access, "stopped") {
			return fail("attachment_content_unavailable", 404)
		}
		version := p["versionId"]
		key := "post:" + asString(version)
		if p["replyId"] != nil {
			version = p["postVersionId"]
			key = "reply:" + str(p, "replyId")
		}
		_, e = tx.Exec(ctx, `INSERT INTO forum_attachment_links_v1(attachment_id,source_key,post_id,version_id,reply_id,published_until,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, r["id"], key, p["postId"], version, p["replyId"], time.Unix(num(p, "publishedUntil"), 0), s.now())
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "UPDATE forum_attachments_v1 SET published_at=coalesce(published_at,$2),expires_at=(SELECT max(published_until) FROM forum_attachment_links_v1 WHERE attachment_id=$1) WHERE id=$1", r["id"], s.now())
		if e != nil {
			return e
		}
	}
	return nil
}
