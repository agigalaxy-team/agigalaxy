package community

import (
	"context"
	"github.com/jackc/pgx/v5"
	"reflect"
)

func (s *Service) independent(ctx context.Context, tx pgx.Tx, subject string, r Object) (bool, error) {
	allowed, parties := s.independentBase(subject, r)
	if !allowed {
		return false, nil
	}
	var shared bool
	e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_account_links a JOIN community_account_links b ON b.account_id=a.account_id WHERE a.subject_id=$1 AND b.subject_id=ANY($2::text[]))`, subject, parties).Scan(&shared)
	if e != nil || shared {
		return false, e
	}
	if truth(r, "account_governance") {
		accounts := []string{}
		for _, key := range []string{"reporter_account_id", "target_author_account_id"} {
			if id := str(r, key); id != "" {
				accounts = append(accounts, id)
			}
		}
		rr, e := rows(ctx, tx, `SELECT jsonb_build_object('issuer',l.issuer,'client_id',l.client_id) FROM community_account_links g JOIN external_identity_links l ON l.id=g.identity_link_id WHERE g.subject_id=$1 AND g.account_id=ANY($2::uuid[]) AND l.revoked_at IS NULL`, subject, accounts)
		if e != nil {
			return false, e
		}
		for _, link := range rr {
			for _, provider := range s.identityProviders() {
				if str(link, "issuer") == provider.Issuer && str(link, "client_id") == provider.ClientID {
					return false, nil
				}
			}
		}
	}
	return true, nil
}
func (s *Service) independentBase(subject string, r Object) (bool, []string) {
	configured := false
	for _, id := range s.ModeratorIDs {
		configured = configured || id == subject
	}
	if subject == "" || !configured {
		return false, nil
	}
	parties := []string{}
	for _, key := range []string{"reporter_id", "target_author_id"} {
		if id := str(r, key); id != "" {
			if id == subject {
				return false, nil
			}
			parties = append(parties, id)
		}
	}
	return true, parties
}
func (s *Service) decisionPermission(ctx context.Context, tx pgx.Tx, r Object) (bool, error) {
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1"+s.readShare(" FOR SHARE"), r["permission_id"])
	if e != nil || p == nil {
		return false, e
	}
	if !s.decisionPermissionBase(p, r) {
		return false, nil
	}
	c, e := row(ctx, tx, `SELECT to_jsonb(c)||jsonb_build_object('binding_revoked',b.revoked_at,'revocation_kind',b.revocation_kind,'revocation_event_kind',e.kind,'revocation_event_subject',e.subject_id) FROM consents c JOIN bindings b ON b.id=$2 LEFT JOIN subject_control_events e ON e.id=b.revocation_control_event_id WHERE c.id=$1`+s.readShare(" FOR SHARE OF c,b"), p["consent_id"], p["origin_binding_id"])
	if e != nil || c == nil {
		return false, e
	}
	if !decisionConsentValid(p, c, s.Endpoint, s.clock()) {
		return false, nil
	}
	var deletion bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))", p["subject_id"]).Scan(&deletion)
	return !deletion, e
}
func (s *Service) decisionPermissionBase(p, r Object) bool {
	if p["subject_id"] == nil || p["erased_at"] != nil || p["revoked_at"] != nil || seconds(p["published_until"]) <= s.clock() || str(p, "visibility") != "Private" || str(p, "payload_hash") != str(r, "payload_hash") || str(p, "action") != "forum.governance.resolve" || str(p, "object_id") != str(r, "restriction_event_id") {
		return false
	}
	if str(r, "subject_id") != str(p, "subject_id") {
		viewers, _ := p["viewers"].([]any)
		visible := false
		for _, viewer := range viewers {
			visible = visible || viewer == r["subject_id"]
		}
		if !visible {
			return false
		}
	}
	return true
}
func decisionConsentValid(p, c Object, endpoint string, clock int64) bool {
	intent := obj(c, "intent")
	if c["revoked_at"] != nil || str(c, "signature_hash") != str(p, "signature_hash") || str(intent, "subjectId") != str(p, "subject_id") || str(intent, "bindingId") != str(p, "origin_binding_id") || str(intent, "endpoint") != endpoint || str(intent, "recipient") != endpoint || str(intent, "action") != str(p, "action") || str(intent, "objectId") != str(p, "object_id") || str(intent, "payloadHash") != str(p, "payload_hash") || str(intent, "visibility") != "Private" || !reflect.DeepEqual(intent["fields"], p["fields"]) || !reflect.DeepEqual(intent["viewers"], p["viewers"]) || num(intent, "expiresAt") <= clock || seconds(p["published_until"]) > num(intent, "expiresAt") {
		return false
	}
	if c["binding_revoked"] != nil && (str(c, "revocation_kind") != "recovery" || str(c, "revocation_event_kind") != "recover" || str(c, "revocation_event_subject") != str(p, "subject_id")) {
		return false
	}
	return true
}
func (s *Service) governanceHidden(ctx context.Context, tx pgx.Tx, target Object) (bool, error) {
	var direct bool
	e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM forum_reports_v1 r JOIN forum_operations_events_v1 e ON e.id=r.restriction_event_id WHERE r.target=$1::jsonb AND r.restriction_until>$2 AND e.effect_until>$2)`, encode(target), s.now()).Scan(&direct)
	if e != nil || direct {
		return direct, e
	}
	rr, e := rows(ctx, tx, `SELECT to_jsonb(r)||jsonb_build_object('subject_id',e.subject_id,'permission_id',e.permission_id,'payload_hash',e.payload_hash,'effect_until',e.effect_until) FROM forum_reports_v1 r JOIN forum_governance_events_v1 e ON e.id=r.restriction_event_id WHERE r.target=$1::jsonb AND r.restriction_until>$2`, encode(target), s.now())
	if e != nil {
		return false, e
	}
	for _, r := range rr {
		independent, e := s.independent(ctx, tx, str(r, "subject_id"), r)
		if e != nil {
			return false, e
		}
		if !independent {
			continue
		}
		allowed, e := s.decisionPermission(ctx, tx, r)
		if e != nil {
			return false, e
		}
		if allowed && r["effect_until"] != nil && seconds(r["effect_until"]) > s.clock() {
			return true, nil
		}
	}
	return false, nil
}
