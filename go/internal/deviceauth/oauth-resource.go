package deviceauth

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/failureaudit"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

// OAuthIdentitySelectionRequired carries only IDs authorized by the verified
// token and the current identity bindings; it is not an authorization grant.
type OAuthIdentitySelectionRequired struct{ SubjectIDs []string }

func (e *OAuthIdentitySelectionRequired) Error() string { return "identity_selection_required" }
func (e *OAuthIdentitySelectionRequired) Unwrap() error {
	return fault.New("identity_selection_required", 409)
}

type OAuthProvider struct{ ID, Issuer, ClientID string }
type OAuthAuthInfo struct {
	Token     string   `json:"-"`
	ClientID  string   `json:"clientId"`
	Scopes    []string `json:"scopes"`
	ExpiresAt int64    `json:"expiresAt"`
	Resource  string   `json:"resource"`
}
type OAuthAuthentication struct {
	Actor    Actor
	AuthInfo OAuthAuthInfo
}
type OAuthResourceAccess struct {
	service       *Service
	verifier      *OAuthIntrospection
	provider      OAuthProvider
	allowedScopes []string
}
type oauthResourceProof struct {
	owner                      *OAuthResourceAccess
	claim                      OAuthClaims
	linkID, subject, bindingID string
	httpRequestID              *string
}

// AllowedScopes reports the configured resource scopes, independently of any
// particular token or binding. Callers cannot mutate the authority's policy.
func (a *OAuthResourceAccess) AllowedScopes() []string {
	if a == nil {
		return nil
	}
	return append([]string{}, a.allowedScopes...)
}

const oauthResourceSelect = `SELECT l.id::text,l.subject_id,l.binding_id::text,b.scopes,b.expires_at,b.audience,b.device_id::text,b.key_id,b.control_epoch FROM external_identity_links l JOIN bindings b ON b.id=l.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE l.endpoint=$1 AND l.provider_id=$2 AND l.issuer=$3 AND l.external_subject=$4 AND l.client_id=$5 AND l.revoked_at IS NULL AND b.revoked_at IS NULL AND b.subject_id=l.subject_id AND b.audience=$1 AND b.expires_at>$6`

func NewOAuthResourceAccess(s *Service, verifier *OAuthIntrospection, provider OAuthProvider, allowedScopes []string) (*OAuthResourceAccess, error) {
	if s == nil || verifier == nil || provider.ID == "" || provider.Issuer == "" || provider.ClientID == "" || len(allowedScopes) == 0 {
		return nil, fault.New("oauth_configuration_invalid", 400)
	}
	if s.oauthResourceAccess != nil {
		return nil, fault.New("oauth_authority_already_configured", 503)
	}
	a := &OAuthResourceAccess{service: s, verifier: verifier, provider: provider, allowedScopes: append([]string{}, allowedScopes...)}
	s.oauthResourceAccess = a
	return a, nil
}
func (a *OAuthResourceAccess) effective(b binding, claim OAuthClaims) []string {
	scopes := []string{}
	for _, scope := range b.Scopes {
		if contains(a.allowedScopes, scope) && contains(claim.Scopes, "galaxy:"+scope) {
			scopes = append(scopes, scope)
		}
	}
	return scopes
}
func (a *OAuthResourceAccess) row(ctx context.Context, tx pgx.Tx, claim OAuthClaims, linkID, bindingID *string, selectedSubject string) (binding, string, error) {
	args := []any{a.service.Endpoint, a.provider.ID, a.provider.Issuer, claim.Subject, a.provider.ClientID, time.Unix(a.service.now(), 0)}
	query := oauthResourceSelect
	if linkID != nil {
		query += " AND l.id=$7 AND b.id=$8 FOR SHARE OF b,l"
		args = append(args, *linkID, *bindingID)
	} else if selectedSubject != "" {
		query += " AND l.subject_id=$7"
		args = append(args, selectedSubject)
	}
	rows, e := tx.Query(ctx, query, args...)
	if e != nil {
		return binding{}, "", e
	}
	type candidate struct {
		b  binding
		id string
	}
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if e = rows.Scan(&c.id, &c.b.Subject, &c.b.ID, &c.b.Scopes, &c.b.Expires, &c.b.Audience, &c.b.DeviceID, &c.b.KeyID, &c.b.Epoch); e != nil {
			rows.Close()
			return binding{}, "", e
		}
		candidates = append(candidates, c)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return binding{}, "", e
	}
	var b binding
	var id string
	var subjects []string
	validControl := false
	for _, c := range candidates {
		controlled, err := applyControl(ctx, tx, c.b)
		if err != nil {
			if fault.Code(err) == "internal_error" {
				return binding{}, "", err
			}
			continue
		}
		validControl = true
		if linkID == nil && !contains(a.effective(controlled, claim), "binding") {
			continue
		}
		subjects = append(subjects, controlled.Subject)
		if id == "" {
			b, id = controlled, c.id
		}
	}
	if len(subjects) > 1 {
		if selectedSubject == "" && linkID == nil {
			return binding{}, "", &OAuthIdentitySelectionRequired{SubjectIDs: subjects}
		}
		return binding{}, "", denied()
	}
	if id == "" {
		if validControl && linkID == nil {
			return binding{}, "", fault.New("insufficient_scope", 403)
		}
		return binding{}, "", denied()
	}
	b.BindingScopes = append([]string{}, b.Scopes...)
	b.Scopes = a.effective(b, claim)
	return b, id, nil
}
func (a *OAuthResourceAccess) Authenticate(ctx context.Context, token string, httpRequestID *string, selectedSubject ...string) (OAuthAuthentication, error) {
	if a == nil || a.service == nil || a.verifier == nil {
		return OAuthAuthentication{}, oauthInvalid()
	}
	claim, e := a.verifier.Verify(ctx, token)
	if e != nil {
		return OAuthAuthentication{}, e
	}
	if claim.Issuer != a.provider.Issuer || claim.Resource != a.verifier.Resource() {
		return OAuthAuthentication{}, oauthInvalid()
	}
	if !contains(claim.Scopes, "galaxy:binding") || !contains(a.allowedScopes, "binding") {
		return OAuthAuthentication{}, fault.New("insufficient_scope", 403)
	}
	if len(selectedSubject) > 1 || len(selectedSubject) == 1 && !guidPattern.MatchString(selectedSubject[0]) {
		return OAuthAuthentication{}, fault.New("invalid_identity_selection", 400)
	}
	selected := ""
	if len(selectedSubject) == 1 {
		selected = selectedSubject[0]
	}
	return postgres.InTx(ctx, a.service.Pool, func(tx pgx.Tx) (OAuthAuthentication, error) {
		b, linkID, e := a.row(ctx, tx, claim, nil, nil, selected)
		if e != nil {
			if fault.Code(e) == "identity_selection_required" {
				return OAuthAuthentication{}, e
			}
			if fault.Code(e) == "access_denied" {
				return OAuthAuthentication{}, fault.New("identity_selection_unavailable", 403)
			}
			return OAuthAuthentication{}, e
		}
		var request *string
		if httpRequestID != nil {
			v := *httpRequestID
			request = &v
		}
		proof := &oauthResourceProof{owner: a, claim: claim, linkID: linkID, subject: b.Subject, bindingID: b.ID, httpRequestID: request}
		key := b.Control.KeyID
		scopes := append([]string{}, b.Scopes...)
		actor := Actor{SubjectID: b.Subject, BindingID: b.ID, Scopes: scopes, DeviceID: b.Control.DeviceID, KeyID: &key, ControlEpoch: b.Control.Epoch, Authentication: Authentication{Version: 2, Profile: "oauth-resource", Endpoint: a.service.Endpoint, ClientID: claim.ClientID, Audience: claim.Resource, Scope: "binding", BindingScopes: append([]string{}, b.BindingScopes...), CredentialScopes: append([]string{}, scopes...)}, oauthResourceAuthority: proof}
		failureaudit.CaptureActor(ctx, failureaudit.Actor{SubjectID: b.Subject, BindingID: b.ID, Authentication: &failureaudit.Authentication{Version: 2, ClientID: claim.ClientID, Audience: claim.Resource, Scope: "binding", BindingScopes: b.BindingScopes, CredentialScopes: scopes}})
		if e = httpboundary.CaptureAuthenticated(ctx, b.Subject, token); e != nil {
			return OAuthAuthentication{}, e
		}
		oauthScopes := []string{}
		for _, scope := range scopes {
			oauthScopes = append(oauthScopes, "galaxy:"+scope)
		}
		return OAuthAuthentication{Actor: actor, AuthInfo: OAuthAuthInfo{Token: token, ClientID: claim.ClientID, Scopes: oauthScopes, ExpiresAt: min(claim.ExpiresAt, b.Expires.Unix()), Resource: claim.Resource}}, nil
	})
}
func (s *Service) oauthAuthorizationWithin(ctx context.Context, tx pgx.Tx, a Actor) (binding, error) {
	proof := a.oauthResourceAuthority
	if proof == nil || proof.owner == nil || proof.owner != s.oauthResourceAccess || proof.owner.service != s || a.SubjectID != proof.subject || a.BindingID != proof.bindingID || proof.claim.ExpiresAt <= s.now() {
		return binding{}, denied()
	}
	if _, e := lockSubject(ctx, tx, a.SubjectID); e != nil {
		return binding{}, e
	}
	b, _, e := proof.owner.row(ctx, tx, proof.claim, &proof.linkID, &proof.bindingID, "")
	if e != nil {
		return binding{}, e
	}
	if b.Subject != a.SubjectID {
		return binding{}, denied()
	}
	return b, nil
}
func (s *Service) recordOAuthAccessWithin(ctx context.Context, tx pgx.Tx, a Actor, row binding, scope string) error {
	proof := a.oauthResourceAuthority
	if proof == nil || proof.owner != s.oauthResourceAccess {
		return denied()
	}
	id := uuid.NewString()
	bindingScopes, _ := json.Marshal(row.BindingScopes)
	credentialScopes, _ := json.Marshal(row.Scopes)
	_, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) VALUES($1,'oauth.access',$2,$3,'accepted',1,$4,$5,$6,$7,$8,$3,$9::jsonb,$10::jsonb,$7,$4,$5,$9::jsonb)`, a.SubjectID, proof.linkID, id, proof.claim.ClientID, proof.claim.Resource, scope, a.BindingID, proof.httpRequestID, bindingScopes, credentialScopes)
	return e
}
