package community

import (
	"context"
	"github.com/jackc/pgx/v5"
	"strings"
)

func (s *Service) ownedPost(ctx context.Context, tx pgx.Tx, account, id string, summary bool) (Object, error) {
	head, e := s.head(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	account, e = s.viewerForRow(ctx, tx, account, head)
	if e != nil {
		return nil, e
	}
	if !s.owns(head, account) {
		return nil, fail("not_found", 404)
	}
	out, e := s.author(ctx, tx, head)
	if e != nil {
		return nil, e
	}
	out["locator"] = Object{"kind": "post", "postId": id}
	out["headVersion"] = head["head_version"]
	out["currentVersionId"] = head["current_version_id"]
	out["state"] = head["state"]
	out["checkedAt"] = s.clock()
	if summary {
		var current Object
		if str(head, "current_version_id") != "" {
			current, e = s.readVersion(ctx, tx, id, str(head, "current_version_id"), account)
			if e != nil {
				return nil, e
			}
		}
		if str(current, "availability") == "available" {
			for k, v := range current {
				if _, ok := out[k]; !ok {
					out[k] = v
				}
			}
		} else {
			state := "unavailable"
			if current != nil {
				state = str(current, "availability")
			}
			if str(head, "state") == "withdrawn" {
				state = "withdrawn"
			}
			out["availability"] = state
		}
		out["createdAt"] = seconds(head["created_at"])
		out["updatedAt"] = seconds(head["updated_at"])
		return out, nil
	}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(v) FROM (SELECT id,version_number,state,permission_id,published_until FROM forum_versions_v1 WHERE post_id=$1 ORDER BY version_number)v", id)
	if e != nil {
		return nil, e
	}
	items := []Object{}
	for _, r := range rr {
		view, e := s.readVersion(ctx, tx, id, str(r, "id"), account)
		if e != nil {
			return nil, e
		}
		items = append(items, Object{"locator": view["locator"], "state": r["state"], "permissionId": r["permission_id"], "publishedUntil": seconds(r["published_until"]), "availability": view["availability"]})
	}
	out["versionLocators"] = items
	return out, nil
}
func (s *Service) OwnedPost(ctx context.Context, account, id string) (Object, error) {
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) { return s.ownedPost(ctx, tx, account, id, false) })
}
func (s *Service) OwnedReply(ctx context.Context, account, id string) (Object, error) {
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		r, e := s.reply(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		account, e = s.viewerForRow(ctx, tx, account, r)
		if e != nil {
			return nil, e
		}
		if !s.owns(r, account) {
			return nil, fail("not_found", 404)
		}
		view, e := s.readReply(ctx, tx, id, account)
		if e != nil {
			return nil, e
		}
		out, e := s.author(ctx, tx, r)
		if e != nil {
			return nil, e
		}
		for k, v := range (Object{"locator": view["locator"], "revision": r["revision"], "state": r["state"], "permissionId": r["permission_id"], "publishedUntil": seconds(r["published_until"]), "availability": view["availability"], "checkedAt": s.clock()}) {
			out[k] = v
		}
		return out, nil
	})
}
func (s *Service) Owned(ctx context.Context, account string, raw []byte) (Object, error) {
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
		value, ok := v.(string)
		if !ok || len([]rune(value)) > 160 {
			return nil, invalid()
		}
		q["query"] = strings.TrimSpace(value)
	}
	if v, ok := q["order"]; ok && v != "id" && v != "published" {
		return nil, invalid()
	}
	if v, ok := q["after"]; ok {
		value, ok := v.(string)
		if !ok || len(value) < 1 || len(value) > 1536 {
			return nil, invalid()
		}
	}
	ownerKey := "account:" + account
	if s.actor != nil && account == "" {
		ownerKey = s.actor.actor.SubjectID
	}
	p, e := pageFor(q, ownerKey)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		if account == "" && s.actor == nil {
			return nil, fail("official_account_login_required", 401)
		}
		var rr []Object
		var e error
		if s.actor != nil && account == "" {
			available, e := s.availableIdentityAccounts(ctx, tx)
			if e != nil {
				return nil, e
			}
			ids := []string{}
			for _, r := range available {
				ids = append(ids, str(r, "id"))
			}
			if p.Order == "id" {
				rr, e = rows(ctx, tx, "SELECT jsonb_build_object('id',id) FROM forum_posts_v1 WHERE (account_id=ANY($1::uuid[]) OR account_id IS NULL AND subject_id=$2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", ids, s.subject(), null(p.AfterID), limit+1)
			} else {
				rr, e = rows(ctx, tx, `SELECT jsonb_build_object('id',p.id,'created_at',p.created_at) FROM forum_posts_v1 p LEFT JOIN forum_versions_v1 v ON v.id=p.current_version_id AND v.post_id=p.id LEFT JOIN operations_forum_curation_v1 c ON c.endpoint=$1 AND c.target_kind='post' AND c.target_id=p.id AND c.source_version=p.head_version WHERE (p.account_id=ANY($2::uuid[]) OR p.account_id IS NULL AND p.subject_id=$7) AND ($3::text IS NULL OR coalesce(c.topic,v.topic,'unclassified')=$3) AND ($4::uuid IS NULL OR v.section_id=$4) AND ($5::timestamptz IS NULL OR (p.created_at,p.id)<($5::timestamptz,$6::uuid)) ORDER BY p.created_at DESC,p.id DESC LIMIT 201`, s.Endpoint, ids, q["topic"], q["sectionId"], p.AfterAt, null(p.AfterID), s.subject())
			}
		} else if p.Order == "id" {
			rr, e = rows(ctx, tx, "SELECT to_jsonb(p) FROM (SELECT id FROM forum_posts_v1 WHERE account_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3)p", account, null(p.AfterID), limit+1)
		} else {
			rr, e = rows(ctx, tx, `SELECT jsonb_build_object('id',p.id,'created_at',p.created_at) FROM forum_posts_v1 p LEFT JOIN forum_versions_v1 v ON v.id=p.current_version_id AND v.post_id=p.id LEFT JOIN operations_forum_curation_v1 c ON c.endpoint=$1 AND c.target_kind='post' AND c.target_id=p.id AND c.source_version=p.head_version WHERE p.account_id=$2 AND ($3::text IS NULL OR coalesce(c.topic,v.topic,'unclassified')=$3) AND ($4::uuid IS NULL OR v.section_id=$4) AND ($5::timestamptz IS NULL OR (p.created_at,p.id)<($5::timestamptz,$6::uuid)) ORDER BY p.created_at DESC,p.id DESC LIMIT 201`, s.Endpoint, account, q["topic"], q["sectionId"], p.AfterAt, null(p.AfterID))
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
			view, e := s.ownedPost(ctx, tx, account, str(r, "id"), true)
			if e != nil {
				return nil, e
			}
			if p.Order == "id" || q["topic"] == nil && str(q, "query") == "" || matches(view, q) {
				items = append(items, view)
			}
			if int64(len(items)) == limit {
				break
			}
		}
		more := processed < len(rr)
		var next any
		if more && scanned != nil {
			next = pageAfter(p, scanned)
		}
		out := Object{"items": items, "nextAfter": next, "order": p.Order, "checkedAt": s.clock()}
		if p.Order == "published" {
			out["scanTruncated"] = more && processed == 200 && int64(len(items)) < limit
		}
		return out, nil
	})
}
