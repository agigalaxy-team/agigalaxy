package community

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
)

type DiscoveryReference struct{ Kind, ID string }

// ReadPublicDiscoveryBatchWithin returns the same anonymous current-source
// information needed by discovery, without version history or attachments.
// The caller supplies a repeatable-read transaction for the entire snapshot.
func (s *Service) ReadPublicDiscoveryBatchWithin(ctx context.Context, tx pgx.Tx, refs []DiscoveryReference) ([]Object, error) {
	if s == nil || s.Endpoint == "" {
		return nil, fail("forum_service_unavailable", 503)
	}
	current := *s
	current.actor = nil
	current.Authority = nil
	current.workerPublicRead = true
	s = &current
	if len(refs) > 200 {
		return nil, invalid()
	}
	posts, replies := []string{}, []string{}
	for _, ref := range refs {
		if !validID(ref.ID) || (ref.Kind != "post" && ref.Kind != "reply") {
			return nil, invalid()
		}
		if ref.Kind == "post" {
			posts = append(posts, ref.ID)
		} else {
			replies = append(replies, ref.ID)
		}
	}
	postMap, replyMap, versionMap := map[string]Object{}, map[string]Object{}, map[string]Object{}
	heads, e := rows(ctx, tx, `SELECT to_jsonb(p) FROM forum_posts_v1 p WHERE id=ANY($1::uuid[])`, batchIDs(posts...))
	if e != nil {
		return nil, e
	}
	versionIDs := []string{}
	for _, head := range heads {
		postMap[str(head, "id")] = head
		versionIDs = append(versionIDs, str(head, "current_version_id"))
	}
	replyRows, e := rows(ctx, tx, `SELECT to_jsonb(r)||jsonb_build_object('payload_text',ev.payload_text,'event_erased',ev.erased_at) FROM forum_replies_v1 r LEFT JOIN forum_events_v1 ev ON ev.id=r.publication_event_id WHERE r.id=ANY($1::uuid[])`, batchIDs(replies...))
	if e != nil {
		return nil, e
	}
	for _, reply := range replyRows {
		replyMap[str(reply, "id")] = reply
		versionIDs = append(versionIDs, str(reply, "post_version_id"))
		posts = append(posts, str(reply, "post_id"))
	}
	versions, e := rows(ctx, tx, `SELECT to_jsonb(v)||jsonb_build_object('payload_text',ev.payload_text,'event_erased',ev.erased_at,'post_state',p.state,'head_version',p.head_version,'current_version_id',p.current_version_id,'post_created_at',p.created_at,'post_updated_at',p.updated_at) FROM forum_versions_v1 v JOIN forum_posts_v1 p ON p.id=v.post_id LEFT JOIN forum_events_v1 ev ON ev.id=v.publication_event_id WHERE v.id=ANY($1::uuid[])`, batchIDs(versionIDs...))
	if e != nil {
		return nil, e
	}
	for _, version := range versions {
		versionMap[str(version, "id")] = version
	}
	all := append(append([]Object{}, versions...), replyRows...)
	facts, e := s.discoveryAuxiliaryFacts(ctx, tx, all, posts, replies)
	if e != nil {
		return nil, e
	}
	targets, seen := []Object{}, map[string]bool{}
	add := func(target Object) {
		if s.Governance == nil && str(target, "kind") == "reply" {
			target = clone(target)
			delete(target, "postId")
			delete(target, "postVersionId")
		}
		key := targetKey(target)
		if !seen[key] {
			seen[key] = true
			targets = append(targets, target)
		}
	}
	for _, version := range versions {
		add(Object{"kind": "post-version", "postId": version["post_id"], "versionId": version["id"]})
	}
	for _, reply := range replyRows {
		add(Object{"kind": "reply", "replyId": reply["id"], "contentRevision": 1, "postId": reply["post_id"], "postVersionId": reply["post_version_id"]})
	}
	governance := map[string]bool{}
	_, batchAdapter := s.Governance.(DiscoveryGovernanceBatch)
	if s.Governance == nil || batchAdapter {
		governance, e = s.discoveryGovernanceFacts(ctx, tx, targets, facts)
		if e != nil {
			return nil, e
		}
	}
	hidden := func(target Object) (bool, error) {
		kind, id := "forum-post", str(target, "postId")
		if str(target, "kind") == "reply" {
			kind, id = "forum-reply", str(target, "replyId")
		}
		if !s.ignoreOperationsVisibility && (facts.hides[kind+":"+id] || kind == "forum-reply" && facts.hides["forum-post:"+str(target, "postId")]) {
			return true, nil
		}
		if s.Governance != nil && !batchAdapter {
			return s.Governance.Hidden(ctx, tx, target)
		}
		if s.Governance == nil && kind == "forum-reply" {
			target = clone(target)
			delete(target, "postId")
			delete(target, "postVersionId")
		}
		return governance[targetKey(target)], nil
	}
	audience := func(source Object) (bool, error) {
		if !truth(source, "audience_inherited") {
			ok, e := s.rule(ctx, tx, "", obj(audienceOf(source), "read"))
			if e != nil || !ok {
				return ok, e
			}
		}
		if parents, ok := source["parent_audience"].([]any); ok {
			for _, value := range parents {
				rule, _ := value.(map[string]any)
				ok, e := s.rule(ctx, tx, "", rule)
				if e != nil || !ok {
					return ok, e
				}
			}
		}
		if id := str(source, "section_id"); id != "" {
			section := facts.sections[id]
			if section == nil || (!s.ignoreOperationsVisibility && facts.hides["forum-section:"+id]) {
				return false, nil
			}
			return s.rule(ctx, tx, "", obj(obj(section, "audience"), "read"))
		}
		return true, nil
	}
	versionView := func(version Object) (Object, error) {
		if version == nil || str(version, "state") == "withdrawn" || str(version, "post_state") == "withdrawn" {
			return nil, nil
		}
		id, post := str(version, "id"), str(version, "post_id")
		if !s.discoveryPermissionAllowed(facts.permissions[str(version, "permission_id")], version, "forum.post.publish", id) || str(version, "payload_text") == "" || version["erased_at"] != nil || version["event_erased"] != nil {
			return nil, nil
		}
		isHidden, e := hidden(Object{"kind": "post-version", "postId": post, "versionId": id})
		if e != nil || isHidden {
			return nil, e
		}
		ok, e := audience(version)
		if e != nil || !ok {
			return nil, e
		}
		var payload Object
		if json.Unmarshal([]byte(str(version, "payload_text")), &payload) != nil || version["topic"] != payload["topic"] {
			return nil, nil
		}
		var source any
		if str(version, "current_version_id") == id {
			source = version["head_version"]
		}
		key := "post:" + post
		curated := curationView(facts.curations[key], source, facts.tags[key])
		topic := str(curated, "topic")
		if topic == "" {
			topic = str(payload, "topic")
		}
		if topic == "" {
			topic = "unclassified"
		}
		return Object{"availability": "available", "currentVersionId": version["current_version_id"], "payload": payload, "topic": topic, "operatorCuration": curated, "authorAccountId": version["account_id"], "createdAt": seconds(version["post_created_at"]), "publishedUntil": seconds(version["published_until"])}, nil
	}
	out := make([]Object, len(refs))
	for i, ref := range refs {
		if ref.Kind == "post" {
			head := postMap[ref.ID]
			if head == nil || str(head, "current_version_id") == "" {
				continue
			}
			version := versionMap[str(head, "current_version_id")]
			if version == nil || str(version, "post_id") != ref.ID {
				continue
			}
			view, e := versionView(version)
			if e != nil {
				return nil, e
			}
			if view != nil {
				if id := str(view, "authorAccountId"); id != "" && !facts.accounts[id] {
					continue
				}
				out[i] = view
			}
			continue
		}
		r := replyMap[ref.ID]
		if r == nil || str(r, "state") == "withdrawn" {
			continue
		}
		parent := versionMap[str(r, "post_version_id")]
		if parent == nil || str(parent, "post_id") != str(r, "post_id") {
			continue
		}
		target := Object{"kind": "reply", "replyId": ref.ID, "contentRevision": 1, "postId": r["post_id"], "postVersionId": r["post_version_id"]}
		if !s.discoveryPermissionAllowed(facts.permissions[str(r, "permission_id")], r, "forum.reply.publish", ref.ID) || str(r, "payload_text") == "" || r["erased_at"] != nil || r["event_erased"] != nil {
			continue
		}
		isHidden, e := hidden(target)
		if e != nil {
			return nil, e
		}
		replyHidden := isHidden
		isHidden, e = hidden(Object{"kind": "post-version", "postId": r["post_id"], "versionId": r["post_version_id"]})
		if e != nil {
			return nil, e
		}
		if isHidden || replyHidden {
			continue
		}
		ok, e := audience(r)
		if e != nil {
			return nil, e
		}
		if !ok {
			continue
		}
		parentView, e := versionView(parent)
		if e != nil {
			return nil, e
		}
		if parentView == nil {
			continue
		}
		var payload Object
		if json.Unmarshal([]byte(str(r, "payload_text")), &payload) != nil {
			continue
		}
		key := "reply:" + ref.ID
		curated := curationView(facts.curations[key], r["revision"], facts.tags[key])
		topic := str(curated, "topic")
		if topic == "" {
			topic = str(parentView, "topic")
		}
		if topic == "" {
			topic = "unclassified"
		}
		if id := str(r, "account_id"); id != "" && !facts.accounts[id] {
			continue
		}
		out[i] = Object{"availability": "available", "parentAvailability": "available", "revision": r["revision"], "locator": Object{"postId": r["post_id"]}, "payload": payload, "topic": topic, "operatorCuration": curated, "authorAccountId": r["account_id"], "createdAt": seconds(r["created_at"]), "publishedUntil": seconds(r["published_until"])}
	}
	return out, nil
}
