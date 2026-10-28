package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"strings"
)

func (s *Service) AccountChoices(ctx context.Context, account string, raw []byte) (Object, error) {
	q, limit, e := queryInput(raw, "query", "after", "limit")
	if e != nil || limit > 30 {
		return nil, invalid()
	}
	if v, ok := q["after"]; ok && !validID(asString(v)) {
		return nil, invalid()
	}
	query := ""
	if v, ok := q["query"]; ok {
		value, ok := v.(string)
		if !ok || protocol.TextLength(strings.TrimSpace(value)) > 120 {
			return nil, invalid()
		}
		query = strings.TrimSpace(value)
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		rr, e := rows(ctx, tx, `SELECT to_jsonb(a)||jsonb_build_object('display_name',p.display_name,'avatar_key',p.avatar_key,'subject_type',p.subject_type) FROM community_accounts a JOIN official_account_profiles_v1 p ON p.account_id=a.id AND p.query_enabled=true WHERE a.endpoint=$1 AND ($2::uuid IS NULL OR a.id>$2) AND ($3::text='' OR position(lower($3::text) in lower(coalesce(p.display_name,'')))>0 OR a.id::text=$3::text OR a.uid=upper($3::text)) ORDER BY a.id LIMIT $4`, s.Endpoint, q["after"], query, limit+1)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for i, r := range rr {
			if int64(i) >= limit {
				break
			}
			items = append(items, accountView(r, ""))
		}
		var next any
		if int64(len(rr)) > limit {
			next = rr[limit-1]["id"]
		}
		return Object{"items": items, "nextAfter": next, "checkedAt": s.clock()}, nil
	})
}
