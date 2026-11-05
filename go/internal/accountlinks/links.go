package accountlinks

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/url"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type linkIntent struct {
	Version             int    `json:"version"`
	ID                  string `json:"id"`
	Action              string `json:"action"`
	SubjectID           string `json:"subjectId"`
	BindingID           string `json:"bindingId"`
	Endpoint            string `json:"endpoint"`
	ProviderID          string `json:"providerId"`
	Issuer              string `json:"issuer"`
	ExternalSubject     string `json:"externalSubject"`
	ClientID            string `json:"clientId"`
	Authentication      string `json:"authentication"`
	VerifiedAt          int64  `json:"verifiedAt"`
	IssuedAt            int64  `json:"issuedAt"`
	ExpiresAt           int64  `json:"expiresAt"`
	GalaxyAuthorization bool   `json:"galaxyAuthorization"`
}
type pendingLink struct {
	provider                                    LoginProvider
	subject, binding, state, stateHash, payload string
	expires                                     int64
	preview                                     portal.Preview
	intent                                      linkIntent
	verifiedEmail                               bool
	nativeProof                                 string
	nativeReview                                string
	verified                                    VerifiedIdentity
}
type Links struct {
	Registry      *Service
	NativeIssuer  string
	Budget        resourcebudget.Policy
	mu            sync.Mutex
	pending       map[string]*pendingLink
	providers     map[string]LoginProvider
	providerOrder []string
}

func NewLinks(registry *Service, providers []LoginProvider, budget *resourcebudget.Policy) (*Links, error) {
	if registry == nil || registry.Pool == nil || registry.Devices == nil || registry.Endpoint == "" || len(providers) > 8 {
		return nil, fault.New("identity_configuration_invalid", 400)
	}
	p := resourcebudget.DefaultPolicy()
	if budget != nil {
		p = *budget
	}
	if p.Validate() != nil {
		return nil, fault.New("resource_budget_configuration_invalid", 400)
	}
	l := &Links{Registry: registry.ForScope("binding"), Budget: p, pending: map[string]*pendingLink{}, providers: map[string]LoginProvider{}}
	for _, provider := range providers {
		d := provider.Describe()
		if !providerID.MatchString(d.ID) || d.RedirectURI != registry.Endpoint+"/v1/identity/callback/"+d.ID || l.providers[d.ID] != nil {
			return nil, fault.New("identity_configuration_invalid", 400)
		}
		l.providers[d.ID] = provider
		l.providerOrder = append(l.providerOrder, d.ID)
	}
	return l, nil
}
func loginUnavailable() error { return fault.New("identity_login_unavailable", 409) }
func (l *Links) purge(ctx context.Context) {
	now := l.Registry.now().Unix()
	expired := []*pendingLink{}
	l.mu.Lock()
	for id, p := range l.pending {
		if p.expires <= now {
			expired = append(expired, p)
			delete(l.pending, id)
		}
	}
	l.mu.Unlock()
	for _, p := range expired {
		if p.preview.AuthorizationURL != "" {
			_ = p.provider.Cancel(ctx, p.preview)
		}
	}
}
func (l *Links) owned(actor deviceauth.Actor, id string) (*pendingLink, error) {
	p := l.pending[id]
	if p == nil || p.subject != actor.SubjectID || p.binding != actor.BindingID {
		return nil, loginUnavailable()
	}
	return p, nil
}
func (l *Links) Providers(ctx context.Context, actor deviceauth.Actor) (Object, error) {
	return postgres.InTx(ctx, l.Registry.Pool, func(tx pgx.Tx) (Object, error) {
		if e := l.Registry.authorize(ctx, tx, actor); e != nil {
			return nil, e
		}
		out := []Description{}
		for _, id := range l.providerOrder {
			out = append(out, l.providers[id].Describe())
		}
		return Object{"endpoint": l.Registry.Endpoint, "providers": out, "galaxyAuthorization": false}, nil
	})
}
func (l *Links) Begin(ctx context.Context, actor deviceauth.Actor, raw []byte) (Object, error) {
	var input struct {
		ProviderID string `json:"providerId"`
	}
	if decode(raw, &input) != nil || !providerID.MatchString(input.ProviderID) {
		return nil, fault.New("invalid_request", 400)
	}
	provider := l.providers[input.ProviderID]
	if provider == nil {
		return nil, fault.New("identity_provider_unavailable", 404)
	}
	return postgres.InTx(ctx, l.Registry.Pool, func(tx pgx.Tx) (Object, error) {
		if e := l.Registry.authorize(ctx, tx, actor); e != nil {
			return nil, e
		}
		return l.start(ctx, provider, actor.SubjectID, actor.BindingID, "")
	})
}
func (l *Links) start(ctx context.Context, provider LoginProvider, subject, binding, proof string) (out Object, err error) {
	l.purge(ctx)
	l.mu.Lock()
	count := 0
	for _, p := range l.pending {
		if p.subject == subject && p.nativeProof == "" {
			count++
		}
	}
	if len(l.pending) >= 2048 || (proof == "" && count >= 4) {
		l.mu.Unlock()
		return nil, fault.New("identity_login_limit", 429)
	}
	id := uuid.NewString()
	p := &pendingLink{provider: provider, subject: subject, binding: binding, nativeProof: proof, state: "preparing", expires: l.Registry.now().Unix() + 300}
	l.pending[id] = p
	l.mu.Unlock()
	preview, err := provider.Begin(ctx)
	defer func() {
		if err == nil {
			return
		}
		l.mu.Lock()
		delete(l.pending, id)
		l.mu.Unlock()
		if preview.AuthorizationURL != "" {
			_ = provider.Cancel(context.WithoutCancel(ctx), preview)
		}
	}()
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(preview.AuthorizationURL)
	if err != nil || u.Query().Get("state") == "" {
		return nil, loginUnavailable()
	}
	l.mu.Lock()
	p.preview, p.stateHash, p.expires, p.state = preview, identity.Digest([]byte(u.Query().Get("state"))), preview.ExpiresAt, "awaiting-login"
	l.mu.Unlock()
	b, _ := json.Marshal(preview)
	json.Unmarshal(b, &out)
	out["loginId"], out["subjectId"], out["bindingId"] = id, subject, binding
	out["endpoint"], out["galaxyAuthorization"] = l.Registry.Endpoint, false
	return out, nil
}
func (l *Links) Callback(ctx context.Context, providerID, returned string) (Object, error) {
	l.purge(ctx)
	u, e := url.Parse(returned)
	if e != nil {
		return nil, loginUnavailable()
	}
	states := u.Query()["state"]
	if len(states) != 1 || states[0] == "" || len(states[0]) > 256 {
		return nil, loginUnavailable()
	}
	hash := identity.Digest([]byte(states[0]))
	l.mu.Lock()
	var id string
	var p *pendingLink
	for candidate, v := range l.pending {
		if v.provider.Describe().ID == providerID && v.stateHash == hash {
			id, p = candidate, v
			break
		}
	}
	if p == nil || p.state != "awaiting-login" {
		l.mu.Unlock()
		return nil, loginUnavailable()
	}
	p.state = "exchanging"
	l.mu.Unlock()
	verified, e := p.provider.Complete(ctx, p.preview, returned)
	if e == nil && p.nativeProof == "" {
		var active bool
		e = l.Registry.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM bindings WHERE id=$1 AND subject_id=$2 AND audience=$3 AND revoked_at IS NULL AND expires_at>$4)", p.binding, p.subject, l.Registry.Endpoint, l.Registry.now()).Scan(&active)
		if e == nil && !active {
			e = loginUnavailable()
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if e != nil || l.pending[id] != p || p.state != "exchanging" || verified.ExpiresAt <= l.Registry.now().Unix() {
		if l.pending[id] == p {
			p.state = "failed"
		}
		return nil, fault.New("identity_login_failed", 401)
	}
	if p.nativeProof != "" {
		if !verified.EmailVerified || verified.Email == "" {
			p.state = "failed"
			return nil, fault.New("identity_login_failed", 401)
		}
		p.verified, p.state, p.nativeReview = verified, "awaiting-native-approval", uuid.NewString()
		return Object{"state": p.state, "reviewPath": "/v1/identity/native-review/" + p.nativeReview, "galaxyAuthorization": false}, nil
	}
	l.setIntent(id, p, verified)
	return Object{"state": p.state, "message": "Return to your Galaxy host to review and sign the account association.", "galaxyAuthorization": false}, nil
}

func (l *Links) setIntent(id string, p *pendingLink, verified VerifiedIdentity) {
	p.verifiedEmail = verified.EmailVerified
	p.intent = linkIntent{1, id, "identity.link", p.subject, p.binding, l.Registry.Endpoint, p.provider.Describe().ID, verified.Issuer, verified.ExternalSubject, verified.ClientID, verified.Authentication, verified.VerifiedAt, l.Registry.now().Unix(), verified.ExpiresAt, false}
	p.payload = string(encode(p.intent))
	p.state = "awaiting-local-signature"
}
func (l *Links) Status(ctx context.Context, actor deviceauth.Actor, id string) (Object, error) {
	if !validUUID(id) {
		return nil, fault.New("invalid_request", 400)
	}
	l.purge(ctx)
	return postgres.InTx(ctx, l.Registry.Pool, func(tx pgx.Tx) (Object, error) {
		if e := l.Registry.authorize(ctx, tx, actor); e != nil {
			return nil, e
		}
		l.mu.Lock()
		defer l.mu.Unlock()
		p, e := l.owned(actor, id)
		if e != nil {
			return nil, e
		}
		var at *string
		e = tx.QueryRow(ctx, "SELECT revoked_at::text FROM external_identity_links WHERE id=$1 AND subject_id=$2 AND endpoint=$3", id, actor.SubjectID, l.Registry.Endpoint).Scan(&at)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		state := p.state
		if e == nil {
			state = "linked"
			if at != nil {
				state = "revoked"
			}
		}
		out := Object{"id": id, "state": state, "expiresAt": p.expires, "galaxyAuthorization": false}
		if state == "awaiting-local-signature" || state == "linked" {
			out["intent"] = p.intent
			out["payloadJson"] = p.payload
		}
		return out, nil
	})
}
func (l *Links) Cancel(ctx context.Context, actor deviceauth.Actor, id string) (Object, error) {
	if !validUUID(id) {
		return nil, fault.New("invalid_request", 400)
	}
	l.purge(ctx)
	return postgres.InTx(ctx, l.Registry.Pool, func(tx pgx.Tx) (Object, error) {
		if e := l.Registry.authorize(ctx, tx, actor); e != nil {
			return nil, e
		}
		l.mu.Lock()
		p, e := l.owned(actor, id)
		if e == nil {
			p.state = "canceled"
			delete(l.pending, id)
		}
		l.mu.Unlock()
		if e != nil {
			return nil, e
		}
		if e = p.provider.Cancel(ctx, p.preview); e != nil {
			return nil, e
		}
		return Object{"id": id, "state": "canceled"}, nil
	})
}
func verifyLinkSignature(signed, public string) (string, error) {
	invalid := func() (string, error) { return "", fault.New("identity_signature_invalid", 401) }
	parts := strings.Split(signed, ".")
	if len(parts) != 3 {
		return invalid()
	}
	decode := base64.RawURLEncoding.Strict().DecodeString
	header, e := decode(parts[0])
	if e != nil {
		return invalid()
	}
	var h map[string]string
	if json.Unmarshal(header, &h) != nil || len(h) != 2 || h["alg"] != "Ed25519" || h["typ"] != "galaxy-identity-link+jws" {
		return invalid()
	}
	payload, e := decode(parts[1])
	if e != nil || !utf8.Valid(payload) {
		return invalid()
	}
	signature, e := decode(parts[2])
	if e != nil {
		return invalid()
	}
	block, rest := pem.Decode([]byte(public))
	if block == nil || block.Type != "PUBLIC KEY" || len(rest) != 0 {
		return invalid()
	}
	v, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return invalid()
	}
	key, ok := v.(ed25519.PublicKey)
	if !ok || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) {
		return invalid()
	}
	return string(payload), nil
}
func (l *Links) Confirm(ctx context.Context, actor deviceauth.Actor, id, signed string, httpID *string) (Object, error) {
	if !validUUID(id) || len(signed) < 1 || len(signed) > 16384 {
		return nil, fault.New("invalid_request", 400)
	}
	l.purge(ctx)
	out, e := postgres.InTx(ctx, l.Registry.Pool, func(tx pgx.Tx) (Object, error) {
		// Original resource-write lock precedes credential/control and mapping locks.
		e := resourcebudget.LockSubjectResourceBudget(ctx, tx, actor.SubjectID)
		if e != nil {
			return nil, e
		}
		control, e := l.Registry.Devices.CurrentControlWithin(ctx, tx, actor, "binding")
		if e != nil {
			return nil, e
		}
		before, e := resourcebudget.SubjectResourceUsage(ctx, tx, actor.SubjectID, l.Registry.now().Unix())
		if e != nil {
			return nil, e
		}
		if e = LockMappingsWithin(ctx, tx, l.Registry.Endpoint, []string{actor.SubjectID}, true); e != nil {
			return nil, e
		}
		payload, e := verifyLinkSignature(signed, control.PublicKey)
		if e != nil {
			return nil, e
		}
		var subject, binding, endpoint, priorPayload string
		var revoked *string
		e = tx.QueryRow(ctx, "SELECT subject_id,binding_id::text,endpoint,payload_text,revoked_at::text FROM external_identity_links WHERE id=$1", id).Scan(&subject, &binding, &endpoint, &priorPayload, &revoked)
		if e == nil {
			if subject != actor.SubjectID || binding != actor.BindingID || endpoint != l.Registry.Endpoint || priorPayload != payload {
				return nil, fault.New("identity_link_conflict", 409)
			}
			state := "linked"
			if revoked != nil {
				state = "revoked"
			}
			return Object{"id": id, "state": state, "galaxyAuthorization": false}, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		l.mu.Lock()
		p, e := l.owned(actor, id)
		if e == nil && (p.state != "awaiting-local-signature" || p.payload != payload || p.intent.ExpiresAt <= l.Registry.now().Unix()) {
			e = loginUnavailable()
		}
		var intent linkIntent
		verifiedEmail := false
		if e == nil {
			intent = p.intent
			verifiedEmail = p.verifiedEmail
		}
		l.mu.Unlock()
		if e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, `INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature,created_at,signer_key_id,control_epoch,control_event_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, id, actor.SubjectID, actor.BindingID, l.Registry.Endpoint, intent.ProviderID, intent.Issuer, intent.ExternalSubject, intent.ClientID, payload, identity.Digest([]byte(payload)), signed, l.Registry.now(), control.KeyID, control.Epoch, control.ChainHead)
		if e != nil {
			return nil, e
		}
		if verifiedEmail {
			if _, e = l.Registry.LinkVerifiedWithin(ctx, tx, VerifiedLink{actor.SubjectID, id, l.Registry.Endpoint, intent.Issuer, intent.ExternalSubject, "email", intent.VerifiedAt}); e != nil {
				return nil, e
			}
		}
		if e = audit(ctx, tx, actor, id, "identity.link", httpID, control); e != nil {
			return nil, e
		}
		after, e := resourcebudget.SubjectResourceUsage(ctx, tx, actor.SubjectID, l.Registry.now().Unix())
		if e != nil {
			return nil, e
		}
		if e = resourcebudget.EnforceResourceGrowth(before, after, l.Budget); e != nil {
			return nil, e
		}
		return Object{"id": id, "state": "linked", "galaxyAuthorization": false}, nil
	})
	var pgerr *pgconn.PgError
	if errors.As(e, &pgerr) && pgerr.Code == "23505" {
		return nil, fault.New("identity_link_conflict", 409)
	}
	return out, e
}
func audit(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, id, action string, httpID *string, control deviceauth.ControlAuthorization) error {
	scopes, _ := json.Marshal(control.CredentialScopes)
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,$2,$3,$3,'accepted',1,ch.payload->>'installationId',b.audience,'binding',b.id,$4,$3,b.scopes,$5::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE b.id=$6 AND b.subject_id=$1`, actor.SubjectID, action, id, httpID, scopes, actor.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fault.New("identity_audit_context_unavailable", 503)
	}
	return nil
}
