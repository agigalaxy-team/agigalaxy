// Package accountlinkfixture creates actual signed associations through an isolated OIDC issuer.
package accountlinkfixture

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Fixture struct {
	Registry         *accountlinks.Service
	Links            *accountlinks.Links
	Issuer, ClientID string
	server           *httptest.Server
	nonce, subject   string
	t                *testing.T
}

func New(t *testing.T, pool *pgxpool.Pool, devices *deviceauth.Service) *Fixture {
	t.Helper()
	ctx := context.Background()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &Fixture{t: t, ClientID: "galaxy-fixture"}
	now := func() time.Time { return time.Unix(devicefixture.Now, 0) }
	issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			json.NewEncoder(w).Encode(map[string]any{"issuer": f.Issuer, "authorization_endpoint": f.Issuer + "/authorize", "token_endpoint": f.Issuer + "/token", "jwks_uri": f.Issuer + "/jwks", "response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}, "code_challenge_methods_supported": []string{"S256"}})
		case "/jwks":
			json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "fixture", "alg": "RS256", "use": "sig", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
		case "/token":
			r.ParseForm()
			if r.Form.Get("code") != "isolated-code" || len(r.Form.Get("code_verifier")) < 43 {
				w.WriteHeader(400)
				return
			}
			h, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": "fixture", "typ": "JWT"})
			c, _ := json.Marshal(map[string]any{"iss": f.Issuer, "sub": f.subject, "aud": f.ClientID, "iat": devicefixture.Now, "exp": devicefixture.Now + 600, "nonce": f.nonce, "email_verified": true})
			input := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
			digest := sha256.Sum256([]byte(input))
			signature, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
			json.NewEncoder(w).Encode(map[string]any{"access_token": "synthetic-access-token", "token_type": "Bearer", "expires_in": 600, "id_token": input + "." + base64.RawURLEncoding.EncodeToString(signature)})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(issuer.Close)
	f.Issuer = issuer.URL
	oidc, err := portal.NewOIDC(ctx, portal.OIDCConfig{Issuer: f.Issuer, ClientID: f.ClientID, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	oidc.Now = now
	redirect := devicefixture.Endpoint + "/v1/identity/callback/fixture"
	login, err := portal.NewLogin(pool, oidc, portal.LoginOptions{ID: "fixture", Name: "isolated", RedirectURI: redirect, Namespace: "isolated-chat-accounts"})
	if err != nil {
		t.Fatal(err)
	}
	provider := &accountlinks.OIDCProvider{Description: accountlinks.Description{"fixture", "isolated", f.Issuer, f.ClientID, redirect, "openid-connect", "authorization_code", "S256", 300}, Login: login, Now: now}
	providers := accountlinks.ProviderMetadata([]accountlinks.LoginProvider{provider})
	f.Registry = &accountlinks.Service{Pool: pool, Endpoint: devicefixture.Endpoint, Devices: devices, Accounts: &accounts.Service{Endpoint: devicefixture.Endpoint, Now: now}, Providers: providers, Now: now}
	f.Links, err = accountlinks.NewLinks(f.Registry, []accountlinks.LoginProvider{provider}, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.server = httptest.NewServer(accountlinks.Handler{Links: f.Links})
	t.Cleanup(f.server.Close)
	return f
}

// Link uses real OIDC callback validation and the subject's signed authorization.
func (f *Fixture) Link(device deviceauthfixture.Fixture, externalSubject string) {
	t := f.t
	t.Helper()
	f.subject = externalSubject
	call := func(method, path string, input any) map[string]any {
		t.Helper()
		var body []byte
		if input != nil {
			body, _ = json.Marshal(input)
		}
		req, e := http.NewRequest(method, f.server.URL+path, strings.NewReader(string(body)))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Content-Type", "application/json")
		if method == "POST" {
			req.Header.Set("Authorization", "Bearer "+device.Credential)
		}
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		var out map[string]any
		if e = json.Unmarshal(raw, &out); e != nil || res.StatusCode != 200 {
			t.Fatalf("isolated link %s: %d %s %v", path, res.StatusCode, raw, e)
		}
		return out
	}
	begin := call("POST", "/v1/identity/begin", map[string]any{"providerId": "fixture"})
	u, err := url.Parse(begin["authorizationUrl"].(string))
	if err != nil {
		t.Fatal(err)
	}
	f.nonce = u.Query().Get("nonce")
	callback := call("GET", "/v1/identity/callback/fixture?code=isolated-code&state="+url.QueryEscape(u.Query().Get("state")), nil)
	if callback["state"] != "awaiting-local-signature" {
		t.Fatal(callback)
	}
	pending := call("POST", "/v1/identity/status", map[string]any{"id": begin["loginId"]})
	private, err := identity.PrivatePEM([]byte(device.Materials.OwnerPrivate))
	if err != nil {
		t.Fatal(err)
	}
	signed, err := identity.SignIdentityPayload(private, pending["payloadJson"].(string), "galaxy-identity-link+jws")
	if err != nil {
		t.Fatal(err)
	}
	linked := call("POST", "/v1/identity/confirm", map[string]any{"id": begin["loginId"], "signed": signed})
	if linked["state"] != "linked" {
		t.Fatal(linked)
	}
}
