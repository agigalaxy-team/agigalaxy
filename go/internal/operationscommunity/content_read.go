package operationscommunity

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5"
	"strconv"
	"strings"
)

// ContentViewWithin is the original same-transaction reader for a currently
// proved execution consumer. The caller owns the fresh opaque authority; this
// method keeps current source and capability checks and is not an HTTP grant.
func (s *Service) ContentViewWithin(ctx context.Context, tx pgx.Tx, a Actor, kind, id string, detail, lock bool) (Object, error) {
	return s.contentView(ctx, tx, a, kind, id, detail, lock)
}

func tagView(r Object) Object {
	return Object{"id": r["id"], "name": r["name"], "version": r["revision"], "enabled": r["enabled"], "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"])}
}
func (s *Service) tags(ctx context.Context, tx pgx.Tx) ([]Object, error) {
	r, e := rows(ctx, tx, "SELECT to_jsonb(t) FROM operations_forum_tags_v1 t WHERE endpoint=$1 ORDER BY name,id", s.Endpoint)
	if e != nil {
		return nil, e
	}
	out := []Object{}
	for _, v := range r {
		out = append(out, tagView(v))
	}
	return out, nil
}
func (s *Service) Tags(ctx context.Context, a Actor) (Object, error) {
	return s.domain().Run(ctx, a, "community-tags-query", Object{}, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := s.tags(ctx, tx)
		return Object{"items": r, "permissions": Object{"canManage": permitted(a, "content.tags.manage")}, "checkedAt": s.now()}, e
	})
}
func (s *Service) contentView(ctx context.Context, tx pgx.Tx, a Actor, kind, id string, detail, lock bool) (Object, error) {
	read, e := s.Forum.OperationsContentSourceWithin(ctx, tx, kind, id, lock)
	if e != nil {
		return nil, e
	}
	if !yes(read, "candidate") {
		return nil, fail("not_found", 404)
	}
	head, source, payload := obj(read, "head"), obj(read, "source"), obj(read, "payload")
	version := num(head, "head_version")
	postID, versionID := head["id"], head["current_version_id"]
	if kind == "reply" {
		version = num(head, "revision")
		postID, versionID = head["post_id"], head["post_version_id"]
	}
	own, e := s.visibility(ctx, tx, map[string]string{"post": "forum-post", "reply": "forum-reply"}[kind], id)
	if e != nil {
		return nil, e
	}
	inherited := false
	if kind == "reply" {
		parent, e := s.visibility(ctx, tx, "forum-post", str(head, "post_id"))
		if e != nil {
			return nil, e
		}
		inherited = yes(parent, "hidden")
	}
	hidden := yes(own, "hidden") || inherited || yes(read, "caseHidden")
	curation, e := s.Forum.OperationsCurationWithin(ctx, tx, kind, id, version)
	if e != nil {
		return nil, e
	}
	var topic, title, excerpt any
	author := Object{"accountId": nil, "uid": nil, "displayName": nil, "subjectId": nil}
	available := yes(read, "available")
	parent := obj(read, "parentView")
	if available {
		if kind == "post" {
			topic = source["topic"]
			if topic == nil {
				topic = "unclassified"
			}
			title = payload["title"]
		} else if str(parent, "availability") == "available" {
			topic = parent["originalTopic"]
			if topic == nil {
				topic = "unclassified"
			}
			title = obj(parent, "payload")["title"]
		}
		r, e := one(ctx, tx, "SELECT jsonb_build_object('uid',a.uid,'display_name',p.display_name) FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2", head["account_id"], s.Endpoint)
		if e != nil {
			return nil, e
		}
		author = Object{"accountId": head["account_id"], "uid": r["uid"], "displayName": r["display_name"], "subjectId": head["subject_id"]}
		excerpt = jsSlice(str(payload, "body"), 180)
	}
	effectiveTopic := topic
	if curation["topic"] != nil {
		effectiveTopic = curation["topic"]
	}
	updated := head["updated_at"]
	if updated == nil {
		updated = head["created_at"]
	}
	state := "unavailable"
	if available {
		state = "available"
	}
	out := Object{"kind": kind, "id": id, "postId": postID, "versionId": versionID, "version": version, "author": author, "title": title, "excerpt": excerpt, "topic": effectiveTopic, "originalTopic": topic, "state": head["state"], "sourceState": state, "createdAt": iso(head["created_at"]), "updatedAt": iso(updated), "visibility": Object{"version": own["version"], "hidden": hidden, "ownHidden": own["hidden"], "inheritedHidden": inherited, "caseHidden": read["caseHidden"], "until": own["until"], "operationId": own["operationId"]}, "curation": curation, "capabilities": Object{"canHide": permitted(a, "content.hide") && available && !hidden, "canRestore": permitted(a, "content.restore") && available && yes(own, "hidden") && !inherited && !yes(read, "caseHidden"), "canBatchHide": permitted(a, "content.batch.hide") && available && !hidden, "canBatchRestore": permitted(a, "content.batch.restore") && available && yes(own, "hidden") && !inherited && !yes(read, "caseHidden"), "canCurate": permitted(a, "content.curate") && available}, "maxHideSeconds": s.policy()["maxGovernanceHideSeconds"]}
	if detail {
		out["body"], out["links"], out["attachments"], out["publishedUntil"] = nil, []any{}, []Object{}, nil
		if available {
			out["body"], out["links"], out["publishedUntil"] = payload["body"], payload["links"], seconds(source["published_until"])
			if out["links"] == nil {
				out["links"] = []any{}
			}
			files, e := s.Forum.OperationsAttachmentMetadataWithin(ctx, tx, payload)
			if e != nil {
				return nil, e
			}
			metadata := []Object{}
			for _, file := range files {
				ok := !hidden && str(file, "state") == "available" && !yes(file, "cleanupPending") && (kind == "post" || str(parent, "availability") == "available")
				var path any
				availability := "unavailable"
				if ok {
					availability = "available"
					path = "/v1/operations/community/content/" + kind + "/" + id + "/attachments/" + str(file, "attachmentId") + "/content"
				}
				metadata = append(metadata, Object{"id": file["attachmentId"], "name": file["name"], "mediaType": file["mediaType"], "byteSize": file["size"], "state": file["state"], "availability": availability, "contentPath": path})
			}
			out["attachments"] = metadata
		}
	}
	return out, nil
}
func jsSlice(s string, limit int) any {
	var out strings.Builder
	n := 0
	for _, r := range s {
		size := 1
		if r > 0xffff {
			size = 2
		}
		if n+size > limit {
			raw, _ := json.Marshal(out.String())
			return json.RawMessage(string(raw[:len(raw)-1]) + fmt.Sprintf("\\u%04x\"", 0xd800+((r-0x10000)>>10)))
		}
		out.WriteRune(r)
		n += size
		if n == limit {
			break
		}
	}
	return out.String()
}
func sequence(s string) bool {
	if s == "" || s[0] == '0' || len(s) > 19 {
		return false
	}
	_, e := strconv.ParseInt(s, 10, 64)
	return e == nil && strings.IndexFunc(s, func(r rune) bool { return r < '0' || r > '9' }) < 0
}
func (s *Service) contentHistory(ctx context.Context, tx pgx.Tx, kind, id string, q Object) (Object, error) {
	if !strict(q, "historyAfter") {
		return nil, invalid()
	}
	var after any
	if q["historyAfter"] != nil {
		v := str(q, "historyAfter")
		if !sequence(v) {
			return nil, invalid()
		}
		after = v
	}
	r, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM operations_forum_content_events_v1 e WHERE endpoint=$1 AND target_kind=$2 AND target_id=$3 AND ($4::bigint IS NULL OR sequence<$4::bigint) ORDER BY sequence DESC LIMIT 51", s.Endpoint, kind, id, after)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for i, v := range r {
		if i == 50 {
			break
		}
		ids = append(ids, str(v, "operator_id"))
	}
	names, e := s.domain().NamesWithin(ctx, tx, ids)
	if e != nil {
		return nil, e
	}
	items := []Object{}
	var next any
	for i, v := range r {
		if i == 50 {
			next = fmt.Sprint(r[49]["sequence"])
			break
		}
		items = append(items, Object{"id": v["id"], "sequence": fmt.Sprint(v["sequence"]), "kind": v["kind"], "operatorId": v["operator_id"], "operatorDisplayName": names[str(v, "operator_id")], "operationId": v["operation_id"], "sourceVersion": v["source_version"], "revision": v["revision"], "reason": v["reason"], "changes": v["changes"], "createdAt": iso(v["created_at"])})
	}
	return Object{"items": items, "nextAfter": next}, nil
}
func contentManage(a Actor) bool {
	for _, code := range []string{"content.hide", "content.restore", "content.curate", "content.batch.hide", "content.batch.restore"} {
		if permitted(a, code) {
			return true
		}
	}
	return false
}
func (s *Service) Content(ctx context.Context, a Actor, kind, id string, input Object) (Object, error) {
	if e := s.ready(); e != nil {
		return nil, e
	}
	if !strict(input, "historyAfter") {
		return nil, invalid()
	}
	if v, ok := input["historyAfter"]; ok {
		txt, ok := v.(string)
		if !ok || !sequence(txt) {
			return nil, invalid()
		}
	}
	return s.domain().Run(ctx, a, "community-content-read", Object{"kind": kind, "id": id}, func(tx pgx.Tx, a Actor) (Object, error) {
		view, e := s.contentView(ctx, tx, a, kind, id, true, false)
		if e != nil {
			return nil, e
		}
		history, e := s.contentHistory(ctx, tx, kind, id, input)
		return Object{"content": view, "history": history, "permissions": Object{"canManage": contentManage(a)}, "checkedAt": s.now()}, e
	})
}

// TagByID returns one current tag under the existing tags-read authority.
func (s *Service) TagByID(ctx context.Context, a Actor, id string) (Object, error) {
	if !validID(id) {
		return nil, invalid()
	}
	return s.domain().Run(ctx, a, "community-tags-query", Object{"id": id}, func(tx pgx.Tx, _ Actor) (Object, error) {
		row, e := one(ctx, tx, "SELECT to_jsonb(t) FROM operations_forum_tags_v1 t WHERE endpoint=$1 AND id=$2", s.Endpoint, id)
		if e != nil {
			return nil, e
		}
		if row == nil {
			return nil, fail("not_found", 404)
		}
		return Object{"tag": tagView(row), "checkedAt": s.now()}, nil
	})
}
