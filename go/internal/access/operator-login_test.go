package access

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
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/feedbackfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
)

type loginDirectory struct{}

func (loginDirectory) Roles(context.Context, string, string) ([]string, error) {
	return []string{"galaxy-admin"}, nil
}

func TestOperatorLoginIssuesOriginalSessionAndHonorsRevocationFence(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	feedbackfixture.Create(t, pool)
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	b64 := base64.RawURLEncoding.EncodeToString
	var issuer, nonce, challenge string
	var calls atomic.Int32
	as := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/jwks", "code_challenge_methods_supported": []string{"S256"}, "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/jwks":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "fixture", "n": b64(key.N.Bytes()), "e": b64(big.NewInt(int64(key.E)).Bytes())}}})
		case "/token":
			calls.Add(1)
			_ = r.ParseForm()
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if r.Form.Get("grant_type") != "authorization_code" || b64(sum[:]) != challenge {
				t.Error("invalid exchange")
				w.WriteHeader(400)
				return
			}
			h, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": "fixture"})
			b, _ := json.Marshal(map[string]any{"iss": issuer, "aud": "management", "sub": "root-subject", "nonce": nonce, "iat": time.Now().Unix(), "exp": time.Now().Unix() + 600, "name": "银河管理", "realm_access": map[string]any{"roles": []string{"galaxy-admin"}}})
			input := b64(h) + "." + b64(b)
			hash := sha256.Sum256([]byte(input))
			signature, e := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
			if e != nil {
				t.Error(e)
				w.WriteHeader(500)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-access", "token_type": "Bearer", "refresh_token": "fixture-refresh", "expires_in": 600, "id_token": input + "." + b64(signature)})
		default:
			w.WriteHeader(404)
		}
	}))
	defer as.Close()
	issuer = as.URL
	endpoint, origin := "https://api.example.invalid", "http://127.0.0.1:60000"
	if os.Getenv("GALAXY_GO_BROWSER_CHECK") == "true" {
		origin = browserOrigin(t)
	}
	operator := identity.Digest([]byte(issuer + "\x00root-subject"))
	g, e := New(pool, Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: origin, AccountIssuer: "https://accounts.example.invalid", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "galaxy-admin", ReaderRole: "galaxy-reader", Root: &Root{operator, issuer, "root-subject"}, AllowLoopbackHTTP: true}, loginDirectory{})
	if e != nil {
		t.Fatal(e)
	}
	provider, e := portal.NewOIDC(ctx, portal.OIDCConfig{Issuer: issuer, ClientID: "management", AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	g.operatorLogin, e = portal.NewLogin(pool, provider, portal.LoginOptions{ID: "operations-admin", Name: "银河运营管理", RedirectURI: origin + "/v1/operations/callback", Namespace: "operations:http-fixture", IncludeProfile: true, IncludeRoles: true, FreshLogin: true, Renewal: true})
	if e != nil {
		t.Fatal(e)
	}
	g.OperatorRenewal, e = portal.New(pool, "operator", []string{endpoint, g.Config.OperatorConfiguration}, portal.Policy{Key: make([]byte, 32), IdleSeconds: 604800, MaximumSeconds: 2592000, RefreshBeforeSeconds: 60}, provider)
	if e != nil {
		t.Fatal(e)
	}
	events := &webevents.Service{Pool: pool, Endpoint: endpoint, Authority: NewWebEventAuthority(g)}
	defer events.Stop()
	server := httptest.NewServer(g.SessionHandler(feedback.Handler{Service: &feedback.Service{Pool: pool, Endpoint: endpoint}, Identity: g, Next: webevents.Handler{Service: events}}))
	defer server.Close()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(path string, cookies ...*http.Cookie) *http.Response {
		t.Helper()
		r, _ := http.NewRequest("GET", server.URL+path, nil)
		r.Header.Set("Origin", origin)
		for _, c := range cookies {
			r.AddCookie(c)
		}
		response, e := client.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		return response
	}
	begin := func() (*http.Cookie, string) {
		t.Helper()
		response := get("/v1/operations/login?returnTo=%2Fadmin%2Foperations%2Ffeedback")
		defer response.Body.Close()
		if response.StatusCode != 303 || len(response.Cookies()) != 1 {
			t.Fatalf("begin status %d", response.StatusCode)
		}
		u, _ := url.Parse(response.Header.Get("Location"))
		nonce, challenge = u.Query().Get("nonce"), u.Query().Get("code_challenge")
		return response.Cookies()[0], u.Query().Get("state")
	}
	loginCookie, state := begin()
	response := get("/v1/operations/callback?code=fixture-code&state="+url.QueryEscape(state), loginCookie)
	_ = response.Body.Close()
	if response.StatusCode != 303 || response.Header.Get("Location") != origin+"/admin/operations/feedback" || len(response.Cookies()) != 1 {
		t.Fatalf("callback status=%d target=%s", response.StatusCode, response.Header.Get("Location"))
	}
	session := response.Cookies()[0]
	if !session.HttpOnly || session.MaxAge != 2592000 {
		t.Fatal("session protection or expiry lost")
	}
	response = get("/v1/operations/session", session)
	var snapshot map[string]any
	_ = json.NewDecoder(response.Body).Decode(&snapshot)
	_ = response.Body.Close()
	if response.StatusCode != 200 || snapshot["state"] != "signed-in" {
		t.Fatalf("issued session unusable %v", snapshot)
	}
	var encrypted string
	if e = pool.QueryRow(ctx, "SELECT refresh_cipher FROM operations_operator_sessions_v1 WHERE operator_id=$1", operator).Scan(&encrypted); e != nil || encrypted == "" || strings.Contains(encrypted, "fixture-refresh") {
		t.Fatal("refresh material missing or stored as plaintext")
	}
	if os.Getenv("GALAXY_GO_BROWSER_CHECK") == "true" {
		checkFeedbackBrowser(t, g, server.URL, session, dsn)
	}
	before := calls.Load()
	response = get("/v1/operations/callback?code=fixture-code&state="+url.QueryEscape(state), loginCookie)
	_ = response.Body.Close()
	if calls.Load() != before || len(response.Cookies()) != 0 {
		t.Fatal("callback replay issued another session")
	}
	loginCookie, state = begin()
	_, e = pool.Exec(ctx, `INSERT INTO operations_management_login_fences_v1(endpoint,issuer,external_subject,revoked_before) VALUES($1,$2,'root-subject',clock_timestamp())`, endpoint, issuer)
	if e != nil {
		t.Fatal(e)
	}
	response = get("/v1/operations/callback?code=fixture-code&state="+url.QueryEscape(state), loginCookie)
	_ = response.Body.Close()
	if response.Header.Get("Location") != origin+"/admin/login?reason=denied" || len(response.Cookies()) != 0 {
		t.Fatal("revoked in-flight login revived a session")
	}
	response = get("/v1/operations/login?returnTo=%2F%2Fexternal.invalid%2Fadmin")
	_ = response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("external return target accepted")
	}
}
