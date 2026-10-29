package access

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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/feedbackfixture"
)

func TestAccountSignedOIDCFullHTTPFlow(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	feedbackfixture.Create(t, pool)
	// Same RSA/JWKS/discovery structure as operator-login_test, scoped to this
	// native Keycloak account endpoint; no generic replacement OIDC framework.
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	b64 := base64.RawURLEncoding.EncodeToString
	var issuer string
	var mu sync.Mutex
	var nonce, challenge, behavior string
	var exchanges atomic.Int32
	var validPKCE atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/protocol/openid-connect/auth", "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/jwks", "code_challenge_methods_supported": []string{"S256"}, "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/jwks":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "fixture", "n": b64(key.N.Bytes()), "e": b64(big.NewInt(int64(key.E)).Bytes())}}})
		case "/token":
			exchanges.Add(1)
			_ = r.ParseForm()
			mu.Lock()
			wantNonce, wantChallenge, mode := nonce, challenge, behavior
			mu.Unlock()
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("client_id") != "website-account" || r.Form.Get("redirect_uri") != "https://api.account.example.invalid/v1/account/callback" || b64(sum[:]) != wantChallenge {
				w.WriteHeader(400)
				_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
				return
			}
			validPKCE.Add(1)
			if mode == "nonce" {
				wantNonce = "another-login-nonce"
			}
			h, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": "fixture"})
			b, _ := json.Marshal(map[string]any{"iss": issuer, "aud": "website-account", "sub": "original-account-subject", "nonce": wantNonce, "iat": time.Now().Unix(), "exp": time.Now().Unix() + 600, "email": "person@example.invalid", "email_verified": true, "name": "Provider name"})
			input := b64(h) + "." + b64(b)
			digest := sha256.Sum256([]byte(input))
			signature, e := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
			if e != nil {
				t.Error(e)
				w.WriteHeader(500)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-access", "token_type": "Bearer", "refresh_token": "fixture-account-refresh", "expires_in": 600, "id_token": input + "." + b64(signature)})
		default:
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	issuer = upstream.URL
	g, e := New(pool, Config{Endpoint: "https://api.account.example.invalid", WebsiteOrigin: "https://website.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: issuer, AccountClientID: "website-account", AssociationClients: []string{"association"}, OperatorIssuer: "https://operator.example.invalid", AccountScope: strings.Repeat("c", 64), OperatorConfiguration: strings.Repeat("d", 64), AdministratorRole: "admin", ReaderRole: "reader", AllowLoopbackHTTP: true}, nil)
	if e != nil {
		t.Fatal(e)
	}
	provider, e := portal.NewOIDC(ctx, portal.OIDCConfig{Issuer: issuer, ClientID: g.Config.AccountClientID, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	g.accountLogin, e = portal.NewLogin(pool, provider, portal.LoginOptions{ID: "official-account-entry", Name: "Account", RedirectURI: g.Config.Endpoint + "/v1/account/callback", Namespace: "official-account:" + g.Config.AccountScope, IncludeProfile: true, Renewal: true})
	if e != nil {
		t.Fatal(e)
	}
	g.AccountRenewal, e = portal.New(pool, "account", []string{g.Config.AccountScope}, portal.Policy{Key: make([]byte, 32), IdleSeconds: 604800, MaximumSeconds: 2592000, RefreshBeforeSeconds: 60}, provider)
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(g.SessionHandler(http.NotFoundHandler()))
	defer server.Close()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request := func(method, path, csrf string, cookies ...*http.Cookie) *http.Response {
		t.Helper()
		r, _ := http.NewRequest(method, server.URL+path, strings.NewReader("{}"))
		r.Header.Set("Origin", g.Config.WebsiteOrigin)
		if method == "POST" {
			r.Header.Set("Content-Type", "application/json")
		}
		if csrf != "" {
			r.Header.Set("X-Galaxy-Account-CSRF", csrf)
		}
		for _, c := range cookies {
			r.AddCookie(c)
		}
		res, e := client.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { _ = res.Body.Close() })
		return res
	}
	begin := func(mode string, cookies ...*http.Cookie) (*http.Cookie, string) {
		t.Helper()
		res := request("GET", "/v1/account/login?mode="+mode+"&returnTo=%2Fapp%2Faccount%3Ftab%3Dprofile", "", cookies...)
		if res.StatusCode != 303 || len(res.Cookies()) != 1 {
			b, _ := io.ReadAll(res.Body)
			t.Fatalf("begin: %d %s", res.StatusCode, b)
		}
		u, _ := url.Parse(res.Header.Get("Location"))
		wantPath := "/protocol/openid-connect/auth"
		if mode == "register" {
			wantPath = "/protocol/openid-connect/registrations"
		}
		if u.Scheme+"://"+u.Host != issuer || u.Path != wantPath || u.Query().Get("client_id") != g.Config.AccountClientID || u.Query().Get("code_challenge_method") != "S256" || u.Query().Get("prompt") != "" || u.Query().Get("scope") != "openid email" {
			t.Fatalf("authorization URL: %s", u)
		}
		mu.Lock()
		nonce, challenge = u.Query().Get("nonce"), u.Query().Get("code_challenge")
		behavior = ""
		mu.Unlock()
		if nonce == "" || challenge == "" {
			t.Fatal("nonce/PKCE missing")
		}
		return res.Cookies()[0], u.Query().Get("state")
	}
	callback := func(login *http.Cookie, state string, prior ...*http.Cookie) *http.Response {
		t.Helper()
		cookies := append([]*http.Cookie{login}, prior...)
		return request("GET", "/v1/account/callback?code=fixture-code&state="+url.QueryEscape(state), "", cookies...)
	}
	type snapshot struct {
		State, CSRFToken    string
		GalaxyAuthorization bool
		ExpiresAt           int64
		LinkedIDs           []any
		NextAfter           *string
		Account             struct {
			ID, UID                         string
			DisplayName, SubjectType, Email *string
			EmailVerified                   bool
		}
	}
	read := func(path string, cookie *http.Cookie) snapshot {
		t.Helper()
		res := request("GET", path, "", cookie)
		var s snapshot
		if e := json.NewDecoder(res.Body).Decode(&s); e != nil || res.StatusCode != 200 {
			t.Fatalf("session: %d %v", res.StatusCode, e)
		}
		return s
	}
	login, state := begin("login")
	res := callback(login, state)
	if res.StatusCode != 303 || res.Header.Get("Location") != g.Config.WebsiteOrigin+"/app/account?tab=profile" || len(res.Cookies()) != 1 {
		t.Fatalf("callback: %d %s", res.StatusCode, res.Header.Get("Location"))
	}
	session := res.Cookies()[0]
	if !session.Secure || !session.HttpOnly || session.Name != "__Host-galaxy-account" || session.MaxAge != 2592000 {
		t.Fatalf("session cookie: %#v", session)
	}
	s := read("/v1/account/session?after=", session)
	if s.State != "signed-in" || s.GalaxyAuthorization || s.Account.ID == "" || s.Account.UID == "" || s.Account.SubjectType == nil || *s.Account.SubjectType != "person" || s.Account.Email == nil || *s.Account.Email != "person@example.invalid" || !s.Account.EmailVerified || len(s.LinkedIDs) != 0 || s.NextAfter != nil {
		t.Fatalf("first account snapshot: %+v", s)
	}
	sAfter := read("/v1/account/session?after=GUID"+strings.Repeat("A", 28), session)
	if sAfter.Account.ID != s.Account.ID || len(sAfter.LinkedIDs) != 0 {
		t.Fatal("after changed account")
	}
	var cipher string
	var profiles, identities int
	if e = pool.QueryRow(ctx, "SELECT refresh_cipher FROM official_account_sessions_v1 WHERE scope_hash=$1 AND token_hash=$2", g.Config.AccountScope, identity.Digest([]byte(session.Value))).Scan(&cipher); e != nil || cipher == "" || strings.Contains(cipher, "fixture-account-refresh") {
		t.Fatalf("renewal cipher: %v", e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM official_account_profiles_v1 WHERE account_id=$1", s.Account.ID).Scan(&profiles); e != nil || profiles != 1 {
		t.Fatalf("first profile %d %v", profiles, e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM external_identity_links WHERE endpoint=$1", g.Config.Endpoint).Scan(&identities); e != nil || identities != 0 {
		t.Fatal("login created Galaxy identity authority")
	}
	// Existing account/profile are retained across a second signed registration callback.
	if _, e = pool.Exec(ctx, "UPDATE official_account_profiles_v1 SET display_name='Preserved profile' WHERE account_id=$1", s.Account.ID); e != nil {
		t.Fatal(e)
	}
	login, state = begin("register", session)
	res = callback(login, state, session)
	if len(res.Cookies()) != 1 {
		t.Fatalf("registration callback: %s", res.Header.Get("Location"))
	}
	session = res.Cookies()[0]
	again := read("/v1/account/session", session)
	if again.Account.ID != s.Account.ID || again.Account.UID != s.Account.UID || again.Account.DisplayName == nil || *again.Account.DisplayName != "Preserved profile" {
		t.Fatalf("existing identity/profile replaced %+v", again)
	}
	// Signed but wrong nonce and an invalid PKCE exchange fail without issuing a cookie.
	for _, failure := range []string{"nonce", "pkce"} {
		login, state = begin("login", session)
		mu.Lock()
		behavior = failure
		if failure == "pkce" {
			challenge = "wrong-pkce"
		}
		mu.Unlock()
		res = callback(login, state, session)
		if len(res.Cookies()) != 0 || !strings.Contains(res.Header.Get("Location"), "accountLogin=failed") {
			t.Fatalf("%s failure issued session: %s", failure, res.Header.Get("Location"))
		}
		before := exchanges.Load()
		_ = callback(login, state, session)
		if exchanges.Load() != before {
			t.Fatal("failed callback replay exchanged again")
		}
		if current := read("/v1/account/session", session); current.State != "signed-in" || current.Account.ID != s.Account.ID {
			t.Fatal("failed login discarded existing session")
		}
	}
	login, state = begin("login", session)
	before := exchanges.Load()
	res = request("GET", "/v1/account/callback?error=access_denied&state="+url.QueryEscape(state), "", login, session)
	if !strings.Contains(res.Header.Get("Location"), "accountLogin=cancelled") || len(res.Cookies()) != 0 || exchanges.Load() != before {
		t.Fatal("cancel recovery lost")
	}
	if validPKCE.Load() != 3 {
		t.Fatalf("valid PKCE exchanges=%d", validPKCE.Load())
	}
	res = request("POST", "/v1/account/logout", again.CSRFToken, session, login)
	if res.StatusCode != 200 || len(res.Cookies()) != 2 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("logout: %d %s", res.StatusCode, b)
	}
	if signedOut := read("/v1/account/session", session); signedOut.State != "signed-out" || signedOut.GalaxyAuthorization {
		t.Fatal("logout session active")
	}
}
