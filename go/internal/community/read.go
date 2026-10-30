package community

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
)

func (s *Service) unavailable(locator Object, state string) Object {
	return Object{"locator": locator, "availability": state, "checkedAt": s.clock()}
}
func (s *Service) author(ctx context.Context, tx pgx.Tx, r Object) (Object, error) {
	kind := "account"
	if r["subject_id"] != nil {
		kind = "identity"
	}
	a := Object{"kind": kind, "subjectId": r["subject_id"], "accountId": r["account_id"], "uid": nil, "displayName": nil, "avatarKey": nil, "subjectType": nil}
	if r["account_id"] != nil && !s.workerPublicRead {
		v, e := row(ctx, tx, `SELECT jsonb_build_object('uid',a.uid,'displayName',nullif(btrim(p.display_name),''),'avatarKey',p.avatar_key,'subjectType',p.subject_type) FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2`, r["account_id"], s.Endpoint)
		if e != nil {
			return nil, e
		}
		for k, x := range v {
			a[k] = x
		}
	}
	return Object{"authorId": r["subject_id"], "authorAccountId": r["account_id"], "author": a}, nil
}
func (s *Service) curation(ctx context.Context, tx pgx.Tx, kind, id string, version any) (Object, error) {
	r, e := row(ctx, tx, "SELECT to_jsonb(c) FROM operations_forum_curation_v1 c WHERE endpoint=$1 AND target_kind=$2 AND target_id=$3", s.Endpoint, kind, id)
	if e != nil {
		return nil, e
	}
	if !curationApplies(r, version) {
		return curationView(r, version, nil), nil
	}
	a, _ := r["tag_ids"].([]any)
	ids := []string{}
	for _, v := range a {
		ids = append(ids, asString(v))
	}
	tags, e := rows(ctx, tx, `SELECT jsonb_build_object('id',id,'name',name,'version',revision,'enabled',enabled,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM operations_forum_tags_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[]) AND enabled=true ORDER BY name,id`, s.Endpoint, ids)
	if e != nil {
		return nil, e
	}
	return curationView(r, version, tags), nil
}
func curationApplies(r Object, version any) bool {
	return r != nil && version != nil && int64Number(version) == num(r, "source_version")
}
func curationView(r Object, version any, tags []Object) Object {
	out := Object{"revision": 0, "sourceVersion": nil, "appliesToCurrent": false, "topic": nil, "pinned": false, "featured": false, "tagIds": []any{}, "tags": []Object{}, "publicPlacement": "not-connected"}
	if r == nil {
		return out
	}
	out["revision"], out["sourceVersion"] = r["revision"], r["source_version"]
	if !curationApplies(r, version) {
		return out
	}
	out["appliesToCurrent"], out["topic"], out["pinned"], out["featured"] = true, r["topic"], truth(r, "pinned"), truth(r, "featured")
	used := []any{}
	for _, tag := range tags {
		used = append(used, tag["id"])
	}
	out["tags"], out["tagIds"] = tags, used
	return out
}

func int64Number(v any) int64 { return num(Object{"n": v}, "n") }
func (s *Service) metadata(ctx context.Context, tx pgx.Tx, p Object) ([]Object, error) {
	a, _ := p["attachments"].([]any)
	if len(a) == 0 {
		return []Object{}, nil
	}
	if s.Attachments == nil {
		return s.attachmentMetadata(ctx, tx, a)
	}
	return s.Attachments.Metadata(ctx, tx, p["attachments"])
}
func (s *Service) readVersion(ctx context.Context, tx pgx.Tx, post, id, account string) (Object, error) {
	r, e := s.version(ctx, tx, post, id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("not_found", 404)
	}
	account, e = s.viewerForRow(ctx, tx, account, r)
	if e != nil {
		return nil, e
	}
	locator := Object{"kind": "post-version", "postId": post, "versionId": id, "versionNumber": r["version_number"]}
	if str(r, "state") == "withdrawn" || str(r, "post_state") == "withdrawn" {
		return s.unavailable(locator, "withdrawn"), nil
	}
	permit, availability, e := s.permission(ctx, tx, r, "forum.post.publish", id)
	if e != nil {
		return nil, e
	}
	if availability != "available" || str(r, "payload_text") == "" || r["erased_at"] != nil || r["event_erased"] != nil {
		if availability == "available" {
			availability = "unavailable"
		}
		return s.unavailable(locator, availability), nil
	}
	hidden, e := s.hidden(ctx, tx, Object{"kind": "post-version", "postId": post, "versionId": id})
	if e != nil {
		return nil, e
	}
	allowed, e := s.audienceAllowed(ctx, tx, account, r)
	if e != nil {
		return nil, e
	}
	if hidden || !allowed {
		return s.unavailable(locator, "unavailable"), nil
	}
	var payload Object
	if json.Unmarshal([]byte(str(r, "payload_text")), &payload) != nil {
		return s.unavailable(locator, "unavailable"), nil
	}
	if r["topic"] != payload["topic"] {
		return s.unavailable(locator, "unavailable"), nil
	}
	var source any
	if str(r, "current_version_id") == id {
		source = r["head_version"]
	}
	curated, e := s.curation(ctx, tx, "post", post, source)
	if e != nil {
		return nil, e
	}
	out, e := s.author(ctx, tx, r)
	if e != nil {
		return nil, e
	}
	attachments, e := s.metadata(ctx, tx, payload)
	if e != nil {
		return nil, e
	}
	participate, e := s.participation(ctx, tx, account, r)
	if e != nil {
		return nil, e
	}
	evidence, e := s.publicEvidence(ctx, tx, permit)
	if e != nil {
		return nil, e
	}
	original := str(payload, "topic")
	if original == "" {
		original = "unclassified"
	}
	selected := str(curated, "topic")
	if selected == "" {
		selected = original
	}
	for k, v := range (Object{"locator": locator, "headVersion": r["head_version"], "currentVersionId": r["current_version_id"], "availability": "available", "payload": payload, "attachments": attachments, "topic": selected, "originalTopic": original, "operatorCuration": curated, "audience": audienceOf(r), "sectionId": r["section_id"], "canParticipate": participate, "createdAt": seconds(r["post_created_at"]), "versionCreatedAt": seconds(r["created_at"]), "updatedAt": seconds(r["post_updated_at"]), "permissionId": r["permission_id"], "publishedUntil": seconds(r["published_until"]), "checkedAt": s.clock(), "authorizationEvidence": evidence}) {
		out[k] = v
	}
	return out, nil
}
func (s *Service) readReply(ctx context.Context, tx pgx.Tx, id, account string) (Object, error) {
	r, e := s.reply(ctx, tx, id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("not_found", 404)
	}
	account, e = s.viewerForRow(ctx, tx, account, r)
	if e != nil {
		return nil, e
	}
	locator := Object{"kind": "reply", "replyId": id, "contentRevision": 1, "postId": r["post_id"], "postVersionId": r["post_version_id"]}
	if str(r, "state") == "withdrawn" {
		return s.unavailable(locator, "withdrawn"), nil
	}
	permit, state, e := s.permission(ctx, tx, r, "forum.reply.publish", id)
	if e != nil {
		return nil, e
	}
	if state != "available" || str(r, "payload_text") == "" || r["erased_at"] != nil || r["event_erased"] != nil {
		if state == "available" {
			state = "unavailable"
		}
		return s.unavailable(locator, state), nil
	}
	hidden, e := s.hidden(ctx, tx, locator)
	if e != nil {
		return nil, e
	}
	parentHidden, e := s.hidden(ctx, tx, Object{"kind": "post-version", "postId": r["post_id"], "versionId": r["post_version_id"]})
	if e != nil {
		return nil, e
	}
	allowed, e := s.audienceAllowed(ctx, tx, account, r)
	if e != nil {
		return nil, e
	}
	if hidden || parentHidden || !allowed {
		return s.unavailable(locator, "unavailable"), nil
	}
	parent, e := s.readVersion(ctx, tx, str(r, "post_id"), str(r, "post_version_id"), account)
	if e != nil && faultCode(e) != "not_found" {
		return nil, e
	}
	parentState := "unavailable"
	if parent != nil {
		parentState = str(parent, "availability")
	}
	var payload Object
	if json.Unmarshal([]byte(str(r, "payload_text")), &payload) != nil {
		return s.unavailable(locator, "unavailable"), nil
	}
	curated, e := s.curation(ctx, tx, "reply", id, r["revision"])
	if e != nil {
		return nil, e
	}
	out, e := s.author(ctx, tx, r)
	if e != nil {
		return nil, e
	}
	attachments, e := s.metadata(ctx, tx, payload)
	if e != nil {
		return nil, e
	}
	evidence, e := s.publicEvidence(ctx, tx, permit)
	if e != nil {
		return nil, e
	}
	selected := str(curated, "topic")
	if selected == "" {
		selected = str(parent, "topic")
	}
	if selected == "" {
		selected = "unclassified"
	}
	for k, v := range (Object{"locator": locator, "revision": r["revision"], "availability": "available", "payload": payload, "attachments": attachments, "permissionId": r["permission_id"], "topic": selected, "operatorCuration": curated, "audience": audienceOf(r), "audienceInherited": truth(r, "audience_inherited"), "sectionId": r["section_id"], "publishedUntil": seconds(r["published_until"]), "createdAt": seconds(r["created_at"]), "checkedAt": s.clock(), "parentAvailability": parentState, "authorizationEvidence": evidence}) {
		out[k] = v
	}
	return out, nil
}
func (s *Service) versions(ctx context.Context, tx pgx.Tx, post, account string, after, limit int64) (Object, error) {
	h, e := s.head(ctx, tx, post, false)
	if e != nil {
		return nil, e
	}
	if h == nil {
		return nil, fail("not_found", 404)
	}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(v) FROM (SELECT id,version_number FROM forum_versions_v1 WHERE post_id=$1 AND version_number>$2 ORDER BY version_number LIMIT $3)v", post, after, limit+1)
	if e != nil {
		return nil, e
	}
	items := []Object{}
	var next any
	for i, r := range rr {
		if int64(i) >= limit {
			next = obj(items[len(items)-1], "locator")["versionNumber"]
			break
		}
		view, e := s.readVersion(ctx, tx, post, str(r, "id"), account)
		if e != nil {
			return nil, e
		}
		item := Object{"locator": view["locator"], "availability": view["availability"], "checkedAt": view["checkedAt"]}
		if str(view, "availability") == "available" {
			item["permissionId"] = view["permissionId"]
			item["publishedUntil"] = view["publishedUntil"]
		}
		items = append(items, item)
	}
	return Object{"postId": post, "items": items, "nextAfterVersion": next, "checkedAt": s.clock()}, nil
}
func (s *Service) readPost(ctx context.Context, tx pgx.Tx, id, account string) (Object, error) {
	h, e := s.head(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	if h == nil {
		return nil, fail("not_found", 404)
	}
	if str(h, "current_version_id") == "" {
		state := "unavailable"
		if str(h, "state") == "withdrawn" {
			state = "withdrawn"
		}
		return s.unavailable(Object{"kind": "post", "postId": id}, state), nil
	}
	view, e := s.readVersion(ctx, tx, id, str(h, "current_version_id"), account)
	if e != nil {
		return nil, e
	}
	if str(view, "availability") != "available" {
		return s.unavailable(Object{"kind": "post", "postId": id}, str(view, "availability")), nil
	}
	versions, e := s.versions(ctx, tx, id, account, 0, 20)
	if e != nil {
		return nil, e
	}
	view["locator"] = Object{"kind": "post", "postId": id}
	view["versionLocators"] = versions["items"]
	view["nextAfterVersion"] = versions["nextAfterVersion"]
	return view, nil
}
func (s *Service) GetPost(ctx context.Context, account, id string) (Object, error) {
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) { return s.readPost(ctx, tx, id, account) })
}
func (s *Service) GetVersion(ctx context.Context, account, post, id string) (Object, error) {
	if !validID(post) || !validID(id) {
		return nil, fail("not_found", 404)
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) { return s.readVersion(ctx, tx, post, id, account) })
}
func (s *Service) GetReply(ctx context.Context, account, id string) (Object, error) {
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) { return s.readReply(ctx, tx, id, account) })
}
