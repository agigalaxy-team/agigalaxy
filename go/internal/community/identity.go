package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"sort"
	"strings"
	"time"
)

type identityActor struct {
	actor                       deviceauth.Actor
	scope, signedIntent, action string
	capture                     *deviceauth.ConsentCapture
}

// ForIdentity creates a request-scoped adapter. The supplied actor is rechecked
// by DeviceAuth in every actual business transaction, including receipt reads.
func (s *Service) ForIdentity(actor deviceauth.Actor, scope, signedIntent string) *Service {
	copy := *s
	copy.actor = &identityActor{actor: actor, scope: scope, signedIntent: signedIntent}
	return &copy
}
func (s *Service) subject() any {
	if s.actor != nil {
		return s.actor.actor.SubjectID
	}
	return nil
}
func (s *Service) actorKind() string {
	if s.actor != nil {
		return "identity"
	}
	return "official-account"
}
func (s *Service) consentID() any {
	if s.actor != nil && s.actor.capture != nil {
		return s.actor.capture.ConsentID
	}
	return nil
}
func (s *Service) owns(r Object, account string) bool {
	if r == nil {
		return false
	}
	if s.actor == nil {
		return account != "" && str(r, "account_id") == account
	}
	if r["account_id"] == nil {
		return str(r, "subject_id") == s.actor.actor.SubjectID
	}
	if account != "" {
		return str(r, "account_id") == account
	}
	return str(r, "subject_id") == s.actor.actor.SubjectID
}
func (s *Service) viewerForRow(ctx context.Context, tx pgx.Tx, account string, r Object) (string, error) {
	if s.actor == nil || account != "" {
		return account, nil
	}
	target := str(r, "account_id")
	if target == "" {
		target = str(r, "maintainer_account_id")
	}
	available, e := s.availableIdentityAccounts(ctx, tx)
	if e != nil {
		return "", e
	}
	for _, a := range available {
		if target != "" && str(a, "id") == target {
			return target, nil
		}
	}
	if len(available) == 1 {
		return str(available[0], "id"), nil
	}
	return "", nil
}
func (s *Service) availableIdentityAccounts(ctx context.Context, tx pgx.Tx) ([]Object, error) {
	if s.actor == nil {
		return nil, fail("access_denied", 401)
	}
	if s.AccountLinks == nil {
		return nil, fail("account_authority_unavailable", 503)
	}
	scope := s.actor.scope
	if scope == "" {
		scope = "assistance"
	}
	return s.AccountLinks.ForScope(scope).AvailableWithin(ctx, tx, s.actor.actor)
}
func (s *Service) resolveIdentityAccount(ctx context.Context, tx pgx.Tx, account string, lock bool) (Object, error) {
	if s.actor == nil {
		return nil, fail("access_denied", 401)
	}
	if s.AccountLinks == nil {
		return nil, fail("account_authority_unavailable", 503)
	}
	scope := s.actor.scope
	if scope == "" {
		scope = "assistance"
	}
	return s.AccountLinks.ForScope(scope).ResolveWithin(ctx, tx, s.actor.actor, account, lock)
}
func (s *Service) selectIdentityWrite(ctx context.Context, tx pgx.Tx, account, kind string, p Object) (string, error) {
	if s.actor == nil {
		return account, nil
	}
	var owner Object
	var e error
	control := strings.HasPrefix(kind, "withdraw-")
	switch kind {
	case "publish-version", "withdraw-post", "withdraw-version":
		owner, e = s.head(ctx, tx, str(p, "postId"), false)
	case "withdraw-reply":
		owner, e = s.reply(ctx, tx, str(p, "replyId"))
	}
	if e != nil {
		return "", e
	}
	if owner != nil {
		if owner["account_id"] == nil && str(owner, "subject_id") != "" {
			if !control || str(owner, "subject_id") != s.actor.actor.SubjectID {
				return "", fail("not_found", 404)
			}
			if p["accountId"] != nil {
				return "", fail("forum_account_target_mismatch", 409)
			}
			return "", nil
		}
		target := str(owner, "account_id")
		if account != "" && target != account {
			return "", fail("not_found", 404)
		}
		account = target
	}
	resolved, e := s.resolveIdentityAccount(ctx, tx, account, true)
	if e != nil {
		return "", e
	}
	return str(resolved, "id"), nil
}
func (s *Service) captureIdentity(ctx context.Context, tx pgx.Tx, account, raw, action, objectID, event string, until int64, visibility string, allowed, required, allowedAccounts, requiredAccounts []string) (string, int64, error) {
	if s.DeviceAuth == nil || s.actor == nil {
		return "", 0, fail("forum_signature_evidence_required", 403)
	}
	cap, e := s.DeviceAuth.CaptureConsentWithin(ctx, tx, s.actor.actor, s.actor.signedIntent, deviceauth.ConsentOptions{Forum: true, HTTPRequestID: optionalString(s.RequestID)})
	if e != nil {
		return "", 0, e
	}
	grant, e := s.DeviceAuth.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: cap.ConsentID, SubjectID: s.actor.actor.SubjectID, Action: action, ObjectID: objectID, Recipient: s.Endpoint, PayloadJSON: raw})
	if e != nil {
		return "", 0, e
	}
	if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending || grant.Visibility != visibility || visibility == "Public" && grant.Purpose != "public-profile" || visibility == "Private" && grant.Purpose != "operational" {
		return "", 0, fail("forum_permission_mismatch", 403)
	}
	var payload Object
	if decodeObject(raw, &payload) != nil {
		return "", 0, fail("invalid_forum_payload", 400)
	}
	fields := []string{}
	for k := range payload {
		fields = append(fields, k)
	}
	other := append([]string{}, grant.Fields...)
	sort.Strings(fields)
	sort.Strings(other)
	if strings.Join(fields, ",") != strings.Join(other, ",") || visibility == "Public" && len(grant.Viewers) > 0 {
		return "", 0, fail("forum_permission_mismatch", 403)
	}
	for _, id := range grant.Viewers {
		if allowed != nil && id != s.actor.actor.SubjectID && !hasString(allowed, id) {
			return "", 0, fail("forum_private_audience_mismatch", 403)
		}
	}
	for _, id := range required {
		if id != s.actor.actor.SubjectID && !hasString(grant.Viewers, id) {
			return "", 0, fail("forum_decision_notice_required", 403)
		}
	}
	accountViewers := []string{}
	if visibility == "Private" {
		values, _ := payload["accountViewers"].([]any)
		for _, v := range values {
			if id := asString(v); !hasString(accountViewers, id) {
				accountViewers = append(accountViewers, id)
			}
		}
		if str(payload, "accountId") == account && account != "" && !hasString(accountViewers, account) {
			accountViewers = append(accountViewers, account)
		}
	}
	for _, id := range accountViewers {
		if allowedAccounts != nil && id != account && !hasString(allowedAccounts, id) {
			return "", 0, fail("forum_private_audience_mismatch", 403)
		}
	}
	for _, id := range requiredAccounts {
		if id != account && !hasString(accountViewers, id) {
			return "", 0, fail("forum_decision_notice_required", 403)
		}
	}
	if until == 0 {
		until = grant.ExpiresAt
	}
	if until <= s.clock() || until > grant.ExpiresAt || until > s.clock()+num(s.policy(), "maxPermissionSeconds") {
		return "", 0, fail("forum_permission_expiry", 403)
	}
	s.actor.capture = &cap
	return s.insertIdentityPermission(ctx, tx, account, raw, action, objectID, event, until, visibility, accountViewers, grant)
}
func optionalString(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}
func hasString(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func decodeObject(raw string, o *Object) error { return protocol.Decode([]byte(raw), o) }
func (s *Service) actorKey(account string) string {
	if s.actor != nil {
		return s.actor.actor.SubjectID
	}
	return account
}
func (s *Service) identityProviders() []IdentityProvider {
	if s.AccountLinks == nil {
		return s.IdentityProviders
	}
	providers := s.AccountLinks.Providers
	if s.AccountLinks.CurrentProviders != nil {
		providers = s.AccountLinks.CurrentProviders()
	}
	out := []IdentityProvider{}
	for _, p := range providers {
		out = append(out, IdentityProvider{Issuer: p.Issuer, ClientID: p.ClientID})
	}
	return out
}
func (s *Service) authorizeIdentityAction(ctx context.Context, tx pgx.Tx, raw, action, objectID string) error {
	if s.actor == nil {
		return nil
	}
	cap, e := s.DeviceAuth.CaptureConsentWithin(ctx, tx, s.actor.actor, s.actor.signedIntent, deviceauth.ConsentOptions{Forum: true, HTTPRequestID: optionalString(s.RequestID)})
	if e != nil {
		return e
	}
	if _, e = s.DeviceAuth.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: cap.ConsentID, SubjectID: s.actor.actor.SubjectID, Action: action, ObjectID: objectID, Recipient: s.Endpoint, PayloadJSON: raw}); e != nil {
		return e
	}
	s.actor.capture = &cap
	return nil
}
func (s *Service) insertIdentityPermission(ctx context.Context, tx pgx.Tx, account, raw, action, objectID, event string, until int64, visibility string, accountViewers []string, grant deviceauth.ConsentIntent) (string, int64, error) {
	r, e := row(ctx, tx, `SELECT to_jsonb(c)||jsonb_build_object('device_id',b.device_id,'key_id',b.key_id,'signer_public_key',coalesce(d.public_key,s.public_key)) FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN subjects s ON s.id=c.subject_id LEFT JOIN device_authorizations d ON d.subject_id=c.subject_id AND d.device_id=b.device_id WHERE c.id=$1 AND c.subject_id=$2`, s.consentID(), s.subject())
	if e != nil {
		return "", 0, e
	}
	if r == nil || str(r, "signature_envelope") == "" || str(r, "signed_payload_text") == "" || str(r, "signer_public_key") == "" || identity.Digest([]byte(str(r, "signature_envelope"))) != str(r, "signature_hash") {
		return "", 0, fail("forum_signature_evidence_required", 403)
	}
	id := uuid.NewString()
	key := r["signer_key_id"]
	if key == nil {
		key = r["key_id"]
	}
	auditUntil := until
	if grant.ExpiresAt > auditUntil {
		auditUntil = grant.ExpiresAt
	}
	_, e = tx.Exec(ctx, `INSERT INTO forum_permissions_v1(id,subject_id,account_id,event_id,consent_id,origin_binding_id,source_device_id,source_key_id,accepted_epoch,accepted_control_hash,signer_public_key,signature_hash,payload_hash,action,object_id,visibility,fields,viewers,issued_at,published_until,accepted_at,authorization_audit_until,policy_hash,account_viewers) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`, id, s.subject(), null(account), event, s.consentID(), r["binding_id"], r["device_id"], key, num(r, "control_epoch"), r["control_event_hash"], r["signer_public_key"], r["signature_hash"], identity.Digest([]byte(raw)), action, objectID, visibility, encode(grant.Fields), encode(grant.Viewers), time.Unix(grant.IssuedAt, 0), time.Unix(until, 0), s.now(), time.Unix(auditUntil+num(s.policy(), "auditDays")*86400, 0), s.policyHash(), encode(accountViewers))
	return id, until, e
}
func (s *Service) auditIdentity(ctx context.Context, tx pgx.Tx, operation, consent, action string) error {
	if s.actor == nil {
		return nil
	}
	if s.actor.capture == nil {
		return fail("forum_signature_evidence_required", 403)
	}
	scope := "assistance"
	if action == "forum.governance.resolve" || action == "forum.section.classify" {
		scope = "moderation"
	}
	a := s.actor.capture.Authorization
	result, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,$4,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,$5,c.id,b.id,$6,$2::text,b.scopes,$7::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$8::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=$3 AND c.subject_id=$1`, s.subject(), operation, consent, action, scope, null(s.RequestID), encode(a.CredentialScopes), a.CallerBindingID)
	if e != nil {
		return e
	}
	if result.RowsAffected() != 1 {
		return fail("forum_signature_evidence_required", 403)
	}
	return nil
}
