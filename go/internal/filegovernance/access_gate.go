package filegovernance

import (
	"context"
	"github.com/jackc/pgx/v5"
)

func AccessWithin(ctx context.Context, tx pgx.Tx, endpoint, kind, id string, now int64, detail bool) (Object, error) {
	if _, e := table(kind); e != nil {
		return nil, e
	}
	columns := "revision,stopped_until"
	if detail {
		columns = "revision,stopped_until,operation_id,operator_id,reason,updated_at"
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT "+columns+" FROM operations_file_access_heads_v1 WHERE endpoint=$1 AND kind=$2 AND file_id=$3)q", endpoint, kind, id)
	if e != nil {
		return nil, e
	}
	var until any
	if r["stopped_until"] != nil {
		until = timestamp(r["stopped_until"]).Unix()
	}
	return Object{"revision": num(r, "revision"), "stopped": until != nil && until.(int64) > now, "until": until, "operationId": r["operation_id"], "operatorId": r["operator_id"], "reason": r["reason"], "changedAt": iso(r["updated_at"])}, nil
}
func RestorationBlockedWithin(ctx context.Context, tx pgx.Tx, kind string, r Object, a *FileAdapter, now int64) (*string, error) {
	no := func(reason string) (*string, error) { return &reason, nil }
	if r == nil || r["purged_at"] != nil || r["revoked_at"] != nil || truth(r, "purge_pending") || str(r, "state") != "available" || timestamp(expiry(r)).IsZero() || due(expiry(r), now) {
		return no("file-unavailable")
	}
	if a != nil && a.AuthorPending != nil {
		pending, e := a.AuthorPending(ctx, tx, r)
		if e != nil {
			return nil, e
		}
		if pending {
			return no("file-unavailable")
		}
	}
	if kind == "chat" {
		if r["message_id"] == nil {
			return nil, nil
		}
		m, e := row(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT state,expires_at FROM chat_message_refs WHERE message_id=$1 AND room_id=$2)q", r["message_id"], r["room_id"])
		if e != nil {
			return nil, e
		}
		if m != nil && str(m, "state") == "accepted" && !timestamp(m["expires_at"]).IsZero() && !due(m["expires_at"], now) {
			return nil, nil
		}
		return no("source-unavailable")
	}
	if kind != "forum" || a == nil || a.ForumPermission == nil {
		return no("source-unavailable")
	}
	links, e := rows(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT post_id,version_id,reply_id,published_until FROM forum_attachment_links_v1 WHERE attachment_id=$1 ORDER BY source_key LIMIT 201)q", r["id"])
	if e != nil {
		return nil, e
	}
	if len(links) == 0 {
		if r["published_at"] != nil {
			return no("source-unavailable")
		}
		return nil, nil
	}
	if len(links) > 200 {
		return no("source-unavailable")
	}
	allowed := func(source Object, action, objectID string) (bool, error) {
		if source == nil || str(source, "state") != "published" || source["erased_at"] != nil || source["event_erased"] != nil || timestamp(source["published_until"]).IsZero() || due(source["published_until"], now) {
			return false, nil
		}
		return a.ForumPermission(ctx, tx, str(source, "permission_id"), str(source, "payload_hash"), action, objectID)
	}
	for _, link := range links {
		if timestamp(link["published_until"]).IsZero() || due(link["published_until"], now) {
			continue
		}
		parent, e := row(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT v.id,v.state,v.permission_id,v.payload_hash,v.published_until,v.erased_at,p.state AS post_state,p.erased_at AS post_erased,e.erased_at AS event_erased FROM forum_versions_v1 v JOIN forum_posts_v1 p ON p.id=v.post_id LEFT JOIN forum_events_v1 e ON e.id=v.publication_event_id WHERE v.id=$1 AND v.post_id=$2)q`, link["version_id"], link["post_id"])
		if e != nil {
			return nil, e
		}
		if str(parent, "post_state") != "published" || parent["post_erased"] != nil {
			continue
		}
		ok, e := allowed(parent, "forum.post.publish", str(link, "version_id"))
		if e != nil {
			return nil, e
		}
		if !ok {
			continue
		}
		if link["reply_id"] == nil {
			return nil, nil
		}
		reply, e := row(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT r.id,r.state,r.permission_id,r.payload_hash,r.published_until,r.erased_at,e.erased_at AS event_erased FROM forum_replies_v1 r LEFT JOIN forum_events_v1 e ON e.id=r.publication_event_id WHERE r.id=$1 AND r.post_id=$2 AND r.post_version_id=$3)q`, link["reply_id"], link["post_id"], link["version_id"])
		if e != nil {
			return nil, e
		}
		ok, e = allowed(reply, "forum.reply.publish", str(link, "reply_id"))
		if e != nil {
			return nil, e
		}
		if ok {
			return nil, nil
		}
	}
	return no("source-unavailable")
}
