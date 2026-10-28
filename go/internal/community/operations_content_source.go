package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (s *Service) OperationsCurationWithin(ctx context.Context, tx pgx.Tx, kind, id string, version int64) (Object, error) {
	return s.curation(ctx, tx, kind, id, version)
}
func (s *Service) OperationsAttachmentMetadataWithin(ctx context.Context, tx pgx.Tx, payload Object) ([]Object, error) {
	return s.metadata(ctx, tx, payload)
}

// OperationsContentSourceWithin is the original retained-public-shape proof and
// current source reader. It ignores only operator visibility while evaluating
// the source; case restrictions remain separately reported and parent-derived
// title/category still need the parent's ordinary current public permission.
func (s *Service) OperationsContentSourceWithin(ctx context.Context, tx pgx.Tx, kind, id string, lock bool) (Object, error) {
	if !validID(id) || !hasString([]string{"post", "reply"}, kind) {
		return nil, fail("invalid_operations_request", 400)
	}
	var head, source Object
	var e error
	version := func(post, id string, lock bool) (Object, error) {
		clause := ""
		if lock {
			clause = " FOR UPDATE OF v"
		}
		return row(ctx, tx, `SELECT to_jsonb(v)||jsonb_build_object('event_erased',e.erased_at) FROM forum_versions_v1 v LEFT JOIN forum_events_v1 e ON e.id=v.publication_event_id WHERE v.post_id=$1 AND ($2::uuid IS NULL OR v.id=$2) ORDER BY v.version_number DESC LIMIT 1`+clause, post, null(id))
	}
	if kind == "post" {
		head, e = s.head(ctx, tx, id, lock)
		if e == nil && head != nil {
			source, e = version(id, str(head, "current_version_id"), lock)
		}
	} else {
		clause := ""
		if lock {
			clause = " FOR UPDATE OF r"
		}
		head, e = row(ctx, tx, "SELECT to_jsonb(r)||jsonb_build_object('event_erased',e.erased_at) FROM forum_replies_v1 r LEFT JOIN forum_events_v1 e ON e.id=r.publication_event_id WHERE r.id=$1"+clause, id)
		source = head
	}
	if e != nil {
		return nil, e
	}
	if head == nil {
		return nil, fail("not_found", 404)
	}
	var belongs bool
	if head["account_id"] != nil {
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2)", head["account_id"], s.Endpoint).Scan(&belongs)
	} else if head["subject_id"] != nil && source["permission_id"] != nil {
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM forum_permissions_v1 p JOIN consents c ON c.id=p.consent_id WHERE p.id=$1 AND p.subject_id=$2 AND c.intent->>'subjectId'=$2 AND c.intent->>'endpoint'=$3 AND c.intent->>'recipient'=$3)`, source["permission_id"], head["subject_id"], s.Endpoint).Scan(&belongs)
	}
	if e != nil {
		return nil, e
	}
	if !belongs {
		return nil, fail("not_found", 404)
	}
	result := Object{"head": head, "source": source, "candidate": false, "available": false, "payload": nil, "parentView": nil, "caseHidden": false}
	if source == nil {
		return result, nil
	}
	candidate := str(obj(audienceOf(source), "read"), "kind") == "everyone"
	if sectionID := str(source, "section_id"); sectionID != "" {
		section, e := s.section(ctx, tx, sectionID)
		if e != nil {
			return nil, e
		}
		candidate = candidate && section != nil && str(obj(obj(section, "audience"), "read"), "kind") == "everyone"
	}
	if kind == "reply" {
		parent, e := version(str(source, "post_id"), str(source, "post_version_id"), false)
		if e != nil {
			return nil, e
		}
		candidate = candidate && parent != nil && str(obj(audienceOf(parent), "read"), "kind") == "everyone"
	}
	result["candidate"] = candidate
	if !candidate {
		return result, nil
	}
	target := Object{"kind": "post-version", "postId": head["id"], "versionId": source["id"]}
	if kind == "reply" {
		target = Object{"kind": "reply", "replyId": head["id"], "contentRevision": 1}
	}
	caseHidden, e := s.governanceHidden(ctx, tx, target)
	if e != nil {
		return nil, e
	}
	if !caseHidden && kind == "reply" {
		caseHidden, e = s.governanceHidden(ctx, tx, Object{"kind": "post-version", "postId": head["post_id"], "versionId": head["post_version_id"]})
		if e != nil {
			return nil, e
		}
	}
	result["caseHidden"] = caseHidden
	if str(head, "state") != "published" || str(source, "state") != "published" || head["erased_at"] != nil || source["erased_at"] != nil || source["event_erased"] != nil || kind == "post" && head["current_version_id"] != source["id"] {
		return result, nil
	}
	current := *s
	current.actor = nil
	current.Authority = nil
	current.ignoreOperationsVisibility = true
	current.workerPublicRead = true
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1", source["permission_id"])
	if e != nil {
		return nil, e
	}
	if p == nil {
		return result, nil
	}
	action := "forum.post.publish"
	if kind == "reply" {
		action = "forum.reply.publish"
	}
	status, e := current.permissionDetailWithin(ctx, tx, p, "", true, false, &permissionSelector{Visibility: "Public", PayloadHash: str(source, "payload_hash"), Action: action, ObjectID: str(source, "id")})
	if e != nil {
		return nil, e
	}
	if len(status.Detail["stoppedReasons"].([]string)) > 0 {
		return result, nil
	}
	event, e := row(ctx, tx, "SELECT jsonb_build_object('payload_text',payload_text,'erased_at',erased_at) FROM forum_events_v1 WHERE id=$1", source["publication_event_id"])
	if e != nil {
		return nil, e
	}
	if str(event, "payload_text") == "" || event["erased_at"] != nil {
		return result, nil
	}
	var payload Object
	if e = protocol.Decode([]byte(str(event, "payload_text")), &payload); e != nil {
		return nil, e
	}
	if kind == "post" && source["topic"] != payload["topic"] {
		return result, nil
	}
	if kind == "reply" {
		view, e := s.readVersion(ctx, tx, str(source, "post_id"), str(source, "post_version_id"), "")
		if e != nil {
			return nil, e
		}
		result["parentView"] = view
	}
	result["available"], result["payload"] = true, payload
	return result, nil
}
