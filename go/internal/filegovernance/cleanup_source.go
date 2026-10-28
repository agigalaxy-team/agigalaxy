package filegovernance

import (
	"context"
	"github.com/jackc/pgx/v5"
	"sort"
)

var invalidUploads = []string{"attachment_too_large", "attachment_digest_mismatch", "attachment_file_format_invalid", "attachment_media_type_mismatch", "attachment_media_type_unrecognized"}

func CleanupSourceWithin(ctx context.Context, tx pgx.Tx, kind string, r Object, now int64, lock bool) (Object, error) {
	if _, e := table(kind); e != nil {
		return nil, e
	}
	suffix := ""
	if lock {
		suffix = " FOR SHARE NOWAIT"
	}
	if kind == "chat" {
		var m Object
		var e error
		if r["message_id"] != nil {
			m, e = row(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT message_id,state,revision,expires_at FROM chat_message_refs WHERE message_id=$1"+suffix+")q", r["message_id"])
			if e != nil {
				return nil, e
			}
		}
		refs := []Object{}
		active := 0
		if m != nil {
			refs = append(refs, Object{"id": m["message_id"], "state": m["state"], "revision": m["revision"], "until": iso(m["expires_at"])})
			if str(m, "state") == "accepted" && !due(m["expires_at"], now) {
				active = 1
			}
		}
		return Object{"kind": kind, "references": refs, "truncated": false, "linked": r["message_id"] != nil, "activeReferences": active, "explicitWithdrawal": str(m, "state") == "retracted"}, nil
	}
	links, e := rows(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT source_key,post_id,version_id,reply_id,published_until FROM forum_attachment_links_v1 WHERE attachment_id=$1 ORDER BY source_key LIMIT 201"+suffix+")q", r["id"])
	if e != nil {
		return nil, e
	}
	if len(links) > 200 {
		return Object{"kind": kind, "references": []Object{}, "truncated": true, "linked": true, "activeReferences": nil, "explicitWithdrawal": false}, nil
	}
	selectStates := func(name, key string) (map[string]string, error) {
		ids := []string{}
		for _, link := range links {
			value := str(link, key)
			if value != "" && !has(ids, value) {
				ids = append(ids, value)
			}
		}
		sort.Strings(ids)
		states := map[string]string{}
		if len(ids) == 0 {
			return states, nil
		}
		rr, e := rows(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT id,state FROM "+name+" WHERE id=ANY($1::uuid[]) ORDER BY id"+suffix+")q", ids)
		if e != nil {
			return nil, e
		}
		for _, r := range rr {
			states[str(r, "id")] = str(r, "state")
		}
		return states, nil
	}
	posts, e := selectStates("forum_posts_v1", "post_id")
	if e != nil {
		return nil, e
	}
	versions, e := selectStates("forum_versions_v1", "version_id")
	if e != nil {
		return nil, e
	}
	replies, e := selectStates("forum_replies_v1", "reply_id")
	if e != nil {
		return nil, e
	}
	refs := []Object{}
	active := 0
	withdrawn := len(links) > 0
	stateValue := func(value string) any {
		if value == "" {
			return nil
		}
		return value
	}
	for _, link := range links {
		post, version, reply := posts[str(link, "post_id")], versions[str(link, "version_id")], replies[str(link, "reply_id")]
		refs = append(refs, Object{"id": link["source_key"], "postId": link["post_id"], "versionId": link["version_id"], "replyId": link["reply_id"], "postState": stateValue(post), "versionState": stateValue(version), "replyState": stateValue(reply), "until": iso(link["published_until"])})
		if post == "published" && version == "published" && (link["reply_id"] == nil || reply == "published") && !due(link["published_until"], now) {
			active++
		}
		if link["reply_id"] != nil {
			withdrawn = withdrawn && reply == "withdrawn"
		} else {
			withdrawn = withdrawn && (post == "withdrawn" || version == "withdrawn")
		}
	}
	return Object{"kind": kind, "references": refs, "truncated": false, "linked": r["published_at"] != nil || len(links) > 0, "activeReferences": active, "explicitWithdrawal": withdrawn}, nil
}
func CleanupEligibility(r, source Object, now int64) Object {
	if r["purged_at"] != nil || str(r, "state") == "erased" {
		return Object{"category": "removed", "reason": "already-removed", "eligible": false, "blockedReason": nil}
	}
	expired, active := due(expiry(r), now), truth(RetryState(r, now), "activeLease")
	category := "none"
	var reason any
	if r["revoked_at"] != nil {
		category, reason = "automatic", "owner-revoked"
	} else if str(obj(r, "scan_result"), "state") == "blocked" || has(invalidUploads, str(r, "last_error")) {
		category, reason = "automatic", "security-rejected"
	} else if truth(source, "explicitWithdrawal") {
		category, reason = "automatic", "source-withdrawn"
	} else if !truth(source, "linked") && expired && has([]string{"prepared", "uploading", "scan-pending", "scanning"}, str(r, "state")) && str(obj(r, "scan_result"), "state") != "clean" {
		category, reason = "automatic", "unfinished-upload"
	} else if expired && !(str(source, "kind") == "forum" && num(source, "activeReferences") > 0) {
		category, reason = "operational", "expired"
	} else if str(source, "kind") == "forum" && truth(source, "linked") && source["activeReferences"] != nil && num(source, "activeReferences") == 0 {
		category, reason = "operational", "unreferenced"
	}
	var blocked any
	if active {
		blocked = "processing-active"
	} else if category == "operational" && truth(source, "truncated") {
		blocked = "reference-check-incomplete"
	}
	return Object{"category": category, "reason": reason, "eligible": category == "operational" && blocked == nil, "blockedReason": blocked}
}
