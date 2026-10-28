package community

import (
	"context"
	"github.com/jackc/pgx/v5"
	"reflect"
)

func (s *Service) PermissionDetail(ctx context.Context, account, id string) (Object, error) {
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1 FOR SHARE", id)
		if e != nil {
			return nil, e
		}
		if p == nil {
			return nil, fail("not_found", 404)
		}
		account, e = s.viewerForRow(ctx, tx, account, p)
		if e != nil {
			return nil, e
		}
		if !s.owns(p, account) {
			return nil, fail("not_found", 404)
		}
		state, e := s.permissionDetailWithin(ctx, tx, p, account, false, true, nil)
		if e != nil {
			return nil, e
		}
		return state.Detail, nil
	})
}

type permissionDetailState struct{ Detail, Evidence Object }
type permissionSelector struct {
	Visibility, PayloadHash, Action, ObjectID string
	SkipAudience                              bool
}

func (s *Service) permissionDetailWithin(ctx context.Context, tx pgx.Tx, p Object, account string, statusAudience, lock bool, selector *permissionSelector) (*permissionDetailState, error) {
	id := str(p, "id")
	var e error
	reasons := []string{}
	kind := str(p, "authorization_kind")
	if kind == "" {
		kind = "id-consent"
	}
	var bindingExpires, revokedAt, revocationKind, revocationEvent, revocationRequest any
	if p["revoked_at"] != nil {
		revokedAt = seconds(p["revoked_at"])
	}
	add := func(reason string) {
		if !hasString(reasons, reason) {
			reasons = append(reasons, reason)
		}
	}
	var evidence Object
	selectorMismatch := selector != nil && (selector.PayloadHash != "" && selector.PayloadHash != str(p, "payload_hash") || selector.Action != "" && selector.Action != str(p, "action") || selector.ObjectID != "" && selector.ObjectID != str(p, "object_id"))
	if kind == "official-account" {
		if p["erased_at"] != nil || p["account_id"] == nil {
			add("content-erased")
		}
		if seconds(p["published_until"]) <= s.clock() {
			add("content-expired")
		}
		if p["revoked_at"] != nil {
			add("permission-revoked")
		}
		if selector != nil && selector.Visibility != "" && selector.Visibility != str(p, "visibility") {
			add("audience-mismatch")
		}
		if selectorMismatch {
			add("permission-evidence-mismatch")
		}
		var valid bool
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_accounts a JOIN (SELECT id,account_id,actor_kind,subject_id,consent_id,payload_hash,erased_at FROM forum_events_v1 UNION ALL SELECT id,account_id,actor_kind,subject_id,consent_id,payload_hash,erased_at FROM forum_governance_events_v1)e ON e.id=$1 AND e.account_id=a.id WHERE a.id=$2 AND a.endpoint=$3 AND e.actor_kind='official-account' AND e.subject_id IS NULL AND e.consent_id IS NULL AND e.payload_hash=$4)`, p["event_id"], p["account_id"], s.Endpoint, p["payload_hash"]).Scan(&valid)
		if e != nil {
			return nil, e
		}
		if !valid {
			add("permission-evidence-mismatch")
		}
		var erased bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM forum_events_v1 WHERE id=$1 AND erased_at IS NOT NULL UNION ALL SELECT 1 FROM forum_governance_events_v1 WHERE id=$1 AND erased_at IS NOT NULL)", p["event_id"]).Scan(&erased)
		if e != nil {
			return nil, e
		}
		if erased {
			add("content-erased")
		}
	} else {
		locking := ""
		if lock {
			locking = " FOR SHARE OF c,b"
		}
		evidence, e = row(ctx, tx, `SELECT to_jsonb(c)||jsonb_build_object('binding_revoked',b.revoked_at,'binding_expires',b.expires_at,'revocation_kind',b.revocation_kind,'revocation_event_id',b.revocation_control_event_id,'revocation_request_id',b.revocation_request_id,'revocation_event_kind',e.kind,'revocation_event_subject',e.subject_id) FROM consents c JOIN bindings b ON b.id=$2 LEFT JOIN subject_control_events e ON e.id=b.revocation_control_event_id WHERE c.id=$1`+locking, p["consent_id"], p["origin_binding_id"])
		if e != nil {
			return nil, e
		}
		if evidence == nil {
			add("permission-unavailable")
		} else {
			intent := obj(evidence, "intent")
			if p["subject_id"] == nil || p["erased_at"] != nil {
				add("content-erased")
			}
			if seconds(p["published_until"]) <= s.clock() || num(intent, "expiresAt") <= s.clock() {
				add("content-expired")
			}
			if p["revoked_at"] != nil {
				add("permission-revoked")
			}
			if evidence["revoked_at"] != nil {
				add("consent-revoked")
			}
			if str(evidence, "signature_hash") != str(p, "signature_hash") || str(intent, "subjectId") != str(p, "subject_id") || str(intent, "bindingId") != str(p, "origin_binding_id") || str(intent, "endpoint") != s.Endpoint || str(intent, "recipient") != s.Endpoint || str(intent, "action") != str(p, "action") || str(intent, "objectId") != str(p, "object_id") || str(intent, "payloadHash") != str(p, "payload_hash") || !reflect.DeepEqual(intent["fields"], p["fields"]) || !reflect.DeepEqual(intent["viewers"], p["viewers"]) || str(intent, "visibility") != str(p, "visibility") || seconds(p["published_until"]) > num(intent, "expiresAt") {
				add("permission-evidence-mismatch")
			}
			if selectorMismatch {
				add("permission-evidence-mismatch")
			}
			if selector != nil && selector.Visibility != "" && selector.Visibility != str(p, "visibility") {
				add("audience-mismatch")
			}
			if str(p, "visibility") == "Public" && str(intent, "purpose") != "public-profile" {
				add("audience-mismatch")
			}
			if evidence["binding_revoked"] != nil {
				switch str(evidence, "revocation_kind") {
				case "explicit-binding":
					add("binding-explicitly-revoked")
				case "device-revoked":
					add("source-device-revoked")
				default:
					if str(evidence, "revocation_kind") != "recovery" || str(evidence, "revocation_event_kind") != "recover" || str(evidence, "revocation_event_subject") != str(p, "subject_id") {
						add("historical-cause-unavailable")
					}
				}
				if revokedAt == nil {
					revokedAt = seconds(evidence["binding_revoked"])
				}
			}
			var pending bool
			e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))", p["subject_id"]).Scan(&pending)
			if e != nil {
				return nil, e
			}
			if pending {
				add("deletion-pending")
			}
			bindingExpires = seconds(evidence["binding_expires"])
			revocationKind = evidence["revocation_kind"]
			revocationEvent = evidence["revocation_event_id"]
			revocationRequest = evidence["revocation_request_id"]
		}
	}
	if len(reasons) == 0 && (selector == nil || !selector.SkipAudience) && (str(p, "action") == "forum.post.publish" || str(p, "action") == "forum.reply.publish") {
		var source Object
		target := Object{}
		if str(p, "action") == "forum.post.publish" {
			source, e = row(ctx, tx, "SELECT to_jsonb(v)-'payload_text' FROM forum_versions_v1 v WHERE publication_event_id=$1", p["event_id"])
			if source != nil {
				target = Object{"kind": "post-version", "postId": source["post_id"], "versionId": source["id"]}
			}
		} else {
			source, e = row(ctx, tx, "SELECT to_jsonb(r)-'payload_text' FROM forum_replies_v1 r WHERE publication_event_id=$1", p["event_id"])
			if source != nil {
				target = Object{"kind": "reply", "replyId": source["id"], "contentRevision": 1, "postId": source["post_id"]}
			}
		}
		if e != nil {
			return nil, e
		}
		if source == nil {
			add("audience-condition-not-met")
		} else {
			hidden := false
			var e error
			if statusAudience {
				kind, id := "forum-post", str(source, "post_id")
				if str(p, "action") == "forum.reply.publish" {
					kind, id = "forum-reply", str(source, "id")
				}
				hidden, e = s.operationsHidden(ctx, tx, kind, id)
				if e == nil && !hidden && kind == "forum-reply" {
					hidden, e = s.operationsHidden(ctx, tx, "forum-post", str(source, "post_id"))
				}
			} else {
				hidden, e = s.hidden(ctx, tx, target)
			}
			if e != nil {
				return nil, e
			}
			allowed, e := s.audienceAllowed(ctx, tx, account, source)
			if e != nil {
				return nil, e
			}
			if str(p, "action") == "forum.reply.publish" {
				parentHidden, e := s.hidden(ctx, tx, Object{"kind": "post-version", "postId": source["post_id"], "versionId": source["post_version_id"]})
				if e != nil {
					return nil, e
				}
				hidden = hidden || parentHidden
			}
			if hidden || !allowed {
				add("audience-condition-not-met")
			}
		}
	}
	return &permissionDetailState{Detail: Object{"permissionId": id, "eventId": p["event_id"], "objectId": p["object_id"], "visibility": p["visibility"], "publishedUntil": seconds(p["published_until"]), "authorizationKind": kind, "accountId": p["account_id"], "originBindingExpiresAt": bindingExpires, "revokedAt": revokedAt, "revocationKind": revocationKind, "revocationEventId": revocationEvent, "revocationRequestId": revocationRequest, "stoppedReasons": reasons, "checkedAt": s.clock(), "authority": "current-forum-permission-only"}, Evidence: evidence}, nil
}
