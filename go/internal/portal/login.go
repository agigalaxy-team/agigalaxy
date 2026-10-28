package portal

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"
)

type LoginOptions struct {
	ID, Name, RedirectURI, Namespace                  string
	IncludeProfile, IncludeRoles, FreshLogin, Renewal bool
}
type Login struct {
	provider *OIDCProvider
	pool     *pgxpool.Pool
	options  LoginOptions
	key      string
}
type Preview struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Issuer           string `json:"issuer"`
	ClientID         string `json:"clientId"`
	RedirectURI      string `json:"redirectUri"`
	Protocol         string `json:"protocol"`
	Grant            string `json:"grant"`
	PKCE             string `json:"pkce"`
	Lifetime         int    `json:"loginLifetimeSeconds"`
	LoginID          string `json:"loginId"`
	AuthorizationURL string `json:"authorizationUrl"`
	ExpiresAt        int64  `json:"expiresAt"`
}
type Principal struct {
	Issuer, Subject, ClientID string
	DisplayName, Email        *string
	EmailVerified             bool
	Roles                     []string
	IssuedAt, ExpiresAt       int64
	Tokens                    *Tokens
}

var providerIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// NewLogin retains the original once-only PostgreSQL transaction authority.
// Private PKCE material never appears in Preview, cookies or application logs.
func NewLogin(pool *pgxpool.Pool, provider *OIDCProvider, o LoginOptions) (*Login, error) {
	if pool == nil || provider == nil || !providerIDPattern.MatchString(o.ID) || !validText(o.Name, 100) || !validText(o.Namespace, 256) {
		return nil, fault.New("oidc_configuration_invalid", 400)
	}
	if _, e := secureURL(o.RedirectURI, provider.configuration.AllowLoopbackHTTP); e != nil {
		return nil, e
	}
	b, e := protocol.Encode(struct {
		ID          string `json:"id"`
		Issuer      string `json:"issuer"`
		ClientID    string `json:"clientId"`
		RedirectURI string `json:"redirectUri"`
		Profile     bool   `json:"includeAccountProfile"`
		Roles       bool   `json:"includeOperatorRoles"`
	}{o.ID, provider.configuration.Issuer, provider.configuration.ClientID, o.RedirectURI, o.IncludeProfile, o.IncludeRoles})
	if e != nil {
		return nil, e
	}
	return &Login{provider: provider, pool: pool, options: o, key: identity.Digest(b)}, nil
}
func opaque() (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func (l *Login) Begin(ctx context.Context) (Preview, error) {
	var empty Preview
	verifier, e := opaque()
	if e != nil {
		return empty, e
	}
	state, e := opaque()
	if e != nil {
		return empty, e
	}
	nonce, e := opaque()
	if e != nil {
		return empty, e
	}
	sum := sha256.Sum256([]byte(verifier))
	oauth := l.provider.oauth
	oauth.RedirectURL = l.options.RedirectURI
	oauth.Scopes = []string{"openid", "email"}
	opts := []oauth2.AuthCodeOption{oauth2.SetAuthURLParam("nonce", nonce), oauth2.SetAuthURLParam("code_challenge", base64.RawURLEncoding.EncodeToString(sum[:])), oauth2.SetAuthURLParam("code_challenge_method", "S256")}
	if l.options.FreshLogin {
		opts = append(opts, oauth2.SetAuthURLParam("prompt", "login"))
	}
	at := l.provider.now().Unix()
	p := Preview{l.options.ID, l.options.Name, l.provider.configuration.Issuer, l.provider.configuration.ClientID, l.options.RedirectURI, "openid-connect", "authorization_code", "S256", 300, uuid.NewString(), oauth.AuthCodeURL(state, opts...), at + 300}
	_, e = postgres.InTx(ctx, l.pool, func(tx pgx.Tx) (bool, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912338,hashtext($1))", l.options.Namespace); e != nil {
			return false, e
		}
		if _, e := tx.Exec(ctx, "DELETE FROM oidc_login_transactions_v1 WHERE namespace=$1 AND expires_at<=$2", l.options.Namespace, at); e != nil {
			return false, e
		}
		var n int
		if e := tx.QueryRow(ctx, "SELECT count(*) FROM oidc_login_transactions_v1 WHERE namespace=$1", l.options.Namespace).Scan(&n); e != nil {
			return false, e
		}
		if n >= 2048 {
			return false, fault.New("oidc_login_capacity", 503)
		}
		_, e := tx.Exec(ctx, `INSERT INTO oidc_login_transactions_v1(namespace,provider_key,login_id,verifier,state,nonce,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, l.options.Namespace, l.key, p.LoginID, verifier, state, nonce, at, p.ExpiresAt)
		return e == nil, e
	})
	if e != nil {
		return empty, e
	}
	return p, nil
}
func (l *Login) Cancel(ctx context.Context, p Preview) error {
	_, e := l.pool.Exec(ctx, "DELETE FROM oidc_login_transactions_v1 WHERE namespace=$1 AND provider_key=$2 AND login_id=$3", l.options.Namespace, l.key, p.LoginID)
	return e
}
func (l *Login) Complete(ctx context.Context, p Preview, returned string) (Principal, error) {
	fail := func() (Principal, error) { return Principal{}, fault.New("oidc_login_verification_failed", 403) }
	if p.Issuer != l.provider.configuration.Issuer || p.ClientID != l.provider.configuration.ClientID || p.RedirectURI != l.options.RedirectURI || p.ExpiresAt <= l.provider.now().Unix() {
		return fail()
	}
	expected, e := url.Parse(p.AuthorizationURL)
	if e != nil {
		return fail()
	}
	actual, e := url.Parse(returned)
	if e != nil {
		return fail()
	}
	callback, _ := url.Parse(l.options.RedirectURI)
	values := actual.Query()
	state := values.Get("state")
	if actual.Scheme != callback.Scheme || actual.Host != callback.Host || actual.EscapedPath() != callback.EscapedPath() || actual.User != nil || actual.Fragment != "" || len(values["state"]) != 1 || state == "" || state != expected.Query().Get("state") || len(values["code"]) != 1 || !validText(values.Get("code"), 4096) || len(values["error"]) != 0 {
		return fail()
	}
	var verifier, nonce string
	// Commit consumption before calling the token endpoint. A timeout must not
	// turn into another exchange of the same possibly consumed code.
	e = l.pool.QueryRow(ctx, `DELETE FROM oidc_login_transactions_v1 WHERE namespace=$1 AND provider_key=$2 AND login_id=$3 AND state=$4 AND expires_at>$5 RETURNING verifier,nonce`, l.options.Namespace, l.key, p.LoginID, state, l.provider.now().Unix()).Scan(&verifier, &nonce)
	if e != nil {
		return fail()
	}
	oauth := l.provider.oauth
	oauth.RedirectURL = l.options.RedirectURI
	tokens, e := oauth.Exchange(oidc.ClientContext(ctx, l.provider.client), values.Get("code"), oauth2.VerifierOption(verifier))
	if e != nil {
		return fail()
	}
	raw, ok := tokens.Extra("id_token").(string)
	if !ok || raw == "" {
		return fail()
	}
	verified, e := l.provider.provider.Verifier(&oidc.Config{ClientID: l.provider.configuration.ClientID, Now: l.provider.now}).Verify(oidc.ClientContext(ctx, l.provider.client), raw)
	if e != nil || verified.Nonce != nonce || !validText(verified.Subject, 255) || !verified.Expiry.After(l.provider.now()) || verified.AccessTokenHash != "" && verified.VerifyAccessToken(tokens.AccessToken) != nil {
		return fail()
	}
	var claims struct {
		IssuedAt  *int64                     `json:"iat"`
		Email     string                     `json:"email"`
		Verified  bool                       `json:"email_verified"`
		Name      string                     `json:"name"`
		First     string                     `json:"given_name"`
		Last      string                     `json:"family_name"`
		Username  string                     `json:"preferred_username"`
		Realm     json.RawMessage            `json:"realm_access"`
		Resources map[string]json.RawMessage `json:"resource_access"`
	}
	if verified.Claims(&claims) != nil || claims.IssuedAt == nil || *claims.IssuedAt > 9007199254740991 || *claims.IssuedAt < -9007199254740991 {
		return fail()
	}
	result := Principal{Issuer: verified.Issuer, Subject: verified.Subject, ClientID: l.provider.configuration.ClientID, EmailVerified: claims.Verified, IssuedAt: *claims.IssuedAt, ExpiresAt: min(verified.Expiry.Unix(), p.ExpiresAt), Roles: []string{}}
	if l.options.IncludeProfile {
		if validText(claims.Email, 320) {
			result.Email = &claims.Email
		}
		name := claims.Name
		if !validText(name, 200) || strings.TrimSpace(name) == "" {
			name = claims.Username
			if !validText(name, 200) || strings.TrimSpace(name) == "" || strings.EqualFold(strings.TrimSpace(name), strings.TrimSpace(claims.Email)) || strings.Contains(name, "@") {
				name = ""
			}
		}
		if name != "" {
			if l.options.IncludeRoles && strings.TrimSpace(name) == strings.TrimSpace(strings.TrimSpace(claims.First)+" "+strings.TrimSpace(claims.Last)) && han(claims.First) && han(claims.Last) {
				name = strings.TrimSpace(claims.Last) + strings.TrimSpace(claims.First)
			}
			result.DisplayName = &name
		}
	}
	if l.options.IncludeRoles {
		seen := map[string]bool{}
		for _, source := range []json.RawMessage{claims.Realm, claims.Resources[l.provider.configuration.ClientID]} {
			if len(source) == 0 {
				continue
			}
			var container map[string]json.RawMessage
			if json.Unmarshal(source, &container) != nil {
				return fail()
			}
			roles, exists := container["roles"]
			if !exists {
				continue
			}
			var entries []string
			if json.Unmarshal(roles, &entries) != nil || entries == nil || len(entries) > 128 {
				return fail()
			}
			for _, role := range entries {
				if !validText(role, 160) || strings.TrimSpace(role) != role {
					return fail()
				}
				if !seen[role] {
					seen[role] = true
					result.Roles = append(result.Roles, role)
				}
			}
		}
	}
	if l.options.Renewal && tokens.RefreshToken != "" {
		if !validText(tokens.RefreshToken, 16384) {
			return fail()
		}
		result.Tokens = &Tokens{RefreshToken: tokens.RefreshToken, ExpiresAt: l.provider.now().Unix() + max(1, tokens.ExpiresIn)}
	}
	return result, nil
}
func han(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	for _, r := range s {
		if !unicode.Is(unicode.Han, r) {
			return false
		}
	}
	return true
}
