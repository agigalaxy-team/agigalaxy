package portal

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

type OIDCConfig struct {
	Issuer, ClientID, ClientSecret string
	AllowedOrigins                 []string
	AllowLoopbackHTTP              bool
}
type OIDCProvider struct {
	configuration OIDCConfig
	provider      *oidc.Provider
	oauth         oauth2.Config
	client        *http.Client
	Now           func() time.Time
}
type boundedTransport struct {
	next     http.RoundTripper
	origins  map[string]bool
	loopback bool
}

func secureURL(value string, loopback bool) (*url.URL, error) {
	u, e := url.Parse(value)
	if e != nil || u.Host == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" || u.Scheme != "https" && !(loopback && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return nil, fault.New("oidc_configuration_invalid", 400)
	}
	return u, nil
}
func (t boundedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if _, e := secureURL(r.URL.String(), t.loopback); e != nil || !t.origins[r.URL.Scheme+"://"+r.URL.Host] {
		return nil, fault.New("oidc_transport_unavailable", 503)
	}
	response, e := t.next.RoundTrip(r)
	if e != nil {
		return nil, fault.New("oidc_transport_unavailable", 503)
	}
	b, e := io.ReadAll(io.LimitReader(response.Body, 262145))
	_ = response.Body.Close()
	if e != nil || len(b) > 262144 {
		return nil, fault.New("oidc_transport_unavailable", 503)
	}
	response.Body = io.NopCloser(bytes.NewReader(b))
	return response, nil
}
func NewOIDC(ctx context.Context, c OIDCConfig) (*OIDCProvider, error) {
	u, e := secureURL(c.Issuer, c.AllowLoopbackHTTP)
	if e != nil || c.ClientID == "" || protocol.TextLength(c.ClientID) > 200 || len(c.AllowedOrigins) > 8 {
		return nil, fault.New("oidc_configuration_invalid", 400)
	}
	origins := map[string]bool{u.Scheme + "://" + u.Host: true}
	for _, value := range c.AllowedOrigins {
		u, e := secureURL(value, c.AllowLoopbackHTTP)
		if e != nil || u.Path != "" {
			return nil, fault.New("oidc_configuration_invalid", 400)
		}
		origins[value] = true
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: boundedTransport{http.DefaultTransport, origins, c.AllowLoopbackHTTP}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	provider, e := oidc.NewProvider(oidc.ClientContext(ctx, client), c.Issuer)
	if e != nil {
		return nil, fault.New("oidc_discovery_unavailable", 503)
	}
	var metadata struct {
		Challenges    []string `json:"code_challenge_methods_supported"`
		Authorization string   `json:"authorization_endpoint"`
		Token         string   `json:"token_endpoint"`
		JWKS          string   `json:"jwks_uri"`
	}
	if provider.Claims(&metadata) != nil || metadata.JWKS == "" {
		return nil, fault.New("oidc_configuration_invalid", 400)
	}
	s256 := false
	for _, method := range metadata.Challenges {
		if method == "S256" {
			s256 = true
		}
	}
	if !s256 {
		return nil, fault.New("oidc_configuration_invalid", 400)
	}
	for _, address := range []string{metadata.Authorization, metadata.Token, metadata.JWKS} {
		u, e := secureURL(address, c.AllowLoopbackHTTP)
		if e != nil || !origins[u.Scheme+"://"+u.Host] {
			return nil, fault.New("oidc_configuration_invalid", 400)
		}
	}
	endpoint := provider.Endpoint()
	endpoint.AuthStyle = oauth2.AuthStyleInParams
	if c.ClientSecret != "" {
		endpoint.AuthStyle = oauth2.AuthStyleInHeader
	}
	return &OIDCProvider{configuration: c, provider: provider, client: client, oauth: oauth2.Config{ClientID: c.ClientID, ClientSecret: c.ClientSecret, Endpoint: endpoint}}, nil
}
func (p *OIDCProvider) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}
func validText(s string, max int) bool {
	if s == "" || protocol.TextLength(s) > max {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func (p *OIDCProvider) Refresh(ctx context.Context, input RefreshRequest) (Tokens, error) {
	if input.Issuer != p.configuration.Issuer || !validText(input.Subject, 255) || !validText(input.Token, 16384) {
		return Tokens{}, fault.New("portal_session_refresh_unconfirmed", 503)
	}
	ctx = oidc.ClientContext(ctx, p.client)
	// The auth style is explicit: oauth2 must not probe another style by
	// resending a one-use refresh token after a failed exchange.
	token, e := p.oauth.TokenSource(ctx, &oauth2.Token{RefreshToken: input.Token, Expiry: time.Unix(1, 0)}).Token()
	if e != nil {
		var response *oauth2.RetrieveError
		if errors.As(e, &response) && response.ErrorCode == "invalid_grant" {
			return Tokens{}, fault.New("portal_refresh_rejected", 401)
		}
		return Tokens{}, fault.New("portal_session_refresh_unconfirmed", 503)
	}
	if raw, ok := token.Extra("id_token").(string); ok && raw != "" {
		verified, e := p.provider.Verifier(&oidc.Config{ClientID: p.configuration.ClientID, Now: p.now}).Verify(ctx, raw)
		if e != nil {
			return Tokens{}, fault.New("portal_session_refresh_unconfirmed", 503)
		}
		if verified.Subject != input.Subject || verified.Issuer != input.Issuer || !verified.Expiry.After(p.now()) {
			return Tokens{}, fault.New("portal_refresh_rejected", 401)
		}
		if verified.AccessTokenHash != "" && verified.VerifyAccessToken(token.AccessToken) != nil {
			return Tokens{}, fault.New("portal_session_refresh_unconfirmed", 503)
		}
	}
	if token.ExpiresIn <= 0 {
		return Tokens{}, fault.New("portal_session_refresh_unconfirmed", 503)
	}
	refresh := token.RefreshToken
	if refresh == "" {
		refresh = input.Token
	}
	if !validText(refresh, 16384) || strings.TrimSpace(refresh) == "" {
		return Tokens{}, fault.New("portal_session_refresh_unconfirmed", 503)
	}
	return Tokens{refresh, p.now().Unix() + token.ExpiresIn}, nil
}
