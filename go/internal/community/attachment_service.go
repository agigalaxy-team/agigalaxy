package community

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/jackc/pgx/v5"
	"math/big"
	"regexp"
	"time"
	"unicode/utf8"
)

type AttachmentActor struct {
	AccountID string
	Authority Authorization
	Device    *deviceauth.Actor
}
type AttachmentService struct {
	Removals   *objectremoval.Service
	Forum      *Service
	Store      attachments.Store
	Scanner    attachments.Scanner
	Policy     attachments.Policy
	Diagnostic func(Object)
}

func (f *AttachmentService) policy() attachments.Policy {
	if f.Policy.Version == 0 {
		return attachments.DefaultPolicy()
	}
	return f.Policy
}
func (f *AttachmentService) configured() error {
	if f == nil || f.Forum == nil || f.Store == nil || f.Scanner == nil {
		return fail("attachment_service_unavailable", 503)
	}
	return nil
}
func (f *AttachmentService) Specification() Object {
	p := f.policy()
	return Object{"supported": f.Store != nil && f.Scanner != nil, "maxFileBytes": p.MaxFileBytes, "maxFilesPerMessage": 4, "purpose": "post-or-reply-attachment", "draftRetentionDays": 7, "retention": "published-source-expiry", "publicStorageUrls": false, "automaticEvidence": false, "scanGuaranteesSafety": false}
}
func (f *AttachmentService) scoped(a AttachmentActor, write bool) *Service {
	s := *f.Forum
	s.Authority = a.Authority
	if a.Device != nil {
		scope := "binding"
		if write {
			scope = "assistance"
		}
		return s.ForIdentity(*a.Device, scope, "")
	}
	return &s
}
func (f *AttachmentService) run(ctx context.Context, a AttachmentActor, write bool, fn func(*Service, pgx.Tx, string) (Object, error)) (Object, error) {
	if f == nil || f.Forum == nil {
		return nil, fail("attachment_service_unavailable", 503)
	}
	if a.Device == nil && a.AccountID == "" {
		return nil, fail("account_verification_required", 401)
	}
	s := f.scoped(a, write)
	return s.runOptions(ctx, a.AccountID, write, false, func(tx pgx.Tx) (Object, error) {
		account := a.AccountID
		if a.Device != nil {
			r, e := s.resolveIdentityAccount(ctx, tx, account, write)
			if e != nil {
				return nil, e
			}
			account = str(r, "id")
		} else {
			sql := "SELECT to_jsonb(a) FROM community_accounts a WHERE id=$1 AND endpoint=$2 FOR SHARE"
			if write {
				sql = "SELECT to_jsonb(a) FROM community_accounts a WHERE id=$1 AND endpoint=$2 FOR UPDATE"
			}
			r, e := row(ctx, tx, sql, account, s.Endpoint)
			if e != nil {
				return nil, e
			}
			if r == nil {
				return nil, fail("account_verification_required", 403)
			}
			if write && r["restricted_until"] != nil && seconds(r["restricted_until"]) > s.clock() {
				return nil, fail("community_restricted", 403)
			}
		}
		return fn(s, tx, account)
	})
}
func (f *AttachmentService) row(ctx context.Context, tx pgx.Tx, id string, write bool) (Object, error) {
	suffix := " FOR SHARE"
	if write {
		suffix = " FOR UPDATE"
	}
	return row(ctx, tx, "SELECT to_jsonb(a) FROM forum_attachments_v1 a WHERE id=$1"+suffix, id)
}
func (f *AttachmentService) owned(ctx context.Context, tx pgx.Tx, account, id string, write bool) (Object, error) {
	r, e := f.row(ctx, tx, id, write)
	if e != nil {
		return nil, e
	}
	if r == nil || str(r, "account_id") != account {
		return nil, fail("attachment_unavailable", 404)
	}
	return r, nil
}
func (f *AttachmentService) rule(ctx context.Context, tx pgx.Tx, s *Service, account, id, stage string, size int64) error {
	rules := businessrules.Service{Endpoint: s.Endpoint, PromotionDays: s.PromotionDays, Now: s.Now}
	_, e := rules.EnforceWithin(ctx, tx, businessrules.Input{AccountID: account, Target: "forum-upload", OperationRef: id, Stage: stage, FileBytes: &size})
	return e
}

var forumMedia = regexp.MustCompile(`^[a-z0-9.+-]+/[a-z0-9.+-]+$`)

func attachmentInput(raw []byte, keys ...string) (Object, error) {
	var x Object
	if json.Unmarshal(raw, &x) != nil || x == nil || !strict(x, keys...) {
		return nil, fail("invalid_attachment_request", 400)
	}
	return x, nil
}
func (f *AttachmentService) Prepare(ctx context.Context, a AttachmentActor, raw []byte) (Object, error) {
	x, e := attachmentInput(raw, "attachmentId", "name", "mediaType", "size", "sha256")
	if e != nil {
		return nil, e
	}
	name, ok := x["name"].(string)
	name = forumTrim(name)
	valid := ok && name != "" && utf8.RuneCountInString(name) <= 255
	for _, r := range name {
		if r < 32 || r == 127 {
			valid = false
		}
	}
	if !valid || !validID(str(x, "attachmentId")) || !forumMedia.MatchString(str(x, "mediaType")) || utf8.RuneCountInString(str(x, "mediaType")) > 120 || !govInt(x["size"], 1, 33554432) || !governanceSHA.MatchString(str(x, "sha256")) {
		return nil, fail("invalid_attachment_request", 400)
	}
	x["name"] = name
	if e = f.configured(); e != nil {
		return nil, e
	}
	if num(x, "size") > f.policy().MaxFileBytes {
		return nil, fail("attachment_too_large", 413)
	}
	return f.run(ctx, a, true, func(s *Service, tx pgx.Tx, account string) (Object, error) {
		canonical, e := identity.Canonical(x)
		if e != nil {
			return nil, e
		}
		hash := identity.Digest(canonical)
		old, e := f.row(ctx, tx, str(x, "attachmentId"), true)
		if e != nil {
			return nil, e
		}
		if old != nil {
			if str(old, "account_id") != account || str(old, "request_hash") != hash {
				return nil, fail("attachment_operation_conflict", 409)
			}
			return s.attachmentReceipt(ctx, tx, old)
		}
		if e = f.rule(ctx, tx, s, account, str(x, "attachmentId"), "prepare", num(x, "size")); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912320,0)"); e != nil {
			return nil, e
		}
		var all, owner string
		e = tx.QueryRow(ctx, `SELECT COALESCE(sum(byte_size),0)::text,COALESCE(sum(CASE WHEN owner=$1 THEN byte_size ELSE 0 END),0)::text FROM (SELECT byte_size,'account:'||account_id::text AS owner FROM forum_attachments_v1 WHERE purged_at IS NULL UNION ALL SELECT byte_size,subject_id AS owner FROM chat_attachments WHERE purged_at IS NULL UNION ALL SELECT byte_size,'account:'||account_id::text AS owner FROM feedback_attachments_v1 WHERE purged_at IS NULL) files`, "account:"+account).Scan(&all, &owner)
		if e != nil {
			return nil, e
		}
		p := f.policy()
		exceeds := func(value string, max int64) bool {
			n, ok := new(big.Int).SetString(value, 10)
			return !ok || n.Add(n, big.NewInt(num(x, "size"))).Cmp(big.NewInt(max)) > 0
		}
		if exceeds(all, p.MaxGlobalBytes) || exceeds(owner, p.MaxSubjectBytes) {
			return nil, fail("attachment_storage_quota_exceeded", 409)
		}
		r, e := row(ctx, tx, `INSERT INTO forum_attachments_v1(id,account_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,created_at,prepare_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING to_jsonb(forum_attachments_v1)`, x["attachmentId"], account, s.subject(), hash, name, x["mediaType"], num(x, "size"), x["sha256"], "forum-attachments/"+str(x, "attachmentId"), f.Store.KeyID(), s.now(), s.now().Add(time.Hour))
		if e != nil {
			return nil, e
		}
		if e = f.removalService().RegisterNewObjectWithin(ctx, tx, forumRemovalDescriptor(r)); e != nil {
			return nil, e
		}
		return s.attachmentReceipt(ctx, tx, r)
	})
}
func forumTrim(value string) string {
	r := []rune(value)
	first, last := 0, len(r)
	space := func(r rune) bool { return r <= 0xffff && govWhitespace(uint16(r)) }
	for first < last && space(r[first]) {
		first++
	}
	for last > first && space(r[last-1]) {
		last--
	}
	return string(r[first:last])
}
func (f *AttachmentService) Get(ctx context.Context, a AttachmentActor, raw []byte) (Object, error) {
	x, e := attachmentInput(raw, "attachmentId")
	if e != nil || !validID(str(x, "attachmentId")) {
		return nil, fail("invalid_attachment_request", 400)
	}
	return f.run(ctx, a, false, func(s *Service, tx pgx.Tx, account string) (Object, error) {
		r, e := f.owned(ctx, tx, account, str(x, "attachmentId"), false)
		if e != nil {
			return nil, e
		}
		return s.attachmentReceipt(ctx, tx, r)
	})
}
func (f *AttachmentService) QueryOwn(ctx context.Context, a AttachmentActor, raw []byte) (Object, error) {
	x, e := attachmentInput(raw, "after", "limit")
	if e != nil {
		return nil, e
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = 20
	}
	if v, ok := x["after"]; ok && !validID(asString(v)) || !govInt(x["limit"], 1, 30) {
		return nil, fail("invalid_attachment_request", 400)
	}
	return f.run(ctx, a, false, func(s *Service, tx pgx.Tx, account string) (Object, error) {
		limit := num(x, "limit")
		rr, e := rows(ctx, tx, "SELECT to_jsonb(a) FROM forum_attachments_v1 a WHERE account_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3", account, x["after"], limit+1)
		if e != nil {
			return nil, e
		}
		scanned := rr
		if int64(len(scanned)) > limit {
			scanned = scanned[:limit]
		}
		items := []Object{}
		for _, r := range scanned {
			receipt, e := s.attachmentReceipt(ctx, tx, r)
			if e != nil {
				return nil, e
			}
			items = append(items, receipt)
		}
		var next any
		if int64(len(rr)) > limit {
			next = rr[limit-1]["id"]
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
func (f *AttachmentService) Revoke(ctx context.Context, a AttachmentActor, raw []byte) (Object, error) {
	x, e := attachmentInput(raw, "attachmentId")
	if e != nil || !validID(str(x, "attachmentId")) {
		return nil, fail("invalid_attachment_request", 400)
	}
	return f.run(ctx, a, true, func(s *Service, tx pgx.Tx, account string) (Object, error) {
		r, e := f.owned(ctx, tx, account, str(x, "attachmentId"), true)
		if e != nil {
			return nil, e
		}
		r, e = row(ctx, tx, "UPDATE forum_attachments_v1 SET revoked_at=COALESCE(revoked_at,$2),purge_pending=true WHERE id=$1 RETURNING to_jsonb(forum_attachments_v1)", r["id"], s.now())
		if e != nil {
			return nil, e
		}
		return s.attachmentReceipt(ctx, tx, r)
	})
}
