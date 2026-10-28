package community

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// LifecyclePermissionAllowedWithin is the original export selector: viewer ID
// and exact saved payload hash, without a viewerActor or account audience grant.
// The lifecycle service authenticates its caller before invoking this reader.
func (s *Service) LifecyclePermissionAllowedWithin(ctx context.Context, tx pgx.Tx, permissionID, viewerID, payloadHash, visibility string) (bool, error) {
	if !validID(permissionID) {
		return false, nil
	}
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1 FOR SHARE", permissionID)
	if e != nil || p == nil {
		return false, e
	}
	if payloadHash != "" && str(p, "payload_hash") != payloadHash || visibility != "" && str(p, "visibility") != visibility {
		return false, nil
	}
	_, state, e := s.permissionFor(ctx, tx, Object{"permission_id": permissionID, "payload_hash": p["payload_hash"]}, str(p, "action"), str(p, "object_id"), str(p, "visibility"))
	if e != nil || state != "available" {
		return false, e
	}
	if str(p, "visibility") == "Private" {
		allowed := containsAny(p["viewers"], viewerID)
		if str(p, "authorization_kind") != "official-account" && viewerID == str(p, "subject_id") {
			allowed = true
		}
		if !allowed {
			return false, nil
		}
	}
	if !hasString([]string{"forum.post.publish", "forum.reply.publish"}, str(p, "action")) {
		return true, nil
	}
	current := *s
	current.actor = nil
	current.Authority = nil
	var source Object
	target := Object{}
	if str(p, "action") == "forum.post.publish" {
		source, e = row(ctx, tx, "SELECT to_jsonb(v) FROM forum_versions_v1 v WHERE publication_event_id=$1", p["event_id"])
		if source != nil {
			target = Object{"kind": "post-version", "postId": source["post_id"], "versionId": source["id"]}
		}
	} else {
		source, e = row(ctx, tx, "SELECT to_jsonb(r) FROM forum_replies_v1 r WHERE publication_event_id=$1", p["event_id"])
		if source != nil {
			target = Object{"kind": "reply", "postId": source["post_id"], "replyId": source["id"]}
		}
	}
	if e != nil || source == nil {
		return false, e
	}
	kind, id := "forum-post", str(source, "post_id")
	if str(target, "kind") == "reply" {
		kind, id = "forum-reply", str(source, "id")
	}
	hidden, e := current.operationsHidden(ctx, tx, kind, id)
	if e != nil || hidden {
		return false, e
	}
	if kind == "forum-reply" {
		hidden, e = current.operationsHidden(ctx, tx, "forum-post", str(source, "post_id"))
		if e != nil || hidden {
			return false, e
		}
		hidden, e = current.hidden(ctx, tx, Object{"kind": "post-version", "postId": source["post_id"], "versionId": source["post_version_id"]})
		if e != nil || hidden {
			return false, e
		}
	}
	return current.audienceAllowed(ctx, tx, "", source)
}
