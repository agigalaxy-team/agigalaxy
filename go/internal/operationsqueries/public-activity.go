package operationsqueries

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

func (b *Workbench) publicActivity(ctx context.Context, tx pgx.Tx, at int64) (Object, error) {
	return b.PublicActivityWithin(ctx, tx, at, 7, nil)
}

// PublicActivityWithin retains the shared original anonymous qualification;
// account summaries only select the original author-attributed candidates.
func (b *Workbench) PublicActivityWithin(ctx context.Context, tx pgx.Tx, at int64, selectedDays int, accountID *string) (Object, error) {
	days := int64(selectedDays)
	start := (at+8*3600)/86400*86400 - 8*3600 - (days-1)*86400
	period := Object{"from": time.Unix(start, 0).UTC().Format("2006-01-02T15:04:05.000Z"), "to": time.Unix(at, 0).UTC().Format("2006-01-02T15:04:05.000Z"), "timeZone": "Asia/Shanghai"}
	base := Object{"days": days, "period": period, "basis": "current-public-content-by-first-publication-time", "sourceTypes": []string{"public-post", "public-reply"}}
	unavailable := func(reason string) Object {
		return merge(base, Object{"available": false, "state": "unavailable", "reason": reason, "totals": Object{"posts": nil, "replies": nil}, "daily": []any{}, "lastActivityAt": nil})
	}
	if b.Forum == nil {
		return unavailable("public-activity-reader-unavailable"), nil
	}
	daily := []any{}
	byDate := map[string]Object{}
	for n := int64(0); n < days; n++ {
		row := Object{"date": shanghaiDay(start + n*86400), "posts": 0, "replies": 0}
		daily = append(daily, row)
		byDate[str(row["date"])] = row
	}
	var afterAt, afterKind, afterID any
	var last any
	for {
		candidates, e := sqlRows(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT sources.*,occurred_at::text AS cursor_at FROM (
 SELECT 'post' AS kind,p.id AS post_id,v.id AS source_id,v.permission_id,v.payload_hash,p.created_at AS occurred_at,NULL::uuid AS parent_source_id,NULL::uuid AS parent_permission_id,NULL::text AS parent_payload_hash
 FROM forum_posts_v1 p JOIN forum_versions_v1 v ON v.id=p.current_version_id JOIN forum_events_v1 e ON e.id=v.publication_event_id
 WHERE p.state='published' AND p.erased_at IS NULL AND v.state='published' AND v.erased_at IS NULL AND e.erased_at IS NULL AND e.payload_text IS NOT NULL AND v.published_until>$1 AND p.created_at>=$2 AND p.created_at<=$1 AND ($6::uuid IS NULL OR p.account_id=$6)
 UNION ALL
 SELECT 'reply' AS kind,r.post_id,r.id,r.permission_id,r.payload_hash,r.created_at,v.id AS parent_source_id,v.permission_id AS parent_permission_id,v.payload_hash AS parent_payload_hash
 FROM forum_replies_v1 r JOIN forum_events_v1 e ON e.id=r.publication_event_id JOIN forum_versions_v1 v ON v.id=r.post_version_id JOIN forum_posts_v1 p ON p.id=r.post_id JOIN forum_events_v1 pe ON pe.id=v.publication_event_id
 WHERE r.state='published' AND r.erased_at IS NULL AND e.erased_at IS NULL AND e.payload_text IS NOT NULL AND r.published_until>$1 AND p.state='published' AND p.erased_at IS NULL AND v.state='published' AND v.erased_at IS NULL AND pe.erased_at IS NULL AND pe.payload_text IS NOT NULL AND v.published_until>$1 AND r.created_at>=$2 AND r.created_at<=$1 AND ($6::uuid IS NULL OR r.account_id=$6)
 ) sources WHERE $3::timestamptz IS NULL OR (occurred_at,kind,source_id)>($3::timestamptz,$4::text,$5::uuid) ORDER BY occurred_at,kind,source_id LIMIT 100) r`, time.Unix(at, 0), time.Unix(start, 0), afterAt, afterKind, afterID, accountID)
		if e != nil {
			return nil, e
		}
		if len(candidates) == 0 {
			break
		}
		// At most one bounded wave is retained. Permission/parent/governance checks
		// remain the owning community predicate, without loading body projections.
		allowed := map[string]bool{}
		check := func(kind, post, id, permission, hash string) (bool, error) {
			key := kind + ":" + post + ":" + id + ":" + permission + ":" + hash
			if result, known := allowed[key]; known {
				return result, nil
			}
			result, e := b.Forum.ActivityAllowedWithin(ctx, tx, kind, post, id, permission, hash, at)
			if e == nil {
				allowed[key] = result
			}
			return result, e
		}
		for _, row := range candidates {
			kind := str(row["kind"])
			qualified, e := check(kind, str(row["post_id"]), str(row["source_id"]), str(row["permission_id"]), str(row["payload_hash"]))
			if e != nil {
				return nil, e
			}
			if qualified && kind == "reply" {
				qualified, e = check("post", str(row["post_id"]), str(row["parent_source_id"]), str(row["parent_permission_id"]), str(row["parent_payload_hash"]))
				if e != nil {
					return nil, e
				}
			}
			if !qualified {
				continue
			}
			occurred, e := time.Parse(time.RFC3339Nano, str(row["occurred_at"]))
			if e != nil {
				return unavailable("public-activity-source-invalid"), nil
			}
			date := byDate[shanghaiDay(occurred.Unix())]
			if date == nil {
				return unavailable("public-activity-source-invalid"), nil
			}
			key := "posts"
			if kind == "reply" {
				key = "replies"
			}
			date[key] = date[key].(int) + 1
			stamp := occurred.UTC().Format("2006-01-02T15:04:05.000Z")
			if last == nil || stamp > str(last) {
				last = stamp
			}
		}
		tail := candidates[len(candidates)-1]
		if str(tail["cursor_at"]) == "" {
			return unavailable("public-activity-source-invalid"), nil
		}
		afterAt, afterKind, afterID = tail["cursor_at"], tail["kind"], tail["source_id"]
		if len(candidates) < 100 {
			break
		}
	}
	posts, replies := 0, 0
	for _, value := range daily {
		row := object(value)
		posts += row["posts"].(int)
		replies += row["replies"].(int)
	}
	return merge(base, Object{"available": true, "state": "available", "reason": nil, "daily": daily, "totals": Object{"posts": posts, "replies": replies}, "lastActivityAt": last}), nil
}
