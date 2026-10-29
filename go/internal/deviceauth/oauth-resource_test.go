package deviceauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
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
func TestOriginalOAuthIntrospectionActualBoundTransport(t *testing.T) {
	a := newOAuthFixtureAS(t)
	v := a.verifier(t)
	ctx := context.Background()
	for _, mode := range []string{"", "jwt", "jwt-bad-alg", "missing-active", "redirect", "oversize"} {
		a.reset()
		a.mu.Lock()
		a.mode = mode
		a.mu.Unlock()
		claim, e := v.Verify(ctx, "resource-token")
		if mode != "" && mode != "jwt" {
			if fault.Code(e) != "oauth_introspection_unavailable" {
				t.Errorf("%s: expected unavailable, got %v", mode, e)
			}
		} else if e != nil || claim.Issuer != a.server.URL || claim.Subject != "external" || claim.ClientID != "mcp-client" || claim.Resource != v.Resource() || claim.ExpiresAt != 2000000120 || !equalJSON(claim.Scopes, []string{"openid", "galaxy:binding", "galaxy:history", "galaxy:proof"}) {
			t.Errorf("%s: original claim mismatch: %+v %v", mode, claim, e)
		}
	}
	for field, value := range map[string]any{"active": false, "sub": strings.Repeat("😀", 256), "client_id": "unapproved", "scope": "galaxy:binding galaxy:binding", "aud": []any{"wrong"}, "iss": "https://wrong.example.invalid", "token_type": "DPoP", "exp": 2000000000} {
		a.reset()
		a.mu.Lock()
		a.claims[field] = value
		a.mu.Unlock()
		_, e := v.Verify(ctx, "resource-token")
		if fault.Code(e) != "invalid_token" {
			t.Errorf("%s: expected invalid token, got %v", field, e)
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
	m := prepareControlFixture(t, admin, dir, true)
	fixture, e := Load(ctx, admin, Configuration{Endpoint: "https://device.example.invalid", SigningKeyFile: filepath.Join(dir, "hub-private.pem"), SigningKeyID: "fixture", RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: func() time.Time { return time.Unix(2000000000, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	key, e := identity.PrivatePEM([]byte(m.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	challenge, e := fixture.BindingChallenge(ctx, BindingInput{SubjectID: m.Genesis.ID, GenesisProof: m.Genesis.GenesisProof, InstallationID: m.InstallationID, Scopes: []string{"binding", "history"}, Control: &BindingControl{DeviceID: m.DeviceID, KeyID: identity.Digest([]byte(m.PublicKeyPEM)), Epoch: 1}}, true)
	if e != nil {
		t.Fatal(e)
	}
	signature, e := identity.SignIdentityPayload(key, challenge["challenge"], "galaxy-binding-response+jws")
	if e != nil {
		t.Fatal(e)
	}
	bound, e := fixture.Bind(ctx, BindInput{Challenge: challenge["challenge"], ClientSession: challenge["clientSession"], Signature: signature}, nil)
	if e != nil {
		t.Fatal(e)
	}
	// The account-links suite exercises the actual OIDC confirmation. Here the
	// existing synthetic association isolates the resource authorization path.
	linkID := uuid.NewString()
	payload := `{"fixture":"verified-association"}`
	linkSignature, e := identity.SignIdentityPayload(key, payload, "galaxy-identity-link+jws")
	if e != nil {
		t.Fatal(e)
	}
	_, e = admin.Exec(ctx, `INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature) VALUES($1,$2,$3,$4,'original',$5,'external','linked-client',$6,$7,$8)`, linkID, m.Genesis.ID, bound.BindingID, "https://device.example.invalid", a.server.URL, payload, identity.Digest([]byte(payload)), linkSignature)
	if e != nil {
		t.Fatal(e)
	}
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
	if result.Actor.SubjectID != m.Genesis.ID || result.Actor.BindingID != bound.BindingID || !equalJSON(result.AuthInfo.Scopes, []string{"galaxy:binding", "galaxy:history"}) || result.AuthInfo.ClientID != "mcp-client" || result.AuthInfo.Resource != authority.verifier.Resource() {
		t.Fatal("OAuth association or token projection mismatch")
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
	if e = admin.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action='oauth.access' AND client_id='mcp-client' AND audience=$1 AND object_id=$2 AND scope='history' AND binding_scopes='["binding","history"]'::jsonb AND credential_scopes='["binding","history"]'::jsonb`, authority.verifier.Resource(), linkID).Scan(&auditCount); e != nil || auditCount != 1 {
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
	_, blocked := admin.Exec(deadline, `UPDATE external_identity_links SET revoked_at=now() WHERE id=$1`, linkID)
	cancel()
	_ = tx.Rollback(ctx)
	if blocked == nil {
		t.Fatal("association revocation passed SHARE fence")
	}
	_, e = admin.Exec(ctx, `UPDATE external_identity_links SET revoked_at=now() WHERE id=$1`, linkID)
	if e != nil {
		t.Fatal(e)
	}
	if e = authorize(result.Actor, "history"); fault.Status(e) != 401 {
		t.Fatal("revoked link accepted in transaction")
	}
	if _, e = authority.Authenticate(ctx, "resource-token", nil); fault.Code(e) != "invalid_token" {
		t.Fatal("revoked association authenticated")
	}
	_, _ = admin.Exec(ctx, `UPDATE external_identity_links SET revoked_at=NULL WHERE id=$1`, linkID)
	_, _ = admin.Exec(ctx, `UPDATE device_authorizations SET scopes='["binding"]'::jsonb WHERE subject_id=$1`, m.Genesis.ID)
	if e = authorize(result.Actor, "history"); fault.Status(e) != 401 {
		t.Fatal("withdrawn current device scope accepted")
	}
	_, _ = admin.Exec(ctx, `UPDATE device_authorizations SET scopes='["manage-identity","binding","history"]'::jsonb WHERE subject_id=$1`, m.Genesis.ID)
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
