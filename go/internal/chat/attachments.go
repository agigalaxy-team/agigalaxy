package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"io"
	"math/big"
	"regexp"
	"sort"
	"time"
)

type AttachmentService struct {
	Removals   *objectremoval.Service
	Chat       *Service
	Store      attachments.Store
	Scanner    attachments.Scanner
	Policy     attachments.Policy
	Diagnostic func(Object)
}
type AttachmentContent struct {
	Bytes                                 []byte
	Name, MediaType, SHA256, AttachmentID string
}

func (f *AttachmentService) policy() attachments.Policy {
	if f.Policy.Version == 0 {
		return attachments.DefaultPolicy()
	}
	return f.Policy
}
func (f *AttachmentService) configured() error {
	if f.Store == nil || f.Scanner == nil {
		return fail("attachment_service_unavailable", 503)
	}
	return nil
}
func (f *AttachmentService) Specification() Object {
	p := f.policy()
	return Object{"supported": f.Store != nil && f.Scanner != nil, "storageRuntimeVerified": false, "retentionDays": 30, "startsAt": "first-upload-start", "maxFileBytes": p.MaxFileBytes, "maxSubjectBytes": p.MaxSubjectBytes, "maxFilesPerMessage": p.MaxFilesPerMessage, "purpose": "temporary-room-attachment", "publicStorageUrls": false, "automaticEvidence": false, "scanGuaranteesSafety": false}
}
func (f *AttachmentService) status(r Object) string {
	if r["purged_at"] != nil {
		return "erased"
	}
	if r["revoked_at"] != nil {
		return "revoked"
	}
	if f.expired(r) {
		return "expired"
	}
	return str(r, "state")
}
func (f *AttachmentService) expired(r Object) bool {
	expiry := r["expires_at"]
	if expiry == nil {
		expiry = r["prepare_expires_at"]
	}
	return millis(expiry) <= f.Chat.now().UnixMilli()
}
func (f *AttachmentService) row(ctx context.Context, tx pgx.Tx, id string, write bool) (Object, error) {
	lock := " FOR SHARE"
	if write {
		lock = " FOR UPDATE"
	}
	return row(ctx, tx, "SELECT to_jsonb(a) FROM chat_attachments a WHERE id=$1"+lock, id)
}
func (f *AttachmentService) access(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	r, e := row(ctx, tx, "SELECT jsonb_build_object('stopped_until',stopped_until) FROM operations_file_access_heads_v1 WHERE endpoint=$1 AND kind='chat' AND file_id=$2", f.Chat.Endpoint, id)
	if e != nil {
		return nil, e
	}
	var until any
	if r != nil && r["stopped_until"] != nil {
		until = sec(r["stopped_until"])
	}
	return Object{"stopped": until != nil && until.(int64) > f.Chat.now().Unix(), "until": until}, nil
}
func (f *AttachmentService) assertAccess(ctx context.Context, tx pgx.Tx, id string) error {
	a, e := f.access(ctx, tx, id)
	if e != nil {
		return e
	}
	if truth(a, "stopped") {
		return fail("attachment_content_unavailable", 404)
	}
	return nil
}
func (f *AttachmentService) receipt(ctx context.Context, tx pgx.Tx, r Object) (Object, error) {
	expiry := r["expires_at"]
	meaning := "uploaded-file-30d"
	if expiry == nil {
		expiry = r["prepare_expires_at"]
		meaning = "upload-preparation-deadline"
	}
	state := f.status(r)
	out := Object{"attachmentId": r["id"], "roomId": r["room_id"], "messageId": r["message_id"], "state": state, "name": r["name"], "mediaType": r["media_type"], "size": r["byte_size"], "sha256": r["sha256"], "createdAt": iso(r["created_at"]), "uploadedAt": iso(r["uploaded_at"]), "expiresAt": iso(expiry), "expiryMeaning": meaning, "scan": r["scan_result"], "retryAfter": iso(r["lease_until"]), "cleanupPending": r["purge_pending"], "objectRemoved": r["purged_at"] != nil, "automaticEvidence": false, "processingState": state}
	access, e := f.access(ctx, tx, str(r, "id"))
	if e != nil {
		return nil, e
	}

	if truth(r, "purge_pending") || r["purged_at"] != nil {
		removal, e := (&objectremoval.Service{Endpoint: f.Chat.Endpoint}).ReadStateWithin(ctx, tx, "chat", str(r, "id"))
		if e != nil {
			return nil, e
		}
		if removal != nil {
			out["cleanup"] = Object{"state": objectremoval.CleanupState(removal), "objectRemoved": removal["objectRemoved"], "operationId": removal["operationId"]}
		}
	}
	out["access"] = access
	if truth(access, "stopped") {
		out["contentAvailable"] = false
		if !has([]string{"erased", "revoked", "expired", "blocked"}, state) {
			out["state"] = "unavailable"
		}
	}
	return out, nil
}
func (f *AttachmentService) authorPending(ctx context.Context, tx pgx.Tx, r Object) (bool, error) {
	if accountPattern.MatchString(str(r, "subject_id")) {
		return false, nil
	}
	var pending bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))", r["subject_id"]).Scan(&pending)
	return pending, e
}
func (f *AttachmentService) roomRow(ctx context.Context, tx pgx.Tx, a Actor, id, grant string, write, own bool) (Object, roomContext, error) {
	empty := roomContext{}
	located, e := row(ctx, tx, "SELECT jsonb_build_object('room_id',room_id) FROM chat_attachments WHERE id=$1", id)
	if e != nil {
		return nil, empty, e
	}
	if located == nil {
		return nil, empty, fail("attachment_unavailable", 404)
	}
	c, e := f.Chat.requireRoom(ctx, tx, a, str(located, "room_id"), true, write)
	if e != nil {
		return nil, empty, e
	}
	if write {
		if _, e = f.Chat.requireAccount(ctx, tx, a); e != nil {
			return nil, empty, e
		}
	}
	if e = f.Chat.agent(ctx, tx, a, str(located, "room_id"), grant, write); e != nil {
		return nil, empty, e
	}
	r, e := f.row(ctx, tx, id, write)
	if e != nil {
		return nil, empty, e
	}
	ref, _ := actorRef(a)
	if r == nil || own && str(r, "subject_id") != ref {
		return nil, empty, fail("attachment_unavailable", 404)
	}
	if str(r, "subject_id") != ref {
		pending, e := f.authorPending(ctx, tx, r)
		if e != nil {
			return nil, empty, e
		}
		if pending || r["message_id"] == nil {
			return nil, empty, fail("attachment_unavailable", 404)
		}
	}
	if write && has([]string{"archived", "owner-succession"}, str(c.Room, "state")) {
		return nil, empty, fail("chat_room_read_only")
	}
	return r, c, nil
}
func (f *AttachmentService) readable(ctx context.Context, tx pgx.Tx, a Actor, r Object, ownExport bool) error {
	if f.status(r) != "available" {
		return fail("attachment_content_unavailable", 404)
	}
	if e := f.assertAccess(ctx, tx, str(r, "id")); e != nil {
		return e
	}
	ref, _ := actorRef(a)
	if str(r, "subject_id") != ref {
		pending, e := f.authorPending(ctx, tx, r)
		if e != nil {
			return e
		}
		if pending {
			return fail("attachment_content_unavailable", 404)
		}
	}
	if r["message_id"] != nil {
		var blocked bool
		if e := tx.QueryRow(ctx, "SELECT "+operationsBlocked+" FROM chat_message_refs m WHERE message_id=$1", r["message_id"]).Scan(&blocked); e != nil && e != pgx.ErrNoRows {
			return e
		}
		if blocked {
			return fail("attachment_message_unavailable", 404)
		}
	}
	if ownExport {
		if str(r, "subject_id") != ref {
			return fail("attachment_unavailable", 404)
		}
		if f.status(r) != "available" {
			return fail("attachment_content_unavailable", 404)
		}
		return nil
	}
	if r["message_id"] == nil {
		if str(r, "subject_id") != ref {
			return fail("attachment_content_unavailable", 404)
		}
		return nil
	}
	message, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE message_id=$1 FOR SHARE", r["message_id"])
	if e != nil {
		return e
	}
	if message == nil || str(message, "state") != "accepted" || millis(message["expires_at"]) <= f.Chat.now().UnixMilli() {
		return fail("attachment_message_unavailable", 404)
	}
	var hidden bool
	if e = tx.QueryRow(ctx, "SELECT COALESCE((SELECT hidden FROM chat_message_preferences WHERE message_id=$1 AND subject_id=$2),false)", r["message_id"], ref).Scan(&hidden); e != nil {
		return e
	}
	if hidden || f.status(r) != "available" || millis(message["expires_at"]) <= f.Chat.now().UnixMilli() {
		return fail("attachment_message_unavailable", 404)
	}
	return nil
}

var mediaPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$`)

func parseAttachment(raw []byte, query bool) (Object, error) {
	keys := []string{"attachmentId", "agentGrantId"}
	if query {
		keys = []string{"roomId", "after", "limit"}
	}
	x, e := parse(raw, keys...)
	if e != nil {
		return nil, fail("invalid_attachment_request", 400)
	}
	if query {
		if !validID(str(x, "roomId")) {
			return nil, fail("invalid_attachment_request", 400)
		}
		if _, ok := x["limit"]; !ok {
			x["limit"] = int64(50)
		}
		if !normalizeInteger(x, "limit", 1, 100) || x["after"] != nil && !validID(str(x, "after")) {
			return nil, fail("invalid_attachment_request", 400)
		}
	} else if !validID(str(x, "attachmentId")) || x["agentGrantId"] != nil && !validID(str(x, "agentGrantId")) {
		return nil, fail("invalid_attachment_request", 400)
	}
	return x, nil
}
func (f *AttachmentService) rule(ctx context.Context, tx pgx.Tx, a Actor, id, stage string, size int64) error {
	if f.Chat.Rules == nil {
		return nil
	}
	account, e := f.Chat.account(ctx, tx, a, false)
	if e != nil {
		return e
	}
	_, e = f.Chat.Rules.EnforceWithin(ctx, tx, businessrules.Input{AccountID: str(account, "id"), Target: "chat-upload", OperationRef: id, Stage: stage, FileBytes: &size})
	return e
}
func (f *AttachmentService) Prepare(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := parse(raw, "attachmentId", "roomId", "name", "mediaType", "size", "sha256", "purpose", "confirmed", "agentGrantId")
	if e != nil {
		return nil, fail("invalid_attachment_request", 400)
	}
	name, ok := x["name"].(string)
	name = trim(name)
	valid := ok && name != "" && textLength(name) <= 180 && name != "." && name != ".."
	for _, r := range name {
		valid = valid && r > 31 && r != 127 && r != '/' && r != '\\'
	}
	if !valid || !validID(str(x, "attachmentId")) || !validID(str(x, "roomId")) || textLength(str(x, "mediaType")) > 120 || !mediaPattern.MatchString(str(x, "mediaType")) || !normalizeInteger(x, "size", 1, 67108864) || !hashPattern.MatchString(str(x, "sha256")) || str(x, "purpose") != "temporary-room-attachment" || !truth(x, "confirmed") || x["agentGrantId"] != nil && !validID(str(x, "agentGrantId")) {
		return nil, fail("invalid_attachment_request", 400)
	}
	x["name"] = name
	if e = f.configured(); e != nil {
		return nil, e
	}
	p := f.policy()
	if num(x, "size") > p.MaxFileBytes {
		return nil, fail("attachment_too_large", 413)
	}
	return f.Chat.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		c, e := f.Chat.requireRoom(ctx, tx, a, str(x, "roomId"), true, true)
		if e != nil {
			return nil, e
		}
		if _, e = f.Chat.requireAccount(ctx, tx, a); e != nil {
			return nil, e
		}
		if e = f.Chat.agent(ctx, tx, a, str(x, "roomId"), str(x, "agentGrantId"), true); e != nil {
			return nil, e
		}
		if has([]string{"archived", "owner-succession"}, str(c.Room, "state")) {
			return nil, fail("chat_room_read_only")
		}
		ref, _ := actorRef(a)
		pending, e := f.authorPending(ctx, tx, Object{"subject_id": ref})
		if e != nil {
			return nil, e
		}
		if pending {
			return nil, fail("attachment_author_unavailable")
		}
		old, e := f.row(ctx, tx, str(x, "attachmentId"), true)
		if e != nil {
			return nil, e
		}
		if old != nil {
			if str(old, "subject_id") != ref || str(old, "request_hash") != canonical(x) {
				return nil, fail("attachment_operation_conflict")
			}
			return f.receipt(ctx, tx, old)
		}
		if e = f.rule(ctx, tx, a, str(x, "attachmentId"), "prepare", num(x, "size")); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912320,0)"); e != nil {
			return nil, e
		}
		var all, owner string
		if e = tx.QueryRow(ctx, `SELECT COALESCE(sum(byte_size),0)::text,COALESCE(sum(CASE WHEN owner_ref=$1 THEN byte_size ELSE 0 END),0)::text FROM (SELECT byte_size,subject_id AS owner_ref FROM chat_attachments WHERE purged_at IS NULL UNION ALL SELECT byte_size,'account:'||account_id::text AS owner_ref FROM forum_attachments_v1 WHERE purged_at IS NULL UNION ALL SELECT byte_size,'account:'||account_id::text AS owner_ref FROM feedback_attachments_v1 WHERE purged_at IS NULL) storage`, ref).Scan(&all, &owner); e != nil {
			return nil, e
		}
		global, _ := new(big.Int).SetString(all, 10)
		owned, _ := new(big.Int).SetString(owner, 10)
		size := big.NewInt(num(x, "size"))
		if global.Add(global, size).Cmp(big.NewInt(p.MaxGlobalBytes)) > 0 || owned.Add(owned, size).Cmp(big.NewInt(p.MaxSubjectBytes)) > 0 {
			return nil, fail("attachment_storage_quota_exceeded")
		}
		r, e := row(ctx, tx, `INSERT INTO chat_attachments(id,room_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,agent_grant_id,created_at,prepare_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING to_jsonb(chat_attachments)`, x["attachmentId"], x["roomId"], ref, canonical(x), x["name"], x["mediaType"], num(x, "size"), x["sha256"], "attachments/"+str(x, "attachmentId"), f.Store.KeyID(), x["agentGrantId"], f.Chat.now(), f.Chat.now().Add(time.Hour))
		if e != nil {
			return nil, e
		}
		if e = f.removalService().RegisterNewObjectWithin(ctx, tx, chatRemovalDescriptor(r)); e != nil {
			return nil, e
		}
		return f.receipt(ctx, tx, r)
	})
}
func (f *AttachmentService) Get(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := parseAttachment(raw, false)
	if e != nil {
		return nil, e
	}
	return f.Chat.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		r, _, e := f.roomRow(ctx, tx, a, str(x, "attachmentId"), str(x, "agentGrantId"), false, false)
		if e != nil {
			return nil, e
		}
		return f.receipt(ctx, tx, r)
	})
}
func (f *AttachmentService) QueryOwn(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := parseAttachment(raw, true)
	if e != nil {
		return nil, e
	}
	return f.Chat.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		if _, e := f.Chat.requireRoom(ctx, tx, a, str(x, "roomId"), true, false); e != nil {
			return nil, e
		}
		ref, _ := actorRef(a)
		rr, e := rows(ctx, tx, "SELECT to_jsonb(a) FROM chat_attachments a WHERE subject_id=$1 AND room_id=$2 AND ($3='' OR id::text>$3) ORDER BY id LIMIT $4", ref, x["roomId"], str(x, "after"), num(x, "limit")+1)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for i, r := range rr {
			if int64(i) >= num(x, "limit") {
				break
			}
			receipt, e := f.receipt(ctx, tx, r)
			if e != nil {
				return nil, e
			}
			items = append(items, receipt)
		}
		var next any
		if int64(len(rr)) > num(x, "limit") {
			next = rr[num(x, "limit")-1]["id"]
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
func (f *AttachmentService) ValidateForMessageWithin(ctx context.Context, tx pgx.Tx, a Actor, room string, references []any, message string) error {
	if len(references) == 0 {
		return nil
	}
	if len(references) > f.policy().MaxFilesPerMessage {
		return fail("attachment_reference_invalid", 400)
	}
	ordered := []Object{}
	seen := map[string]bool{}
	for _, value := range references {
		ref, _ := value.(map[string]any)
		if seen[str(ref, "id")] {
			return fail("attachment_reference_invalid", 400)
		}
		seen[str(ref, "id")] = true
		ordered = append(ordered, ref)
	}
	sort.Slice(ordered, func(i, j int) bool { return str(ordered[i], "id") < str(ordered[j], "id") })
	owner, _ := actorRef(a)
	for _, ref := range ordered {
		r, e := f.row(ctx, tx, str(ref, "id"), true)
		if e != nil {
			return e
		}
		if r == nil || str(r, "subject_id") != owner || str(r, "room_id") != room || r["sha256"] != ref["sha256"] || f.status(r) != "available" || r["message_id"] != nil && str(r, "message_id") != message {
			return fail("attachment_reference_unavailable")
		}
		pending, e := f.authorPending(ctx, tx, r)
		if e != nil {
			return e
		}
		if pending {
			return fail("attachment_reference_unavailable")
		}
		if e = f.assertAccess(ctx, tx, str(r, "id")); e != nil {
			return e
		}
		if message != "" {
			if _, e = tx.Exec(ctx, "UPDATE chat_attachments SET message_id=$2 WHERE id=$1", r["id"], message); e != nil {
				return e
			}
		}
	}
	return nil
}
func (f *AttachmentService) ForMessagesWithin(ctx context.Context, tx pgx.Tx, a Actor, ids []string) (map[string][]Object, error) {
	out := map[string][]Object{}
	if len(ids) == 0 {
		return out, nil
	}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(a) FROM chat_attachments a WHERE message_id=ANY($1::uuid[]) ORDER BY created_at,id", ids)
	if e != nil {
		return nil, e
	}
	for _, r := range rr {
		receipt := Object{}
		e = f.readable(ctx, tx, a, r, false)
		if e != nil {
			if fault.Code(e) == "internal_error" {
				return nil, e
			}
			state := f.status(r)
			if state == "available" {
				state = "unavailable"
			}
			receipt = Object{"attachmentId": r["id"], "state": state, "contentAvailable": false}
		} else {
			receipt, e = f.receipt(ctx, tx, r)
			if e != nil {
				return nil, e
			}
		}
		out[str(r, "message_id")] = append(out[str(r, "message_id")], receipt)
	}
	return out, nil
}
func (f *AttachmentService) Revoke(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := parseAttachment(raw, false)
	if e != nil {
		return nil, e
	}
	return f.Chat.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		r, e := f.row(ctx, tx, str(x, "attachmentId"), true)
		if e != nil {
			return nil, e
		}
		ref, _ := actorRef(a)
		if r == nil || str(r, "subject_id") != ref {
			return nil, fail("attachment_unavailable", 404)
		}
		r, e = row(ctx, tx, "UPDATE chat_attachments SET revoked_at=COALESCE(revoked_at,$2),purge_pending=true WHERE id=$1 RETURNING to_jsonb(chat_attachments)", r["id"], f.Chat.now())
		if e != nil {
			return nil, e
		}
		return f.receipt(ctx, tx, r)
	})
}
func (f *AttachmentService) Content(ctx context.Context, a Actor, raw []byte, ownExport bool) (AttachmentContent, error) {
	x, e := parseAttachment(raw, false)
	if e != nil {
		return AttachmentContent{}, e
	}
	if e = f.configured(); e != nil {
		return AttachmentContent{}, e
	}
	var content AttachmentContent
	_, e = f.Chat.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		current := func() (Object, error) {
			var r Object
			var e error
			if ownExport {
				r, e = f.row(ctx, tx, str(x, "attachmentId"), false)
				ref, _ := actorRef(a)
				if e == nil && (r == nil || str(r, "subject_id") != ref) {
					e = fail("attachment_unavailable", 404)
				}
			} else {
				r, _, e = f.roomRow(ctx, tx, a, str(x, "attachmentId"), str(x, "agentGrantId"), false, false)
			}
			if e != nil {
				return nil, e
			}
			if e = f.readable(ctx, tx, a, r, ownExport); e != nil {
				return nil, e
			}
			return r, nil
		}
		r, e := current()
		if e != nil {
			return nil, e
		}
		bytes, e := f.Store.Get(ctx, str(r, "storage_key"), str(r, "encryption_key_id"), num(r, "byte_size"))
		if e != nil {
			return nil, e
		}
		if bytes == nil || attachments.Digest(bytes) != str(r, "sha256") {
			return nil, fail("attachment_storage_integrity_failed", 502)
		}
		r, e = current()
		if e != nil {
			return nil, e
		}
		content = AttachmentContent{Bytes: bytes, Name: str(r, "name"), MediaType: str(r, "media_type"), SHA256: str(r, "sha256"), AttachmentID: str(r, "id")}
		return Object{}, nil
	})
	return content, e
}

// Upload preserves the original durable lease before reading any request byte.
func (f *AttachmentService) Upload(ctx context.Context, a Actor, id string, stream io.ReadCloser, length int64, contentType string, onBytes func(int)) (Object, error) {
	if !validID(id) {
		return nil, fail("invalid_attachment_request", 400)
	}
	if e := f.configured(); e != nil {
		return nil, e
	}
	if contentType != "application/octet-stream" {
		return nil, fail("attachment_media_type_required", 415)
	}
	lease := uuid.NewString()
	started, e := f.Chat.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		r, _, e := f.roomRow(ctx, tx, a, id, "", true, true)
		if e != nil {
			return nil, e
		}
		if has([]string{"scan-pending", "scanning", "available"}, f.status(r)) {
			return Object{"done": true, "row": r}, nil
		}
		if f.expired(r) || r["revoked_at"] != nil || r["purged_at"] != nil || !has([]string{"prepared", "uploading"}, str(r, "state")) || r["message_id"] != nil {
			return nil, fail("attachment_upload_unavailable")
		}
		if r["agent_grant_id"] != nil {
			if e = f.Chat.agent(ctx, tx, a, str(r, "room_id"), str(r, "agent_grant_id"), true); e != nil {
				return nil, e
			}
		}
		if length != num(r, "byte_size") {
			return nil, fail("attachment_size_mismatch", 400)
		}
		if r["lease_until"] != nil && millis(r["lease_until"]) > f.Chat.now().UnixMilli() {
			return nil, fail("attachment_upload_in_progress")
		}
		if e = f.rule(ctx, tx, a, id, "upload-start", num(r, "byte_size")); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912320,0)"); e != nil {
			return nil, e
		}
		var count int
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM (SELECT id FROM chat_attachments WHERE state='uploading' AND lease_until>$1 UNION ALL SELECT id FROM forum_attachments_v1 WHERE state='uploading' AND lease_until>$1 UNION ALL SELECT id FROM feedback_attachments_v1 WHERE state='uploading' AND lease_until>$1) uploading`, f.Chat.now()).Scan(&count); e != nil {
			return nil, e
		}
		if count >= 4 {
			return nil, fail("attachment_upload_capacity", 429)
		}
		r, e = row(ctx, tx, "UPDATE chat_attachments SET state='uploading',lease_id=$2,lease_until=$3,uploaded_at=COALESCE(uploaded_at,$4),expires_at=COALESCE(expires_at,$5),last_error=NULL WHERE id=$1 RETURNING to_jsonb(chat_attachments)", id, lease, f.Chat.now().Add(120*time.Second), f.Chat.now(), f.Chat.now().Add(30*24*time.Hour))
		return Object{"row": r}, e
	})
	if e != nil {
		return nil, e
	}
	r := obj(started, "row")
	if truth(started, "done") {
		input := Object{"attachmentId": id}
		if r["agent_grant_id"] != nil {
			input["agentGrantId"] = r["agent_grant_id"]
		}
		return f.Get(ctx, a, encode(input))
	}
	putAttempted := false
	result, uploadError := func() (Object, error) {
		bytes, e := attachments.ReadPayload(ctx, stream, attachments.Payload{Size: num(r, "byte_size"), SHA256: str(r, "sha256"), MediaType: str(r, "media_type"), MaxFileBytes: f.policy().MaxFileBytes, OnBytes: onBytes})
		if e != nil {
			return nil, e
		}
		if f.Chat.Rules != nil {
			if _, e = f.Chat.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
				current, _, e := f.roomRow(ctx, tx, a, id, "", true, true)
				if e != nil {
					return nil, e
				}
				if str(current, "lease_id") != lease || current["revoked_at"] != nil || f.expired(current) {
					return nil, fail("attachment_upload_no_longer_allowed")
				}
				if e = f.rule(ctx, tx, a, id, "upload-bytes", num(current, "byte_size")); e != nil {
					return nil, e
				}
				putAttempted = true
				e = f.Store.Put(ctx, str(r, "storage_key"), bytes, str(r, "sha256"))
				return Object{}, e
			}); e != nil {
				return nil, e
			}
		} else {
			putAttempted = true
			if e = f.Store.Put(ctx, str(r, "storage_key"), bytes, str(r, "sha256")); e != nil {
				return nil, e
			}
		}
		return f.Chat.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
			current, _, e := f.roomRow(ctx, tx, a, id, "", true, true)
			if e != nil {
				return nil, e
			}
			pending, e := f.authorPending(ctx, tx, current)
			if e != nil {
				return nil, e
			}
			if str(current, "lease_id") != lease || current["revoked_at"] != nil || f.expired(current) || pending {
				return nil, fail("attachment_upload_no_longer_allowed")
			}
			current, e = row(ctx, tx, "UPDATE chat_attachments SET state='scan-pending',lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 RETURNING to_jsonb(chat_attachments)", id)
			if e != nil {
				return nil, e
			}
			return f.receipt(ctx, tx, current)
		})
	}()
	if uploadError == nil {
		return result, nil
	}
	code := fault.Code(uploadError)
	invalid := has([]string{"attachment_too_large", "attachment_digest_mismatch", "attachment_file_format_invalid", "attachment_media_type_mismatch", "attachment_media_type_unrecognized"}, code)
	if code == "internal_error" {
		code = "attachment_upload_failed"
	}
	_, _ = postgres.InTx(ctx, f.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		_, e := tx.Exec(ctx, `UPDATE chat_attachments SET lease_until=$3,last_error=$4,purge_pending=purge_pending OR revoked_at IS NOT NULL OR $5,state=CASE WHEN $5 THEN 'blocked' WHEN $6 THEN 'uploading' ELSE 'prepared' END WHERE id=$1 AND lease_id=$2`, id, lease, f.Chat.now(), code, invalid, putAttempted)
		return Object{}, e
	})
	return nil, uploadError
}
