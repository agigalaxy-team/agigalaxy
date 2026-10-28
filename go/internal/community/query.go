package community

import (
	"context"
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"regexp"
	"strings"
	"time"
)

func queryInput(raw []byte, keys ...string) (Object, int64, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil || !strict(q, keys...) {
		return nil, 0, invalid()
	}
	limit := int64(20)
	if n, ok := q["limit"]; ok {
		if !integer(n, 1, 50) {
			return nil, 0, invalid()
		}
		limit = num(q, "limit")
	}
	return q, limit, nil
}
func (s *Service) Versions(ctx context.Context, account, post string, raw []byte) (Object, error) {
	q, limit, e := queryInput(raw, "afterVersion", "limit")
	if e != nil {
		return nil, e
	}
	if !validID(post) {
		return nil, fail("not_found", 404)
	}
	if v, ok := q["afterVersion"]; ok && !integer(v, 0, 9007199254740991) {
		return nil, invalid()
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		return s.versions(ctx, tx, post, account, num(q, "afterVersion"), limit)
	})
}
func (s *Service) Replies(ctx context.Context, account string, raw []byte) (Object, error) {
	q, limit, e := queryInput(raw, "postId", "postVersionId", "after", "limit")
	if e != nil {
		return nil, e
	}
	if !validID(str(q, "postId")) || !validID(str(q, "postVersionId")) {
		return nil, invalid()
	}
	if v, ok := q["after"]; ok && !validID(asString(v)) {
		return nil, invalid()
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		source, e := s.readVersion(ctx, tx, str(q, "postId"), str(q, "postVersionId"), account)
		if e != nil {
			return nil, e
		}
		if str(source, "availability") != "available" {
			return Object{"items": []Object{}, "nextAfter": nil, "scanTruncated": false, "sourceAvailability": source["availability"], "checkedAt": s.clock()}, nil
		}
		rr, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM (SELECT id FROM forum_replies_v1 WHERE post_id=$1 AND post_version_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 200)r", q["postId"], q["postVersionId"], q["after"])
		if e != nil {
			return nil, e
		}
		items := []Object{}
		var scanned any
		for _, r := range rr {
			scanned = r["id"]
			view, e := s.readReply(ctx, tx, str(r, "id"), account)
			if e != nil {
				return nil, e
			}
			if str(view, "availability") == "available" {
				items = append(items, view)
			}
			if int64(len(items)) == limit {
				break
			}
		}
		var next any
		if int64(len(items)) == limit || len(rr) == 200 {
			next = scanned
		}
		return Object{"items": items, "nextAfter": next, "scanTruncated": len(rr) == 200 && int64(len(items)) < limit, "checkedAt": s.clock()}, nil
	})
}

type page struct {
	Order, Hash, AfterID string
	AfterAt              *time.Time
}

func pageFor(q Object, owner any) (page, error) {
	after := str(q, "after")
	order := str(q, "order")
	uuidAfter := validID(after)
	if order == "" {
		order = "published"
		if uuidAfter {
			order = "id"
		}
	}
	p := page{Order: order}
	if order == "id" {
		if q["topic"] != nil || q["sectionId"] != nil || str(q, "query") != "" || after != "" && !uuidAfter {
			return p, fail("forum_cursor_mismatch", 400)
		}
		p.AfterID = after
		return p, nil
	}
	if uuidAfter || order != "published" {
		return p, fail("forum_cursor_mismatch", 400)
	}
	parts := []any{owner, q["topic"], strings.ToLower(str(q, "query")), order}
	if section, ok := q["sectionId"]; ok {
		parts = append(parts, section)
	}
	p.Hash = identity.Digest(encode(parts))
	if after == "" {
		return p, nil
	}
	if !strings.HasPrefix(after, "fp1.") {
		return p, fail("forum_cursor_mismatch", 400)
	}
	b, e := base64.RawURLEncoding.DecodeString(after[4:])
	if e != nil {
		return p, fail("forum_cursor_mismatch", 400)
	}
	var cursor Object
	if protocol.Decode(b, &cursor) != nil || !strict(cursor, "version", "filtersHash", "createdAt", "id") || num(cursor, "version") != 1 || str(cursor, "filtersHash") != p.Hash || !validID(str(cursor, "id")) {
		return p, fail("forum_cursor_mismatch", 400)
	}
	at, e := time.Parse("2006-01-02T15:04:05.000Z", str(cursor, "createdAt"))
	if e != nil {
		return p, fail("forum_cursor_mismatch", 400)
	}
	p.AfterAt = &at
	p.AfterID = str(cursor, "id")
	return p, nil
}
func pageAfter(p page, r Object) string {
	if p.Order == "id" {
		return str(r, "id")
	}
	t, _ := time.Parse(time.RFC3339Nano, str(r, "created_at"))
	return "fp1." + base64.RawURLEncoding.EncodeToString(encode(Object{"version": 1, "filtersHash": p.Hash, "createdAt": stamp(t), "id": r["id"]}))
}
func matches(view, q Object) bool {
	if str(view, "availability") != "available" {
		return false
	}
	if t, ok := q["topic"]; ok && t != view["topic"] {
		return false
	}
	query := strings.ToLower(str(q, "query"))
	if query == "" {
		return true
	}
	payload := obj(view, "payload")
	return strings.Contains(strings.ToLower(str(payload, "title")), query) || strings.Contains(strings.ToLower(str(payload, "body")), query)
}
func (s *Service) Query(ctx context.Context, account string, raw []byte) (Object, error) {
	q, limit, e := queryInput(raw, "after", "limit", "topic", "sectionId", "query", "order")
	if e != nil {
		return nil, e
	}
	if v, ok := q["topic"]; ok && !topic(asString(v), true) {
		return nil, invalid()
	}
	if v, ok := q["sectionId"]; ok && !validID(asString(v)) {
		return nil, invalid()
	}
	if v, ok := q["query"]; ok {
		t, ok := v.(string)
		if !ok || len([]rune(t)) > 160 {
			return nil, invalid()
		}
		q["query"] = strings.TrimSpace(t)
	}
	if v, ok := q["order"]; ok && v != "id" && v != "published" {
		return nil, invalid()
	}
	if v, ok := q["after"]; ok {
		t, ok := v.(string)
		if !ok || len(t) < 1 || len(t) > 1536 {
			return nil, invalid()
		}
	}
	var viewer any
	if account != "" {
		viewer = "viewer:" + account
	} else if s.actor != nil {
		viewer = "viewer:" + s.actor.actor.SubjectID
	}
	p, e := pageFor(q, viewer)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		var rr []Object
		var e error
		if p.Order == "id" {
			rr, e = rows(ctx, tx, "SELECT to_jsonb(p) FROM (SELECT id FROM forum_posts_v1 WHERE state='published' AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 200)p", null(p.AfterID))
		} else {
			rr, e = rows(ctx, tx, `SELECT jsonb_build_object('id',p.id,'created_at',p.created_at) FROM forum_posts_v1 p LEFT JOIN forum_versions_v1 v ON v.id=p.current_version_id AND v.post_id=p.id LEFT JOIN operations_forum_curation_v1 c ON c.endpoint=$1 AND c.target_kind='post' AND c.target_id=p.id AND c.source_version=p.head_version WHERE p.state='published' AND v.state='published' AND v.erased_at IS NULL AND v.published_until>$2 AND ($3::text IS NULL OR coalesce(c.topic,v.topic,'unclassified')=$3) AND ($4::uuid IS NULL OR v.section_id=$4) AND ($5::timestamptz IS NULL OR (p.created_at,p.id)<($5::timestamptz,$6::uuid)) ORDER BY p.created_at DESC,p.id DESC LIMIT 201`, s.Endpoint, s.now(), q["topic"], q["sectionId"], p.AfterAt, null(p.AfterID))
		}
		if e != nil {
			return nil, e
		}
		items := []Object{}
		var scanned Object
		processed := 0
		for _, r := range rr {
			if processed == 200 {
				break
			}
			processed++
			scanned = r
			view, e := s.readPost(ctx, tx, str(r, "id"), account)
			if e != nil {
				return nil, e
			}
			if p.Order == "id" && str(view, "availability") == "available" || p.Order == "published" && matches(view, q) {
				items = append(items, view)
			}
			if int64(len(items)) == limit {
				break
			}
		}
		more := processed < len(rr)
		var next any
		if p.Order == "id" {
			if int64(len(items)) == limit || len(rr) == 200 {
				next = scanned["id"]
			}
		} else if more && scanned != nil {
			next = pageAfter(p, scanned)
		}
		return Object{"items": items, "nextAfter": next, "scanTruncated": processed == 200 && int64(len(items)) < limit && (p.Order == "id" || more), "order": p.Order, "checkedAt": s.clock()}, nil
	})
}
func (s *Service) Receipt(ctx context.Context, account string, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || !strict(q, "operationId", "payloadHash") || !validID(str(q, "operationId")) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(str(q, "payloadHash")) {
		return nil, invalid()
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		if account == "" && s.actor == nil {
			return nil, fail("official_account_login_required", 401)
		}
		column, key := "account_id", account
		if s.actor != nil {
			column = "subject_id"
			key = s.actor.actor.SubjectID
		}
		sql := `SELECT to_jsonb(r) FROM (SELECT account_id,payload_hash,locator,result FROM forum_write_receipts_v1 WHERE operation_id=$1 AND OWNER=$2 UNION ALL SELECT account_id,payload_hash,NULL::jsonb locator,result FROM forum_events_v1 WHERE id=$1 AND OWNER=$2 UNION ALL SELECT account_id,payload_hash,NULL::jsonb locator,result FROM forum_governance_events_v1 WHERE operation_id=$1 AND OWNER=$2 UNION ALL SELECT account_id,payload_hash,NULL::jsonb locator,result FROM forum_section_events_v2 WHERE id=$1 AND OWNER=$2 LIMIT 1)r`
		r, e := row(ctx, tx, strings.ReplaceAll(sql, "OWNER", column), q["operationId"], key)
		if e != nil {
			return nil, e
		}
		out := Object{"operationId": q["operationId"], "payloadHash": q["payloadHash"], "status": "absent", "authority": "accepted-operation-only; not-current-read-access"}
		if r != nil && s.actor != nil && account != "" && r["account_id"] != nil && str(r, "account_id") != account {
			return out, nil
		}
		if r != nil {
			out["status"] = "conflict"
			if str(r, "payload_hash") == str(q, "payloadHash") {
				out["status"] = "acknowledged"
				out["locator"] = r["locator"]
				if out["locator"] == nil {
					out["locator"] = locatorForResult(obj(r, "result"))
				}
				out["result"] = r["result"]
			}
		}
		return out, nil
	})
}
func locatorForResult(r Object) Object {
	if r["sectionId"] != nil {
		return Object{"kind": "section", "sectionId": r["sectionId"]}
	}
	if r["replyId"] != nil {
		return Object{"kind": "reply", "replyId": r["replyId"], "contentRevision": 1}
	}
	if r["versionId"] != nil {
		return Object{"kind": "post-version", "postId": r["postId"], "versionId": r["versionId"]}
	}
	if r["postId"] != nil {
		return Object{"kind": "post", "postId": r["postId"]}
	}
	return Object{"kind": "report", "reportId": r["reportId"]}
}
