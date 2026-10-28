package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"

	"github.com/jackc/pgx/v5"
)

func (s *Service) People(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := parse(raw, "query", "after", "limit", "accountId", "accountIds")
	if e != nil {
		return nil, e
	}
	if _, ok := x["query"]; !ok {
		x["query"] = ""
	}
	if v, ok := x["query"].(string); !ok || textLength(trim(v)) > 120 {
		return nil, fail("invalid_chat_request", 400)
	} else {
		x["query"] = trim(v)
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = int64(20)
	}
	if !normalizeInteger(x, "limit", 1, 50) {
		return nil, fail("invalid_chat_request", 400)
	}
	for _, key := range []string{"after", "accountId"} {
		if v, ok := x[key]; ok && !validID(asString(v)) {
			return nil, fail("invalid_chat_request", 400)
		}
	}
	if v, ok := x["accountIds"]; ok {
		ids, ok := v.([]any)
		if !ok || len(ids) < 1 || len(ids) > 50 {
			return nil, fail("invalid_chat_request", 400)
		}
		for _, id := range ids {
			if !validID(asString(id)) {
				return nil, fail("invalid_chat_request", 400)
			}
		}
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		items := []Object{}
		if x["accountId"] != nil || x["accountIds"] != nil {
			ids := uniqueStrings(x["accountIds"])
			if x["accountIds"] == nil {
				ids = []string{str(x, "accountId")}
			}
			rr, e := rows(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT a.id,a.uid,p.display_name,p.avatar_key,p.subject_type FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=ANY($1::uuid[]) AND a.endpoint=$2)q`, ids, s.Endpoint)
			if e != nil {
				return nil, e
			}
			for _, r := range rr {
				items = append(items, Object{"actorRef": "account:" + str(r, "id"), "accountId": r["id"], "uid": r["uid"], "displayName": r["display_name"], "avatarKey": r["avatar_key"], "subjectType": r["subject_type"]})
			}
			return Object{"items": items, "nextAfter": nil}, nil
		}
		rr, e := rows(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT a.id,a.uid,a.endpoint,p.display_name,p.avatar_key,p.subject_type FROM community_accounts a JOIN official_account_profiles_v1 p ON p.account_id=a.id AND p.query_enabled=true WHERE a.endpoint=$1 AND ($2::uuid IS NULL OR a.id>$2) AND ($3::text='' OR position(lower($3::text) in lower(coalesce(p.display_name,'')))>0 OR a.id::text=$3::text OR a.uid=upper($3::text)) ORDER BY a.id LIMIT $4)q`, s.Endpoint, x["after"], x["query"], num(x, "limit")+1)
		if e != nil {
			return nil, e
		}
		var next any
		for i, r := range rr {
			if int64(i) >= num(x, "limit") {
				next = rr[i-1]["id"]
				break
			}
			view := accountlinks.View(r, "")
			view["actorRef"] = "account:" + str(r, "id")
			items = append(items, view)
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
