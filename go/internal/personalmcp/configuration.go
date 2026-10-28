// Package personalmcp adapts the existing domain use cases to the official MCP
// SDK. OAuth supplies an opaque current resource authority, never a signature.
package personalmcp

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	whatwg "github.com/nlnwa/whatwg-url/url"
)

type Object = map[string]any
type Configuration struct {
	Version               int      `json:"version"`
	ProviderID            string   `json:"providerId"`
	IntrospectionClientID string   `json:"introspectionClientId"`
	ClientSecretEnv       string   `json:"clientSecretEnv"`
	AllowedClientIDs      []string `json:"allowedClientIds"`
	AllowedScopes         []string `json:"allowedScopes"`
	AllowedOrigins        []string `json:"allowedOrigins"`
}
type LoadOptions struct {
	Services          Services
	Providers         []accountlinks.LoginProvider
	Environment       func(string) string
	Now               func() time.Time
	Transport         http.RoundTripper
	AllowLoopbackHTTP bool
}

var providerPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
var secretPattern = regexp.MustCompile(`^GALAXY_OAUTH_[A-Z0-9_]{1,80}$`)

func text(s string, max int) bool {
	if utf8.RuneCountInString(s) < 1 || utf8.RuneCountInString(s) > max {
		return false
	}
	for _, r := range s {
		if unicode.Is(unicode.Cc, r) {
			return false
		}
	}
	return true
}
func included(values []string, value string) bool {
	for _, s := range values {
		if s == value {
			return true
		}
	}
	return false
}
func distinct(values []string) bool {
	seen := map[string]bool{}
	for _, s := range values {
		if seen[s] {
			return false
		}
		seen[s] = true
	}
	return true
}
func configurationError() error { return fault.New("personal_mcp_configuration_invalid", 503) }

// Load reads the existing opt-in configuration and already loaded OIDC provider
// metadata. Only the named environment reference is resolved, never persisted.
func Load(ctx context.Context, path string, options LoadOptions) (*Handler, error) {
	if path == "" {
		return nil, nil
	}
	if !filepath.IsAbs(path) {
		return nil, configurationError()
	}
	stat, e := os.Lstat(path)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode()&os.ModeSymlink != 0 || stat.Size() > 32768 {
		return nil, configurationError()
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return nil, configurationError()
	}
	for k, v := range fields {
		if string(v) == "null" || !included([]string{"version", "providerId", "introspectionClientId", "clientSecretEnv", "allowedClientIds", "allowedScopes", "allowedOrigins"}, k) {
			return nil, configurationError()
		}
	}
	var c Configuration
	if json.Unmarshal(raw, &c) != nil || c.Version != 1 || !providerPattern.MatchString(c.ProviderID) || !secretPattern.MatchString(c.ClientSecretEnv) || !text(c.IntrospectionClientID, 200) || len(c.AllowedClientIDs) < 1 || len(c.AllowedClientIDs) > 64 || !distinct(c.AllowedClientIDs) || len(c.AllowedScopes) < 1 || len(c.AllowedScopes) > 13 || !distinct(c.AllowedScopes) || !included(c.AllowedScopes, "binding") || len(c.AllowedOrigins) > 8 {
		return nil, configurationError()
	}
	for _, id := range c.AllowedClientIDs {
		if !text(id, 200) {
			return nil, configurationError()
		}
	}
	for _, scope := range c.AllowedScopes {
		if !included([]string{"binding", "consent", "case-teaser", "evidence", "proof", "history", "assistance", "context", "notifications", "capsules", "builders", "audit", "data-export"}, scope) {
			return nil, configurationError()
		}
	}
	if c.AllowedOrigins == nil {
		c.AllowedOrigins = []string{}
	}
	for _, origin := range c.AllowedOrigins {
		u, e := whatwg.Parse(origin)
		if e != nil || u.Scheme() != "https" || "https://"+u.Host() != origin {
			return nil, configurationError()
		}
	}
	var provider *accountlinks.Description
	for _, p := range options.Providers {
		d := p.Describe()
		if d.ID == c.ProviderID {
			provider = &d
			break
		}
	}
	if provider == nil || options.Services.Devices == nil {
		return nil, configurationError()
	}
	env := options.Environment
	if env == nil {
		env = os.Getenv
	}
	secret := env(c.ClientSecretEnv)
	if !text(secret, 4096) {
		return nil, fault.New("personal_mcp_introspection_credential_unavailable", 503)
	}
	verifier, e := deviceauth.NewOAuthIntrospection(ctx, deviceauth.OAuthIntrospectionConfig{Issuer: provider.Issuer, Resource: options.Services.Devices.Endpoint + "/mcp/personal", ClientID: c.IntrospectionClientID, ClientSecret: secret, AllowedClientIDs: c.AllowedClientIDs, AllowedOrigins: c.AllowedOrigins, AllowLoopbackHTTP: options.AllowLoopbackHTTP, Now: options.Now, Transport: options.Transport})
	if e != nil {
		return nil, e
	}
	authority, e := deviceauth.NewOAuthResourceAccess(options.Services.Devices, verifier, deviceauth.OAuthProvider{ID: provider.ID, Issuer: provider.Issuer, ClientID: provider.ClientID}, c.AllowedScopes)
	if e != nil {
		return nil, e
	}
	h, e := NewHandler(options.Services, authority, verifier)
	if e != nil {
		return nil, e
	}
	encoded, e := protocol.EncodeJS(c)
	if e != nil {
		return nil, e
	}
	h.configurationHash = identity.Digest(encoded)
	return h, nil
}
