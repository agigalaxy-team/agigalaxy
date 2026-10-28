package accountlinks

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Description struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Issuer      string `json:"issuer"`
	ClientID    string `json:"clientId"`
	RedirectURI string `json:"redirectUri"`
	Protocol    string `json:"protocol"`
	Grant       string `json:"grant"`
	PKCE        string `json:"pkce"`
	Lifetime    int    `json:"loginLifetimeSeconds"`
}
type VerifiedIdentity struct {
	Issuer, ExternalSubject, ClientID, Authentication string
	VerifiedAt, ExpiresAt                             int64
	EmailVerified                                     bool
}
type LoginProvider interface {
	Describe() Description
	Begin(context.Context) (portal.Preview, error)
	Complete(context.Context, portal.Preview, string) (VerifiedIdentity, error)
	Cancel(context.Context, portal.Preview) error
}
type OIDCProvider struct {
	Description Description
	Login       *portal.Login
	Now         func() time.Time
}

func (p *OIDCProvider) Describe() Description                             { return p.Description }
func (p *OIDCProvider) Begin(ctx context.Context) (portal.Preview, error) { return p.Login.Begin(ctx) }
func (p *OIDCProvider) Cancel(ctx context.Context, v portal.Preview) error {
	return p.Login.Cancel(ctx, v)
}
func (p *OIDCProvider) Complete(ctx context.Context, preview portal.Preview, returned string) (VerifiedIdentity, error) {
	v, e := p.Login.Complete(ctx, preview, returned)
	if e != nil {
		return VerifiedIdentity{}, e
	}
	now := time.Now().Unix()
	if p.Now != nil {
		now = p.Now().Unix()
	}
	d := p.Description
	if v.Issuer != d.Issuer || v.ClientID != d.ClientID || v.Subject == "" || v.ExpiresAt <= now {
		return VerifiedIdentity{}, fault.New("identity_login_failed", 401)
	}
	return VerifiedIdentity{v.Issuer, v.Subject, v.ClientID, "oidc-authorization-code-pkce-s256-id-token-signature", now, min(v.ExpiresAt, preview.ExpiresAt), v.EmailVerified}, nil
}

type ProviderConfiguration struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Issuer            string   `json:"issuer"`
	ClientID          string   `json:"clientId"`
	SecretEnvironment string   `json:"clientSecretEnv,omitempty"`
	AllowedOrigins    []string `json:"allowedOrigins,omitempty"`
}

var providerID = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
var secretEnvironment = regexp.MustCompile(`^GALAXY_OIDC_[A-Z0-9_]{1,80}$`)

func providerText(v string, max int) bool {
	if protocol.TextLength(v) < 1 || protocol.TextLength(v) > max {
		return false
	}
	for _, r := range v {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func issuerURL(v string, origin bool) bool {
	u, e := url.Parse(v)
	return e == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && (!origin || u.Path == "" && "https://"+u.Host == v)
}

// LoadProviders reads only the original public provider metadata and explicitly
// named process secrets. It never discovers .env files or copies credentials.
func LoadProviders(ctx context.Context, pool *pgxpool.Pool, endpoint, path string, getenv func(string) string) ([]LoginProvider, error) {
	var config struct {
		Version   int                     `json:"version"`
		Providers []ProviderConfiguration `json:"providers"`
	}
	config.Version = 1
	config.Providers = []ProviderConfiguration{}
	invalid := func() ([]LoginProvider, error) { return nil, fault.New("identity_configuration_invalid", 400) }
	if path != "" {
		config.Version = 0
		config.Providers = nil
		if !filepath.IsAbs(path) {
			return invalid()
		}
		info, e := os.Lstat(path)
		if e != nil || !info.Mode().IsRegular() || info.Size() > 32768 {
			return invalid()
		}
		b, e := os.ReadFile(path)
		if e != nil || len(b) > 32768 || protocol.Decode(b, &config) != nil {
			return invalid()
		}
		var shape struct {
			Providers []map[string]json.RawMessage `json:"providers"`
		}
		if json.Unmarshal(b, &shape) != nil {
			return invalid()
		}
		for _, item := range shape.Providers {
			for _, raw := range item {
				if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
					return invalid()
				}
			}
			if raw, present := item["clientSecretEnv"]; present {
				var name string
				if json.Unmarshal(raw, &name) != nil || !secretEnvironment.MatchString(name) {
					return invalid()
				}
			}
		}

	}
	if config.Version != 1 || config.Providers == nil || len(config.Providers) > 8 {
		return invalid()
	}
	if getenv == nil {
		getenv = os.Getenv
	}
	seen := map[string]bool{}
	providers := []LoginProvider{}
	for _, c := range config.Providers {
		if !providerID.MatchString(c.ID) || seen[c.ID] || !providerText(c.Name, 100) || !providerText(c.ClientID, 200) || !issuerURL(c.Issuer, false) || len(c.AllowedOrigins) > 8 || c.SecretEnvironment != "" && !secretEnvironment.MatchString(c.SecretEnvironment) {
			return invalid()
		}
		seen[c.ID] = true
		for _, origin := range c.AllowedOrigins {
			if !issuerURL(origin, true) {
				return invalid()
			}
		}
		secret := ""
		if c.SecretEnvironment != "" {
			secret = getenv(c.SecretEnvironment)
			if !providerText(secret, 4096) {
				return nil, fault.New("identity_configuration_credential_unavailable", 503)
			}
		}
		oidc, e := portal.NewOIDC(ctx, portal.OIDCConfig{Issuer: c.Issuer, ClientID: c.ClientID, ClientSecret: secret, AllowedOrigins: c.AllowedOrigins})
		if e != nil {
			return nil, e
		}
		redirect := endpoint + "/v1/identity/callback/" + c.ID
		login, e := portal.NewLogin(pool, oidc, portal.LoginOptions{ID: c.ID, Name: c.Name, RedirectURI: redirect, Namespace: "identity:" + identity.Digest(encode([]string{endpoint, c.ID}))})
		if e != nil {
			return nil, e
		}
		providers = append(providers, &OIDCProvider{Description: Description{c.ID, c.Name, c.Issuer, c.ClientID, redirect, "openid-connect", "authorization_code", "S256", 300}, Login: login})
	}
	return providers, nil
}
func ProviderMetadata(providers []LoginProvider) []Provider {
	out := []Provider{}
	for _, p := range providers {
		d := p.Describe()
		out = append(out, Provider{d.Issuer, d.ClientID})
	}
	return out
}
