package access

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/feedbackfixture"
	"github.com/jackc/pgx/v5"
)

func TestAccountLoginTransactionsInteropReplacementAndFences(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	feedbackfixture.Create(t, pool)
	ctx := context.Background()
	g := &Gateway{Pool: pool, Config: Config{Endpoint: "https://account.example.invalid", WebsiteOrigin: "https://web.example.invalid", AccountIssuer: "https://issuer.example.invalid/realms/users", AccountScope: strings.Repeat("a", 64), AssociationClients: []string{"association"}}, Now: func() time.Time { return time.Unix(2000000000, 0) }}
	hash := func(s string) string { return identity.Digest([]byte(s)) }
	preview := func(s string) portal.Preview {
		return portal.Preview{AuthorizationURL: "https://issuer.example.invalid/realms/users/protocol/openid-connect/auth?state=" + s, ExpiresAt: g.now() + 300}
	}
	create := func(key, state, previous, seen string) {
		t.Helper()
		if _, e := g.createAccountLogin(ctx, hash(key), preview(state), g.Config.WebsiteOrigin+"/app/account", previous, seen); e != nil {
			t.Fatal(e)
		}
	}
	principal := portal.Principal{Issuer: g.Config.AccountIssuer, Subject: "original-subject", EmailVerified: true}
	issue := func(key, token string) error {
		return g.issueAccountSession(ctx, hash(key), hash(token), "", strings.Repeat("c", 43), principal, 3600)
	}
	create("first", "state-first", "", "")
	if _, e := g.claimAccountLogin(ctx, hash("first"), "wrong"); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatalf("wrong-state consumed login: %v", e)
	}
	var wg sync.WaitGroup
	var claimed atomic.Int32
	for range 8 {
		wg.Go(func() {
			if _, e := g.claimAccountLogin(ctx, hash("first"), "state-first"); e == nil {
				claimed.Add(1)
			} else if !errors.Is(e, pgx.ErrNoRows) {
				t.Error(e)
			}
		})
	}
	wg.Wait()
	if claimed.Load() != 1 {
		t.Fatalf("claims=%d", claimed.Load())
	}
	if e := issue("first", "token-first"); e != nil {
		t.Fatal(e)
	}
	// Fixed fields from the captured original session projection; the account ID
	// remains the one actually created by the current transaction.
	var accountID, issuer, subject, csrf, state string
	var verified bool
	var created, expires int64
	e := pool.QueryRow(ctx, `SELECT account_id::text,issuer,external_subject,email_verified,csrf_token,created_at,expires_at,refresh_state FROM official_account_sessions_v1 WHERE scope_hash=$1 AND token_hash=$2`, g.Config.AccountScope, hash("token-first")).Scan(&accountID, &issuer, &subject, &verified, &csrf, &created, &expires, &state)
	if e != nil || accountID == "" || issuer != principal.Issuer || subject != principal.Subject || !verified || csrf != strings.Repeat("c", 43) || created != 2000000000 || expires != 2000003600 || state != "ready" {
		t.Fatalf("captured original session fields differ: %v", e)
	}
	create("seen-successor", "state-seen", hash("first"), hash("token-first"))
	var revoked *int64
	if e = pool.QueryRow(ctx, "SELECT revoked_at FROM official_account_sessions_v1 WHERE scope_hash=$1 AND token_hash=$2", g.Config.AccountScope, hash("token-first")).Scan(&revoked); e != nil || revoked != nil {
		t.Fatalf("observed session lost %v", e)
	}
	create("unseen-successor", "state-unseen", hash("first"), "")
	if e = pool.QueryRow(ctx, "SELECT revoked_at FROM official_account_sessions_v1 WHERE scope_hash=$1 AND token_hash=$2", g.Config.AccountScope, hash("token-first")).Scan(&revoked); e != nil || revoked == nil {
		t.Fatalf("unseen issuance retained %v", e)
	}
	// Replacement while token exchange is in flight prevents late issuance.
	if _, e = g.claimAccountLogin(ctx, hash("seen-successor"), "state-seen"); e != nil {
		t.Fatal(e)
	}
	create("replacement", "state-replacement", hash("seen-successor"), "")
	if e = issue("seen-successor", "late-token"); e == nil {
		t.Fatal("replaced exchange issued")
	}
	// Principal revocation fences an already-started callback, and rolls back its account writes.
	create("fenced", "state-fenced", "", "")
	if _, e = g.claimAccountLogin(ctx, hash("fenced"), "state-fenced"); e != nil {
		t.Fatal(e)
	}
	principal.Subject = "not-yet-created"
	if _, e = g.RevokeAccountSessions(ctx, "", principal.Issuer, principal.Subject); e != nil {
		t.Fatal(e)
	}
	if e = issue("fenced", "fenced-token"); e == nil {
		t.Fatal("revoked callback issued")
	}
	var n int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM community_accounts WHERE endpoint=$1 AND external_subject=$2", g.Config.Endpoint, principal.Subject).Scan(&n); e != nil || n != 0 {
		t.Fatalf("fence did not roll back account: %d %v", n, e)
	}
	create("post-fence", "state-post", "", "")
	if _, e = g.claimAccountLogin(ctx, hash("post-fence"), "state-post"); e != nil {
		t.Fatal(e)
	}
	if e = issue("post-fence", "post-token"); e != nil {
		t.Fatal(e)
	}
	// Plain portal login does not create a Galaxy device identity/binding.
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM external_identity_links WHERE endpoint=$1", g.Config.Endpoint).Scan(&n); e != nil || n != 0 {
		t.Fatalf("login granted galaxy identity: %d %v", n, e)
	}
	// Session projection uses stored UID/profile and keeps Galaxy authorization false.
	var id string
	if e = pool.QueryRow(ctx, "SELECT account_id::text FROM official_account_sessions_v1 WHERE scope_hash=$1 AND token_hash=$2", g.Config.AccountScope, hash("post-token")).Scan(&id); e != nil {
		t.Fatal(e)
	}
	var uid string
	if e = pool.QueryRow(ctx, "SELECT uid FROM community_accounts WHERE id=$1", id).Scan(&uid); e != nil {
		t.Fatal(e)
	}

	// A valid raw cookie is required; insert one with known bytes for HTTP paths.
	token := strings.Repeat("t", 43)
	if _, e = pool.Exec(ctx, "UPDATE official_account_sessions_v1 SET token_hash=$3 WHERE scope_hash=$1 AND token_hash=$2", g.Config.AccountScope, hash("post-token"), hash(token)); e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest("GET", g.Config.Endpoint+"/v1/account/session", nil)
	r.Header.Set("Cookie", g.cookie("account")+"="+token)
	projection, e := g.accountSession(r)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(projection)
	var result struct {
		State               string
		GalaxyAuthorization bool
		Account             struct{ ID, UID string }
	}
	_ = json.Unmarshal(b, &result)
	if result.State != "signed-in" || result.GalaxyAuthorization || result.Account.ID != id || result.Account.UID != uid {
		t.Fatalf("projection %s", b)
	}
	// Logout invalidates both the displayed session and a callback committed before its response arrived.
	create("logout-pending", "state-logout", "", "")
	if _, e = g.claimAccountLogin(ctx, hash("logout-pending"), "state-logout"); e != nil {
		t.Fatal(e)
	}
	loginToken := strings.Repeat("l", 43)
	if _, e = pool.Exec(ctx, "UPDATE official_account_logins_v1 SET login_hash=$3 WHERE scope_hash=$1 AND login_hash=$2", g.Config.AccountScope, hash("logout-pending"), hash(loginToken)); e != nil {
		t.Fatal(e)
	}
	r = httptest.NewRequest("POST", g.Config.Endpoint+"/v1/account/logout", nil)
	r.Header.Set("Cookie", g.cookie("account")+"="+token+"; "+g.accountLoginCookie()+"="+loginToken)
	r.Header.Set("Origin", g.Config.WebsiteOrigin)
	r.Header.Set("X-Galaxy-Account-CSRF", strings.Repeat("c", 43))
	w := httptest.NewRecorder()
	if _, e = g.accountLogout(w, r); e != nil {
		t.Fatal(e)
	}
	if len(w.Result().Cookies()) != 2 {
		t.Fatal("logout cookies missing")
	}
	if e = g.issueAccountSession(ctx, hash(loginToken), hash("after-logout"), "", strings.Repeat("c", 43), principal, 3600); e == nil {
		t.Fatal("logout undone by callback")
	}
}
func TestAccountReturnTargets(t *testing.T) {
	g := &Gateway{Config: Config{WebsiteOrigin: "https://website.example.invalid"}}
	for _, value := range []string{"//evil.invalid/app/a", "/app/../../outside", "/app/%2e%2e/outside", "/app/a%5cb", "/app/a%00", "/app/%xx", "/app/%FF", ""} {
		if _, e := g.accountReturn(value, true); e == nil {
			t.Errorf("accepted %q", value)
		}
	}
	if got, e := g.accountReturn("/app/a/../account?tab=profile", true); e != nil || got != "https://website.example.invalid/app/account?tab=profile" {
		t.Fatalf("normal return %q %v", got, e)
	}
}

func TestAccountReturnBrowserURLSemantics(t *testing.T) {
	g := &Gateway{Config: Config{WebsiteOrigin: "https://website.example.invalid"}}
	for input, want := range map[string]string{
		"/app//account?tab=a":   "/app//account?tab=a",
		"/app/a/%2e%2e/account": "/app/account",
		"/app/a/.":              "/app/a/",
		"/app/a/..":             "/app/",
		"/app/%2Faccount":       "/app/%2Faccount",
		"/app/账户?tab=资料#简介":     "/app/%E8%B4%A6%E6%88%B7?tab=%E8%B5%84%E6%96%99#%E7%AE%80%E4%BB%8B",
		"/app/a//../account":    "/app/a/account",
	} {
		got, e := g.accountReturn(input, true)
		if e != nil || got != g.Config.WebsiteOrigin+want {
			t.Errorf("%q: got %q %v, want %q", input, got, e, want)
		}
	}
}
func TestAccountRegistrationPreservesOIDCAndRejectsOtherEndpoints(t *testing.T) {
	g := &Gateway{Config: Config{AccountIssuer: "https://issuer.example.invalid/realms/users"}}
	original := g.Config.AccountIssuer + "/protocol/openid-connect/auth?state=exact_state&code_challenge=pkce&nonce=original&redirect_uri=https%3A%2F%2Fweb.example.invalid%2Fv1%2Faccount%2Fcallback"
	got, e := g.accountRegistrationURL(original)
	if e != nil || got != strings.Replace(original, "/auth?", "/registrations?", 1) {
		t.Fatalf("registration changed parameters: %s %v", got, e)
	}
	for _, input := range []string{"https://other.example.invalid/realms/users/protocol/openid-connect/auth", g.Config.AccountIssuer + "/protocol/openid-connect/%61uth", g.Config.AccountIssuer + "/protocol/openid-connect/auth/", g.Config.AccountIssuer + "/other"} {
		if _, e = g.accountRegistrationURL(input); e == nil {
			t.Errorf("registration accepted %q", input)
		}
	}
}
func TestAccountAfterQueryValidationBeforeSessionRead(t *testing.T) {
	g := &Gateway{}
	for _, query := range []string{"after=bad", "after=GUID" + strings.Repeat("A", 27), "after=GUID" + strings.Repeat("a", 28), "after=&after=", "extra=1"} {
		r := httptest.NewRequest("GET", "https://web.example.invalid/v1/account/session?"+query, nil)
		if _, e := g.accountSession(r); e == nil {
			t.Errorf("accepted %q", query)
		}
	}
	for _, query := range []string{"", "after=", "after=GUID" + strings.Repeat("A", 28)} {
		r := httptest.NewRequest("GET", "https://web.example.invalid/v1/account/session?"+query, nil)
		if _, e := g.accountSession(r); e != nil {
			t.Errorf("valid after %q: %v", query, e)
		}
	}
}
