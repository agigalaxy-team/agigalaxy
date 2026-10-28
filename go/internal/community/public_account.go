package community

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// PublicForAccountWithin uses the caller's existing transaction. Profile query
// opt-in and scope remain the accounts domain's responsibility; every source
// below independently rechecks current forum permission and anonymous audience.
func (s *Service) PublicForAccountWithin(ctx context.Context, tx pgx.Tx, account string, raw []byte) (Object, error) {
	if !validID(account) {
		return nil, invalid()
	}
	q, limit, e := queryInput(raw, "after", "limit")
	if e != nil {
		return nil, e
	}
	if v, ok := q["after"]; ok {
		t, ok := v.(string)
		if !ok || len(t) < 1 || len(t) > 512 {
			return nil, invalid()
		}
	}
	q["query"] = ""
	q["order"] = "published"
	p, e := pageFor(q, "public-account:"+account)
	if e != nil {
		return nil, e
	}
	rr, e := rows(ctx, tx, `SELECT jsonb_build_object('id',id,'created_at',created_at) FROM forum_posts_v1 WHERE account_id=$1 AND state='published' AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 201`, account, p.AfterAt, null(p.AfterID))
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
		view, e := s.readPost(ctx, tx, str(r, "id"), "")
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
	more := processed < len(rr)
	var next any
	if more && scanned != nil {
		next = pageAfter(p, scanned)
	}
	return Object{"items": items, "nextAfter": next, "scanTruncated": more && processed == 200 && int64(len(items)) < limit, "order": "published", "checkedAt": s.clock()}, nil
}
