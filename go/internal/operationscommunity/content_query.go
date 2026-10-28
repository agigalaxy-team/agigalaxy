package operationscommunity

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"strings"
	"unicode/utf8"
)

const candidates = `SELECT 'post'::text AS kind,p.id,p.created_at FROM forum_posts_v1 p LEFT JOIN community_accounts a ON a.id=p.account_id LEFT JOIN LATERAL (SELECT permission_id FROM forum_versions_v1 v WHERE v.post_id=p.id AND (p.current_version_id IS NULL OR v.id=p.current_version_id) ORDER BY version_number DESC LIMIT 1) v ON true LEFT JOIN forum_permissions_v1 permission ON permission.id=v.permission_id LEFT JOIN consents c ON c.id=permission.consent_id WHERE a.endpoint=$1 OR p.account_id IS NULL AND p.subject_id IS NOT NULL AND permission.subject_id=p.subject_id AND c.intent->>'subjectId'=p.subject_id AND c.intent->>'endpoint'=$1 AND c.intent->>'recipient'=$1 UNION ALL SELECT 'reply'::text AS kind,r.id,r.created_at FROM forum_replies_v1 r LEFT JOIN community_accounts a ON a.id=r.account_id LEFT JOIN forum_permissions_v1 permission ON permission.id=r.permission_id LEFT JOIN consents c ON c.id=permission.consent_id WHERE a.endpoint=$1 OR r.account_id IS NULL AND r.subject_id IS NOT NULL AND permission.subject_id=r.subject_id AND c.intent->>'subjectId'=r.subject_id AND c.intent->>'endpoint'=$1 AND c.intent->>'recipient'=$1`

func parseContentQuery(input Object) (Object, error) {
	x := copyObject(input)
	if !strict(x, "query", "targetId", "kind", "topic", "visibility", "pinned", "featured", "days", "after", "limit") {
		return nil, invalid()
	}
	if _, ok := x["query"]; !ok {
		x["query"] = ""
	}
	query, ok := x["query"].(string)
	if !ok {
		return nil, invalid()
	}
	query = trim(query)
	if utf8.RuneCountInString(query) > 160 {
		return nil, invalid()
	}
	x["query"] = query
	for _, k := range []string{"kind", "topic", "visibility"} {
		if v, ok := x[k]; ok {
			allowed := map[string][]string{"kind": {"post", "reply"}, "topic": categories, "visibility": {"visible", "hidden", "unavailable"}}[k]
			s, ok := v.(string)
			if !ok || !has(allowed, s) {
				return nil, invalid()
			}
		}
	}
	if v, ok := x["targetId"]; ok {
		s, ok := v.(string)
		if !ok || !validID(s) {
			return nil, invalid()
		}
	}
	if v, ok := x["after"]; ok {
		s, ok := v.(string)
		p := strings.Split(s, ":")
		if !ok || len(p) != 2 || !has([]string{"post", "reply"}, strings.ToLower(p[0])) || !validID(p[1]) {
			return nil, invalid()
		}
	}
	for _, k := range []string{"pinned", "featured"} {
		if v, ok := x[k]; ok {
			if _, ok := v.(bool); !ok {
				return nil, invalid()
			}
		}
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = 25
	}
	if !integer(x["limit"], 1, 100) {
		return nil, invalid()
	}
	if _, ok := x["days"]; !ok {
		x["days"] = 7
	}
	if x["days"] != "all" && (!integer(x["days"], 7, 28) || num(x, "days") != 7 && num(x, "days") != 28) {
		return nil, invalid()
	}
	return x, nil
}
func contentKey(x Object) string { return str(x, "kind") + ":" + str(x, "id") }
func visibilityState(x Object) string {
	if str(x, "sourceState") != "available" {
		return "unavailable"
	}
	if yes(obj(x, "visibility"), "hidden") {
		return "hidden"
	}
	return "visible"
}
func matches(x, q Object) bool {
	for _, k := range []string{"kind", "topic"} {
		if q[k] != nil && q[k] != x[k] {
			return false
		}
	}
	if q["visibility"] != nil && str(q, "visibility") != visibilityState(x) {
		return false
	}
	for _, k := range []string{"pinned", "featured"} {
		if v, ok := q[k]; ok && v != obj(x, "curation")[k] {
			return false
		}
	}
	needle := cases.Lower(language.AmericanEnglish).String(str(q, "query"))
	if needle == "" {
		return true
	}
	values := []any{x["kind"], x["id"], x["postId"], x["versionId"], x["state"], visibilityState(x)}
	if str(x, "sourceState") == "available" {
		values = append(values, x["title"], x["excerpt"], x["body"], obj(x, "author")["uid"], obj(x, "author")["displayName"])
	}
	for _, v := range values {
		if s, ok := v.(string); ok && strings.Contains(cases.Lower(language.AmericanEnglish).String(s), needle) {
			return true
		}
	}
	return false
}
func (s *Service) contentCandidates(ctx context.Context, tx pgx.Tx, q Object, after string, limit int) ([]Object, error) {
	var pivot Object
	if after != "" {
		p := strings.Split(after, ":")
		var e error
		pivot, e = one(ctx, tx, "SELECT to_jsonb(v) FROM("+candidates+")v WHERE kind=$2 AND id=$3", s.Endpoint, p[0], p[1])
		if e != nil {
			return nil, e
		}
		if pivot == nil {
			return nil, fail("operations_content_cursor_changed", 409)
		}
	}
	var from, at, kind, id any
	if q["days"] != "all" {
		from = stamp(periodStart(s.now(), num(q, "days")))
	}
	if pivot != nil {
		at, kind, id = jsDate(pivot["created_at"]), pivot["kind"], pivot["id"]
	}
	return rows(ctx, tx, "SELECT to_jsonb(v) FROM("+candidates+")v WHERE ($2::text IS NULL OR kind=$2) AND ($3::timestamptz IS NULL OR created_at>=$3) AND created_at<=$4 AND ($9::uuid IS NULL OR id=$9::uuid) AND ($5::timestamptz IS NULL OR (created_at,kind,id)<($5::timestamptz,$6::text,$7::uuid)) ORDER BY created_at DESC,kind DESC,id DESC LIMIT $8", s.Endpoint, q["kind"], from, stamp(s.now()), at, kind, id, limit, q["targetId"])
}
func periodStart(now, days int64) int64 {
	n := now + 28800
	return (n/86400)*86400 - 28800 - (days-1)*86400
}
func (s *Service) Contents(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := parseContentQuery(input)
	if e != nil {
		return nil, e
	}
	if e = s.ready(); e != nil {
		return nil, e
	}
	selection := copyObject(q)
	delete(selection, "query")
	selection["hasQuery"] = str(q, "query") != ""
	return s.domain().Run(ctx, a, "community-content-query", selection, func(tx pgx.Tx, a Actor) (Object, error) {
		cache := map[string]Object{}
		read := func(r Object) (Object, error) {
			key := contentKey(r)
			if v, ok := cache[key]; ok {
				return v, nil
			}
			v, e := s.contentView(ctx, tx, a, str(r, "kind"), str(r, "id"), true, false)
			if e != nil && fault.Status(e) == 404 {
				e = nil
				v = nil
			}
			if e == nil {
				cache[key] = v
			}
			return v, e
		}
		r, e := s.contentCandidates(ctx, tx, q, str(q, "after"), 201)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		processed := 0
		var last Object
		for i, row := range r {
			if i == 200 {
				break
			}
			last = row
			processed++
			view, e := read(row)
			if e != nil {
				return nil, e
			}
			if view != nil && matches(view, q) {
				item := copyObject(view)
				for _, k := range []string{"body", "links", "attachments", "publishedUntil"} {
					delete(item, k)
				}
				items = append(items, item)
			}
			if int64(len(items)) == num(q, "limit") {
				break
			}
		}
		var next any
		if processed < len(r) && last != nil {
			next = contentKey(last)
		}
		all, e := s.contentCandidates(ctx, tx, q, "", 2001)
		if e != nil {
			return nil, e
		}
		days := int64(7)
		if num(q, "days") == 28 {
			days = 28
		}
		summary := Object{"available": false, "state": "unavailable", "reason": "public-content-window-too-large", "total": nil, "visible": nil, "hidden": nil, "unavailable": nil, "posts": nil, "replies": nil, "pendingReview": nil, "trendDays": days, "daily": []Object{}}
		if len(all) <= 2000 {
			daily := []Object{}
			byDate := map[string]Object{}
			start := periodStart(s.now(), days)
			for i := int64(0); i < days; i++ {
				date := stamp(start + i*86400 + 28800).Format("2006-01-02")
				day := Object{"date": date, "posts": int64(0), "replies": int64(0)}
				daily = append(daily, day)
				byDate[date] = day
			}
			total, visible, hidden, unavailable, posts, replies := 0, 0, 0, 0, 0, 0
			for _, r := range all {
				view, e := read(r)
				if e != nil {
					return nil, e
				}
				if view == nil || !matches(view, q) {
					continue
				}
				total++
				state := visibilityState(view)
				switch state {
				case "visible":
					visible++
				case "hidden":
					hidden++
				default:
					unavailable++
				}
				key := "posts"
				if str(view, "kind") == "post" {
					posts++
				} else {
					replies++
					key = "replies"
				}
				date := stamp(seconds(view["createdAt"]) + 28800).Format("2006-01-02")
				if day := byDate[date]; day != nil && state == "visible" {
					day[key] = num(day, key) + 1
				}
			}
			summary = Object{"available": true, "state": "available", "reason": nil, "total": total, "visible": visible, "hidden": hidden, "unavailable": unavailable, "posts": posts, "replies": replies, "pendingReview": nil, "trendDays": days, "daily": daily}
		}
		tags, e := s.tags(ctx, tx)
		if e != nil {
			return nil, e
		}
		catalog := s.Forum.Topics()
		topics := append([]Object{}, catalog["items"].([]Object)...)
		topics = append(topics, catalog["unclassified"].(Object))
		return Object{"items": items, "nextAfter": next, "scanTruncated": processed == 200 && int64(len(items)) < num(q, "limit") && len(r) > 200, "summary": summary, "topics": topics, "tags": tags, "permissions": Object{"canManage": contentManage(a)}, "checkedAt": s.now()}, nil
	})
}
