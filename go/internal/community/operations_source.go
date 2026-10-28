package community

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// OperationsSourceWithin retains the operations consumer's anonymous Public
// source check. Its caller owns current operator authority; this is not an
// alternate reader for private content or a republication permission.
func (s *Service) OperationsSourceWithin(ctx context.Context, tx pgx.Tx, target Object) (Object, error) {
	no := func() Object {
		return Object{"locator": target, "availability": "unavailable", "content": nil, "publishedUntil": nil}
	}
	r, _, e := s.reportTarget(ctx, tx, target, "", false)
	if e != nil {
		if fault.Status(e) == 403 || fault.Status(e) == 404 {
			return no(), nil
		}
		return nil, e
	}
	action, id := "forum.post.publish", str(target, "versionId")
	if str(target, "kind") == "reply" {
		action, id = "forum.reply.publish", str(target, "replyId")
	}
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1 FOR SHARE", r["permission_id"])
	if e != nil {
		return nil, e
	}
	if p == nil {
		return no(), nil
	}
	state, e := s.permissionDetailWithin(ctx, tx, p, "", true, true, &permissionSelector{Visibility: "Public", PayloadHash: str(r, "payload_hash"), Action: action, ObjectID: id})
	if e != nil {
		return nil, e
	}
	reasons := state.Detail["stoppedReasons"].([]string)
	if len(reasons) > 0 || str(r, "state") != "published" || str(target, "kind") == "post-version" && str(r, "post_state") != "published" || str(r, "payload_text") == "" || r["erased_at"] != nil || r["event_erased"] != nil {
		return no(), nil
	}
	var payload Object
	if e = json.Unmarshal([]byte(str(r, "payload_text")), &payload); e != nil {
		return nil, e
	}
	title := payload["title"]
	if str(target, "kind") == "reply" {
		title = nil
		head, e := s.head(ctx, tx, str(r, "post_id"), false)
		if e != nil {
			return nil, e
		}
		if head != nil && head["current_version_id"] != nil {
			parent, e := s.OperationsSourceWithin(ctx, tx, Object{"kind": "post-version", "postId": r["post_id"], "versionId": head["current_version_id"]})
			if e != nil {
				return nil, e
			}
			title = obj(parent, "content")["title"]
		}
	}
	links := payload["links"]
	if links == nil {
		links = []any{}
	}
	return Object{"locator": target, "availability": "available", "content": Object{"title": title, "body": payload["body"], "links": links}, "publishedUntil": seconds(r["published_until"])}, nil
}

// OperationsNarrativeWithin is confined to the owning operations report reader
// after independent/disclosed/unexpired checks. It checks the exact Private
// grant without substituting the operator for its original audience.
func (s *Service) OperationsNarrativeWithin(ctx context.Context, tx pgx.Tx, event Object) (bool, error) {
	if str(event, "actor_kind") != "official-account" || str(event, "payload_text") == "" || event["erased_at"] != nil {
		return false, nil
	}
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1 FOR SHARE", event["permission_id"])
	if e != nil || p == nil {
		return false, e
	}
	state, e := s.permissionDetailWithin(ctx, tx, p, "", false, true, &permissionSelector{Visibility: "Private", PayloadHash: str(event, "payload_hash"), SkipAudience: true})
	if e != nil {
		return false, e
	}
	return len(state.Detail["stoppedReasons"].([]string)) == 0, nil
}
func (s *Service) OperationsSectionReadableWithin(ctx context.Context, tx pgx.Tx, section Object) (bool, error) {
	return s.rule(ctx, tx, "", obj(obj(section, "audience"), "read"))
}
func (s *Service) OperationsPolicy() Object { return cloneForumPolicy(s.policy()) }
