package operationscommunity

import (
	"context"
	"github.com/jackc/pgx/v5"
)

func (s *Service) postView(ctx context.Context, tx pgx.Tx, r Object, a Actor, detail bool) (Object, error) {
	source := Object{"availability": "unavailable", "content": nil}
	var e error
	if r["current_version_id"] != nil {
		source, e = s.Forum.OperationsSourceWithin(ctx, tx, Object{"kind": "post-version", "postId": r["id"], "versionId": r["current_version_id"]})
		if e != nil {
			return nil, e
		}
	}
	author, e := one(ctx, tx, "SELECT jsonb_build_object('uid',a.uid,'display_name',p.display_name) FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2", r["account_id"], s.Endpoint)
	if e != nil {
		return nil, e
	}
	var reports int64
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM forum_reports_v1 WHERE target->>'postId'=$1", r["id"]).Scan(&reports); e != nil {
		return nil, e
	}
	out := Object{"id": r["id"], "version": r["head_version"], "currentVersionId": r["current_version_id"], "state": r["state"], "authorAccountId": r["account_id"], "authorId": r["subject_id"], "authorUid": author["uid"], "authorDisplayName": author["display_name"], "title": obj(source, "content")["title"], "sourceState": source["availability"], "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"]), "reportCount": reports, "canManage": permitted(a, "content.hide") || permitted(a, "content.restore") || permitted(a, "content.curate"), "checkedAt": s.now()}
	if detail {
		out["source"], out["contentEditingAllowed"] = source, false
	}
	return out, nil
}
func (s *Service) Posts(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := parsePage(input, "")
	if e != nil {
		return nil, e
	}
	if e = s.ready(); e != nil {
		return nil, e
	}
	return s.domain().Run(ctx, a, "community-posts-query", q, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := rows(ctx, tx, "SELECT to_jsonb(p) FROM forum_posts_v1 p WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2", q["after"], num(q, "limit")+1)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		var next any
		for i, x := range r {
			if int64(i) == num(q, "limit") {
				next = r[i-1]["id"]
				break
			}
			v, e := s.postView(ctx, tx, x, a, false)
			if e != nil {
				return nil, e
			}
			items = append(items, v)
		}
		return Object{"items": items, "nextAfter": next, "checkedAt": s.now()}, nil
	})
}
func (s *Service) Post(ctx context.Context, a Actor, id string) (Object, error) {
	if !validID(id) {
		return nil, invalid()
	}
	if e := s.ready(); e != nil {
		return nil, e
	}
	return s.domain().Run(ctx, a, "community-post-read", Object{"id": id}, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := one(ctx, tx, "SELECT to_jsonb(p) FROM forum_posts_v1 p WHERE id=$1", id)
		if e != nil {
			return nil, e
		}
		if r == nil {
			return nil, fail("not_found", 404)
		}
		return s.postView(ctx, tx, r, a, true)
	})
}
