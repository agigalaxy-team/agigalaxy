package deviceauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type oauthFixtureAS struct {
	server *httptest.Server
	mu     sync.Mutex
	claims map[string]any
	mode   string
	calls  atomic.Int32
	t      *testing.T
}

func newOAuthFixtureAS(t *testing.T) *oauthFixtureAS {
	a := &oauthFixtureAS{t: t}
	a.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		issuer := a.server.URL
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "introspection_endpoint": issuer + "/introspect", "jwks_uri": issuer + "/jwks", "code_challenge_methods_supported": []string{"S256"}})
		case "/introspect":
			a.calls.Add(1)
			expected := "Basic " + base64.StdEncoding.EncodeToString([]byte("i%2Ed%2Dclient:isolated%2E%5F%2D+credential"))
			if r.Header.Get("Authorization") != expected {
				t.Error("original RFC7662 Basic component encoding differs")
			}
			_ = r.ParseForm()
			if r.PostForm.Get("token_type_hint") != "access_token" || r.PostForm.Get("token") == "" {
				t.Error("original introspection form differs")
			}
			switch a.mode {
			case "redirect":
				w.Header().Set("Location", issuer+"/unexpected")
				w.WriteHeader(302)
				return
			case "oversize":
				_, _ = io.WriteString(w, strings.Repeat("x", 262145))
				return
			case "missing-active":
				_ = json.NewEncoder(w).Encode(map[string]any{})
				return
			case "jwt", "jwt-bad-alg":
				alg := "RS256"
				if a.mode == "jwt-bad-alg" {
					alg = "none"
				}
				head, _ := json.Marshal(map[string]any{"typ": "application/token-introspection+jwt", "alg": alg})
				payload, _ := json.Marshal(map[string]any{"iss": issuer, "aud": "i.d-client", "iat": 2000000000, "token_introspection": a.claims})
				w.Header().Set("Content-Type", "application/token-introspection+jwt")
				_, _ = io.WriteString(w, base64.RawURLEncoding.EncodeToString(head)+"."+base64.RawURLEncoding.EncodeToString(payload)+".AA")
				return
			}
			_ = json.NewEncoder(w).Encode(a.claims)
		default:
			t.Error("introspection followed unexpected endpoint")
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(a.server.Close)
	a.reset()
	return a
}
func (a *oauthFixtureAS) reset() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.mode = ""
	a.claims = map[string]any{"active": true, "sub": "external", "client_id": "mcp-client", "exp": 2000000120, "scope": "openid galaxy:binding galaxy:history galaxy:proof", "aud": "https://device.example.invalid/mcp/personal", "iss": a.server.URL, "token_type": "Bearer"}
}
func (a *oauthFixtureAS) verifier(t *testing.T) *OAuthIntrospection {
	t.Helper()
	v, e := NewOAuthIntrospection(context.Background(), OAuthIntrospectionConfig{Issuer: a.server.URL, Resource: "https://device.example.invalid/mcp/personal", ClientID: "i.d-client", ClientSecret: "isolated._- credential", AllowedClientIDs: []string{"mcp-client"}, AllowLoopbackHTTP: true, Now: func() time.Time { return time.Unix(2000000000, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func sourceOAuth(t *testing.T, mode string, input map[string]any, env ...string) map[string]any {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	b, _ := json.Marshal(input)
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/oauth-resource-interop.mjs"), mode)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdin = strings.NewReader(string(b))
	raw, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original OAuth %s %v %s", mode, e, raw)
	}
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil {
		t.Fatal("invalid source OAuth reply")
	}
	return out
}
func TestOriginalOAuthIntrospectionActualBoundTransport(t *testing.T) {
	a := newOAuthFixtureAS(t)
	v := a.verifier(t)
	ctx := context.Background()
	input := map[string]any{"issuer": a.server.URL, "resource": v.Resource(), "token": "resource-token"}
	for _, mode := range []string{"", "jwt", "jwt-bad-alg", "missing-active", "redirect", "oversize"} {
		a.reset()
		a.mu.Lock()
		a.mode = mode
		a.mu.Unlock()
		source := sourceOAuth(t, "verify", input)
		claim, e := v.Verify(ctx, "resource-token")
		if e != nil {
			if source["error"] != fault.Code(e) {
				t.Errorf("%s Go %s JS %v", mode, fault.Code(e), source["error"])
			}
		} else {
			raw, _ := json.Marshal(map[string]any{"issuer": claim.Issuer, "subject": claim.Subject, "clientId": claim.ClientID, "resource": claim.Resource, "expiresAt": claim.ExpiresAt, "scopes": claim.Scopes})
			var expected map[string]any
			_ = json.Unmarshal(raw, &expected)
			if !equalJSON(expected, source["claim"]) {
				t.Errorf("%s original claim mismatch", mode)
			}
		}
	}
	for field, value := range map[string]any{"active": false, "sub": strings.Repeat("😀", 256), "client_id": "unapproved", "scope": "galaxy:binding galaxy:binding", "aud": []any{"wrong"}, "iss": "https://wrong.example.invalid", "token_type": "DPoP", "exp": 2000000000} {
		a.reset()
		a.mu.Lock()
		a.claims[field] = value
		a.mu.Unlock()
		source := sourceOAuth(t, "verify", input)
		_, e := v.Verify(ctx, "resource-token")
		if e == nil || fault.Code(e) != source["error"] {
			t.Errorf("%s Go %v JS %v", field, e, source["error"])
		}
	}
	a.reset()
	before := a.calls.Load()
	if _, e := v.Verify(ctx, "token with space"); fault.Code(e) != "invalid_token" || a.calls.Load() != before {
		t.Fatal("invalid token reached AS")
	}
	if _, e := v.Verify(ctx, strings.Repeat("x", 16385)); fault.Code(e) != "invalid_token" {
		t.Fatal("oversized token accepted")
	}
}
func equalJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	var aa, bb any
	_ = json.Unmarshal(x, &aa)
	_ = json.Unmarshal(y, &bb)
	x, _ = json.Marshal(aa)
	y, _ = json.Marshal(bb)
	return string(x) == string(y)
}

func TestOAuthResourceOriginalBindingAssociationAndRevocationPG(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	a := newOAuthFixtureAS(t)
	dir := t.TempDir()
	root, _ := filepath.Abs("../../..")
	setup := exec.Command("node", filepath.Join(root, "scripts/go/device-auth-interop.mjs"), "setup")
	setup.Dir = root
	setup.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_DEVICE_DIR="+dir)
	if out, e := setup.CombinedOutput(); e != nil {
		t.Fatalf("original existing control fixture %v %s", e, out)
	}
	env := []string{"GALAXY_GO_TEST_DATABASE_URL=" + dsn, "GALAXY_GO_TEST_DEVICE_DIR=" + dir}
	base := sourceOAuth(t, "setup", map[string]any{"issuer": a.server.URL}, env...)
	config, _ := pgxpool.ParseConfig(dsn)
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := int64(2000000000)
	s := &Service{Pool: pool, Endpoint: "https://device.example.invalid", Now: func() time.Time { return time.Unix(now, 0) }}
	authority, e := NewOAuthResourceAccess(s, a.verifier(t), OAuthProvider{ID: "original", Issuer: a.server.URL, ClientID: "linked-client"}, []string{"binding", "history"})
	if e != nil {
		t.Fatal(e)
	}
	rid := "33333333-3333-4333-8333-333333333333"
	result, e := authority.Authenticate(ctx, "resource-token", &rid)
	if e != nil {
		t.Fatal(e)
	}
	if result.Actor.CredentialHash != "" || len(result.Actor.Scopes) != 2 || result.Actor.Authentication.Profile != "oauth-resource" || result.AuthInfo.ExpiresAt != 2000000120 {
		t.Fatal("OAuth confused with device bearer or incorrect intersection")
	}
	source := sourceOAuth(t, "authenticate", map[string]any{"issuer": a.server.URL, "resource": authority.verifier.Resource(), "token": "resource-token"}, env...)
	projected := map[string]any{"actor": map[string]any{"subjectId": result.Actor.SubjectID, "bindingId": result.Actor.BindingID, "scopes": result.Actor.Scopes, "authentication": result.Actor.Authentication}, "authInfo": map[string]any{"clientId": result.AuthInfo.ClientID, "scopes": result.AuthInfo.Scopes, "expiresAt": result.AuthInfo.ExpiresAt, "resource": result.AuthInfo.Resource}}
	if !equalJSON(projected, source) {
		x, _ := json.Marshal(projected)
		y, _ := json.Marshal(source)
		t.Fatalf("original OAuth projection differs\nGo%s\nJS%s", x, y)
	}
	authorize := func(actor Actor, scope string) error {
		_, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) { return true, s.AuthorizeWithin(ctx, tx, actor, scope) })
		return e
	}
	if e = authorize(result.Actor, "history"); e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(result.Actor)
	var forged Actor
	_ = json.Unmarshal(raw, &forged)
	if e = authorize(forged, "history"); fault.Status(e) != 401 {
		t.Fatal("JSON reconstructed OAuth actor accepted")
	}
	if _, e = s.Authenticate(ctx, "resource-token", "history"); fault.Status(e) != 401 {
		t.Fatal("OAuth token accepted as device bearer")
	}
	var auditCount int
	if e = admin.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action='oauth.access' AND client_id='mcp-client' AND audience=$1 AND object_id=$2 AND scope='history' AND binding_scopes='["binding","history"]'::jsonb AND credential_scopes='["binding","history"]'::jsonb`, authority.verifier.Resource(), base["linkId"]).Scan(&auditCount); e != nil || auditCount != 2 {
		t.Fatalf("original OAuth audit %d %v", auditCount, e)
	}
	rollback := errors.New("owning business failure")
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
		if e = s.AuthorizeWithin(ctx, tx, result.Actor, "history"); e != nil {
			return false, e
		}
		return false, rollback
	})
	if !errors.Is(e, rollback) {
		t.Fatal(e)
	}
	var after int
	_ = admin.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action='oauth.access'`).Scan(&after)
	if after != auditCount {
		t.Fatal("business rollback retained OAuth acceptance audit")
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.AuthorizeWithin(ctx, tx, result.Actor, "history"); e != nil {
		t.Fatal(e)
	}
	deadline, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	_, blocked := admin.Exec(deadline, `UPDATE external_identity_links SET revoked_at=now() WHERE id=$1`, base["linkId"])
	cancel()
	_ = tx.Rollback(ctx)
	if blocked == nil {
		t.Fatal("association revocation passed SHARE fence")
	}
	_, e = admin.Exec(ctx, `UPDATE external_identity_links SET revoked_at=now() WHERE id=$1`, base["linkId"])
	if e != nil {
		t.Fatal(e)
	}
	if e = authorize(result.Actor, "history"); fault.Status(e) != 401 {
		t.Fatal("revoked link accepted in transaction")
	}
	if _, e = authority.Authenticate(ctx, "resource-token", nil); fault.Code(e) != "invalid_token" {
		t.Fatal("revoked association authenticated")
	}
	_, _ = admin.Exec(ctx, `UPDATE external_identity_links SET revoked_at=NULL WHERE id=$1`, base["linkId"])
	_, _ = admin.Exec(ctx, `UPDATE device_authorizations SET scopes='["binding"]'::jsonb WHERE subject_id=$1`, base["subjectId"])
	if e = authorize(result.Actor, "history"); fault.Status(e) != 401 {
		t.Fatal("withdrawn current device scope accepted")
	}
	_, _ = admin.Exec(ctx, `UPDATE device_authorizations SET scopes='["manage-identity","binding","history"]'::jsonb WHERE subject_id=$1`, base["subjectId"])
	a.mu.Lock()
	a.claims["scope"] = "galaxy:binding"
	a.mu.Unlock()
	limited, e := authority.Authenticate(ctx, "resource-token", nil)
	if e != nil {
		t.Fatal(e)
	}
	limited.Actor.Scopes = append(limited.Actor.Scopes, "history")
	if e = authorize(limited.Actor, "history"); fault.Status(e) != 401 {
		t.Fatal("mutated public scope widened credential claim")
	}
	a.reset()
	before := a.calls.Load()
	a.mu.Lock()
	a.claims["active"] = false
	a.mu.Unlock()
	if _, e = authority.Authenticate(ctx, "resource-token", nil); fault.Code(e) != "invalid_token" || a.calls.Load() != before+1 {
		t.Fatal("cached introspection ignored AS revocation")
	}
	a.reset()
	now = 2000000120
	if e = authorize(result.Actor, "binding"); fault.Status(e) != 401 {
		t.Fatal("expired stored claim accepted")
	}
}
