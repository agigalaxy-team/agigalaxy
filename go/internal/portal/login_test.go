package portal

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
)

func TestLoginUsesExistingOnceOnlyTransactionsAndVerifiedIdentity(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts", "go", "feedback-fixture.mjs"), "setup")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("original schema %v %s", e, out)
	}
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	b64 := base64.RawURLEncoding.EncodeToString
	var base, nonce, challenge string
	var calls atomic.Int32
	var invalid atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": base, "authorization_endpoint": base + "/authorize", "token_endpoint": base + "/token", "jwks_uri": base + "/jwks", "code_challenge_methods_supported": []string{"S256"}, "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/jwks":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "fixture", "n": b64(key.N.Bytes()), "e": b64(big.NewInt(int64(key.E)).Bytes())}}})
		case "/token":
			calls.Add(1)
			_ = r.ParseForm()
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("redirect_uri") != "https://admin.example.invalid/v1/operations/callback" || r.Form.Get("client_id") != "management" || b64(sum[:]) != challenge {
				t.Error("original PKCE code exchange changed")
				w.WriteHeader(400)
				return
			}
			n := nonce
			if invalid.Load() {
				n = "incorrect"
			}
			h, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": "fixture", "typ": "JWT"})
			b, _ := json.Marshal(map[string]any{"iss": base, "sub": "root-subject", "aud": "management", "nonce": n, "iat": time.Now().Unix(), "exp": time.Now().Unix() + 600, "email": "root@example.invalid", "email_verified": true, "name": "知遥 许", "given_name": "知遥", "family_name": "许", "realm_access": map[string]any{"roles": []string{"galaxy-admin"}}})
			input := b64(h) + "." + b64(b)
			hash := sha256.Sum256([]byte(input))
			sig, e := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
			if e != nil {
				t.Error(e)
				w.WriteHeader(500)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-access", "token_type": "Bearer", "expires_in": 600, "refresh_token": "fixture-refresh", "id_token": input + "." + b64(sig)})
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	base = server.URL
	provider, e := NewOIDC(ctx, OIDCConfig{Issuer: base, ClientID: "management", AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	login, e := NewLogin(pool, provider, LoginOptions{ID: "operations-admin", Name: "银河运营管理", RedirectURI: "https://admin.example.invalid/v1/operations/callback", Namespace: "operations:fixture", IncludeProfile: true, IncludeRoles: true, FreshLogin: true, Renewal: true})
	if e != nil {
		t.Fatal(e)
	}
	begin := func() Preview {
		t.Helper()
		p, e := login.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		u, _ := url.Parse(p.AuthorizationURL)
		nonce, challenge = u.Query().Get("nonce"), u.Query().Get("code_challenge")
		if u.Query().Get("prompt") != "login" || nonce == "" || u.Query().Get("code_challenge_method") != "S256" {
			t.Fatal("authorization parameters missing")
		}
		return p
	}
	callback := func(p Preview) string {
		u, _ := url.Parse(p.AuthorizationURL)
		return p.RedirectURI + "?code=fixture-code&state=" + url.QueryEscape(u.Query().Get("state"))
	}
	p := begin()
	before := calls.Load()
	if _, e = login.Complete(ctx, p, p.RedirectURI+"?code=fixture-code&state=wrong"); e == nil || calls.Load() != before {
		t.Fatal("bad state consumed a code")
	}
	principal, e := login.Complete(ctx, p, callback(p))
	if e != nil {
		t.Fatal(e)
	}
	if principal.Subject != "root-subject" || principal.DisplayName == nil || *principal.DisplayName != "许知遥" || !principal.EmailVerified || len(principal.Roles) != 1 || principal.Tokens == nil {
		t.Fatal("verified original profile or refresh material lost")
	}
	if _, e = login.Complete(ctx, p, callback(p)); e == nil || calls.Load() != before+1 {
		t.Fatal("completed authorization code was retried")
	}
	p = begin()
	invalid.Store(true)
	before = calls.Load()
	if _, e = login.Complete(ctx, p, callback(p)); e == nil {
		t.Fatal("wrong signed nonce accepted")
	}
	if _, e = login.Complete(ctx, p, callback(p)); e == nil || calls.Load() != before+1 {
		t.Fatal("failed exchange reused original code")
	}
	p = begin()
	if e = login.Cancel(ctx, p); e != nil {
		t.Fatal(e)
	}
	before = calls.Load()
	if _, e = login.Complete(ctx, p, callback(p)); e == nil || calls.Load() != before {
		t.Fatal("cancelled login exchanged code")
	}
}
