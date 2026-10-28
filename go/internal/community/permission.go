package community

import (
	"context"
	"github.com/jackc/pgx/v5"
	"reflect"
)

func (s *Service) permission(ctx context.Context, tx pgx.Tx, r Object, action, id string) (Object, string, error) {
	return s.permissionFor(ctx, tx, r, action, id, "Public")
}
func (s *Service) permissionFor(ctx context.Context, tx pgx.Tx, r Object, action, id, visibility string) (Object, string, error) {
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1"+s.readShare(" FOR SHARE"), r["permission_id"])
	if e != nil {
		return nil, "", e
	}
	if p == nil {
		return nil, "unavailable", nil
	}
	if seconds(p["published_until"]) <= s.clock() {
		return p, "expired", nil
	}
	if p["subject_id"] == nil && p["account_id"] == nil || p["erased_at"] != nil || p["revoked_at"] != nil || str(p, "visibility") != visibility || str(p, "action") != action || str(p, "object_id") != id || str(p, "payload_hash") != str(r, "payload_hash") {
		return p, "unavailable", nil
	}
	if str(p, "authorization_kind") == "official-account" {
		var valid bool
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_accounts a JOIN (SELECT id,account_id,actor_kind,subject_id,consent_id,payload_hash,erased_at FROM forum_events_v1 UNION ALL SELECT id,account_id,actor_kind,subject_id,consent_id,payload_hash,erased_at FROM forum_governance_events_v1) e ON e.id=$1 AND e.account_id=a.id WHERE a.id=$2 AND a.endpoint=$3 AND e.actor_kind='official-account' AND e.subject_id IS NULL AND e.consent_id IS NULL AND e.payload_hash=$4 AND e.erased_at IS NULL)`, p["event_id"], p["account_id"], s.Endpoint, p["payload_hash"]).Scan(&valid)
		if e != nil {
			return nil, "", e
		}
		if !valid {
			return p, "unavailable", nil
		}
		return p, "available", nil
	}
	evidence, e := row(ctx, tx, `SELECT to_jsonb(c)||jsonb_build_object('binding_revoked',b.revoked_at,'revocation_kind',b.revocation_kind,'revocation_event_kind',e.kind,'revocation_event_subject',e.subject_id,'binding_id',b.id) FROM consents c JOIN bindings b ON b.id=$2 LEFT JOIN subject_control_events e ON e.id=b.revocation_control_event_id WHERE c.id=$1`+s.readShare(" FOR SHARE OF c,b"), p["consent_id"], p["origin_binding_id"])
	if e != nil {
		return nil, "", e
	}
	if evidence == nil {
		return p, "unavailable", nil
	}
	intent := obj(evidence, "intent")
	if num(intent, "expiresAt") <= s.clock() {
		return p, "expired", nil
	}
	if evidence["revoked_at"] != nil || str(evidence, "signature_hash") != str(p, "signature_hash") || str(intent, "subjectId") != str(p, "subject_id") || str(intent, "bindingId") != str(p, "origin_binding_id") || str(intent, "endpoint") != s.Endpoint || str(intent, "recipient") != s.Endpoint || str(intent, "action") != action || str(intent, "objectId") != id || str(intent, "payloadHash") != str(p, "payload_hash") || !reflect.DeepEqual(intent["fields"], p["fields"]) || !reflect.DeepEqual(intent["viewers"], p["viewers"]) || str(intent, "visibility") != visibility || visibility == "Public" && str(intent, "purpose") != "public-profile" || seconds(p["published_until"]) > num(intent, "expiresAt") {
		return p, "unavailable", nil
	}
	if evidence["binding_revoked"] != nil && (str(evidence, "revocation_kind") != "recovery" || str(evidence, "revocation_event_kind") != "recover" || str(evidence, "revocation_event_subject") != str(p, "subject_id")) {
		return p, "unavailable", nil
	}
	var deletion bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))", p["subject_id"]).Scan(&deletion)
	if e != nil {
		return nil, "", e
	}
	if deletion {
		return p, "unavailable", nil
	}
	return p, "available", nil
}
func (s *Service) publicEvidence(ctx context.Context, tx pgx.Tx, p Object) (Object, error) {
	if str(p, "authorization_kind") == "official-account" {
		return Object{"kind": "official-account", "accountId": p["account_id"], "payloadHash": p["payload_hash"], "action": p["action"], "objectId": p["object_id"], "acceptedAt": seconds(p["accepted_at"]), "publishedUntil": seconds(p["published_until"]), "authority": "server-accepted-account-action"}, nil
	}
	r, e := row(ctx, tx, "SELECT jsonb_build_object('intent',c.intent,'signatureEnvelope',c.signature_envelope,'signerPublicKey',p.signer_public_key) FROM consents c JOIN forum_permissions_v1 p ON p.consent_id=c.id WHERE p.id=$1", p["id"])
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("forum_content_unavailable", 403)
	}
	r["kind"] = "identity-consent"
	r["consentId"] = p["consent_id"]
	r["acceptedEpoch"] = p["accepted_epoch"]
	r["acceptedControlHead"] = p["accepted_control_hash"]
	return r, nil
}
