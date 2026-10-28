package community

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

// TaskMaterialSourceWithin is the original task source-status consumer, not a
// public projection. The task service supplies its verified actor/consent and
// owns source selection/reuse; this method never grants republication consent.
func (s *Service) TaskMaterialSourceWithin(ctx context.Context, tx pgx.Tx, source Object, ownerID string, lock bool) (Object, error) {
	no := func(reason string) Object {
		return Object{"available": false, "permanent": true, "reasons": []string{reason}}
	}
	if endpoint := str(source, "endpoint"); endpoint != "" && endpoint != s.Endpoint {
		return no("source-endpoint-mismatch"), nil
	}
	r, e := s.version(ctx, tx, str(source, "postId"), str(source, "versionId"))
	if e != nil {
		return nil, e
	}
	if r == nil {
		return no("source-not-found"), nil
	}
	if ownerID != "" && str(r, "subject_id") != ownerID {
		return no("source-owner-mismatch"), nil
	}
	if str(r, "state") == "withdrawn" || str(r, "post_state") == "withdrawn" {
		return no("source-withdrawn"), nil
	}
	if str(source, "permissionId") != "" && source["permissionId"] != r["permission_id"] || str(source, "payloadHash") != "" && source["payloadHash"] != r["payload_hash"] {
		return no("source-commitment-mismatch"), nil
	}
	locking := ""
	if lock {
		locking = " FOR SHARE"
	}
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1"+locking, r["permission_id"])
	if e != nil {
		return nil, e
	}
	reasons := []string{"permission-unavailable"}
	var evidence Object
	if p != nil {
		current := *s
		current.actor = nil
		current.Authority = nil
		state, e := current.permissionDetailWithin(ctx, tx, p, "", true, lock, &permissionSelector{Visibility: "Public", PayloadHash: str(r, "payload_hash"), Action: "forum.post.publish", ObjectID: str(source, "versionId")})
		if e != nil {
			return nil, e
		}
		reasons = state.Detail["stoppedReasons"].([]string)
		evidence = state.Evidence
	}
	if len(reasons) > 0 {
		permanent := false
		for _, reason := range reasons {
			if hasString([]string{"content-erased", "content-expired", "permission-revoked", "consent-revoked", "permission-evidence-mismatch", "audience-mismatch", "binding-explicitly-revoked", "source-device-revoked"}, reason) {
				permanent = true
			}
		}
		if hasString(reasons, "deletion-pending") {
			var approved bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('approved','partial','primary-erased'))", r["subject_id"]).Scan(&approved); e != nil {
				return nil, e
			}
			permanent = permanent || approved
		}
		return Object{"available": false, "permanent": permanent, "reasons": reasons, "row": r}, nil
	}
	text := str(r, "payload_text")
	if text == "" || r["erased_at"] != nil || r["event_erased"] != nil || identity.Digest([]byte(text)) != str(r, "payload_hash") {
		return Object{"available": false, "permanent": true, "reasons": []string{"source-content-erased-or-invalid"}, "row": r}, nil
	}
	hidden, e := s.hidden(ctx, tx, Object{"kind": "post-version", "postId": source["postId"], "versionId": source["versionId"]})
	if e != nil {
		return nil, e
	}
	if hidden {
		return Object{"available": false, "permanent": false, "reasons": []string{"source-governance-hidden"}, "row": r}, nil
	}
	var payload Object
	if e = json.Unmarshal([]byte(text), &payload); e != nil {
		return nil, e
	}
	until := seconds(r["published_until"])
	permissionUntil := seconds(p["published_until"])
	if evidence != nil {
		permissionUntil = num(obj(evidence, "intent"), "expiresAt")
	}
	if permissionUntil < until {
		until = permissionUntil
	}
	return Object{"available": true, "permanent": false, "row": r, "payload": payload, "availableUntil": until}, nil
}

// ReadBookmarkWithin reuses the exact current forum head projection inside the
// caller's business transaction. A locator supplies no additional read right.
func (s *Service) ReadBookmarkWithin(ctx context.Context, tx pgx.Tx, account string, authorization Authorization, device *deviceauth.Actor, postID string) (Object, error) {
	if s == nil || tx == nil || s.Endpoint == "" {
		return nil, fail("forum_service_unavailable", 503)
	}
	if !validID(postID) {
		return nil, fail("not_found", 404)
	}
	current, e := s.sourceWithin(ctx, tx, account, authorization, device)
	if e != nil {
		return nil, e
	}
	return current.readPost(ctx, tx, postID, account)
}
func (s *Service) sourceWithin(ctx context.Context, tx pgx.Tx, account string, authorization Authorization, device *deviceauth.Actor) (*Service, error) {
	return s.sourceWithinScope(ctx, tx, account, authorization, device, "binding")
}
func (s *Service) sourceWithinScope(ctx context.Context, tx pgx.Tx, account string, authorization Authorization, device *deviceauth.Actor, scope string) (*Service, error) {
	if s == nil || tx == nil || s.Endpoint == "" {
		return nil, fail("forum_service_unavailable", 503)
	}
	current := *s
	current.actor = nil
	current.Authority = authorization
	if device != nil {
		current = *current.ForIdentity(*device, scope, "")
		if current.DeviceAuth == nil {
			return nil, fail("forum_identity_authorization_unavailable", 503)
		}
		if e := current.DeviceAuth.AuthorizeWithin(ctx, tx, *device, scope); e != nil {
			return nil, e
		}
		if account != "" {
			if _, e := current.resolveIdentityAccount(ctx, tx, account, false); e != nil {
				return nil, e
			}
		}
	} else if account != "" {
		if e := current.authorize(ctx, tx, account); e != nil {
			return nil, e
		}
	}
	return &current, nil
}

// The data-export caller has its own original scope. It never acquires a
// binding/read scope merely to transform its existing owner export row.
func (s *Service) ReadLifecycleVersionWithin(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, postID, versionID string) (Object, error) {
	if !validID(postID) || !validID(versionID) {
		return nil, fail("not_found", 404)
	}
	current, e := s.sourceWithinScope(ctx, tx, "", nil, &actor, "data-export")
	if e != nil {
		return nil, e
	}
	return current.readVersion(ctx, tx, postID, versionID, "")
}
func (s *Service) ReadLifecycleReplyWithin(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, replyID string) (Object, error) {
	if !validID(replyID) {
		return nil, fail("not_found", 404)
	}
	current, e := s.sourceWithinScope(ctx, tx, "", nil, &actor, "data-export")
	if e != nil {
		return nil, e
	}
	return current.readReply(ctx, tx, replyID, "")
}

func (s *Service) ReadVersionWithin(ctx context.Context, tx pgx.Tx, account string, authorization Authorization, device *deviceauth.Actor, postID, versionID string) (Object, error) {
	if !validID(postID) || !validID(versionID) {
		return nil, fail("not_found", 404)
	}
	current, e := s.sourceWithin(ctx, tx, account, authorization, device)
	if e != nil {
		return nil, e
	}
	return current.readVersion(ctx, tx, postID, versionID, account)
}
func (s *Service) ReadReplyWithin(ctx context.Context, tx pgx.Tx, account string, authorization Authorization, device *deviceauth.Actor, replyID string) (Object, error) {
	if !validID(replyID) {
		return nil, fail("not_found", 404)
	}
	current, e := s.sourceWithin(ctx, tx, account, authorization, device)
	if e != nil {
		return nil, e
	}
	return current.readReply(ctx, tx, replyID, account)
}
