package native

import (
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
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

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountarchive"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// nativeGoUploadFixture performs an actual local Go binding and a signed OIDC
// association against a temporary issuer, before preparing a reviewed upload.
func nativeGoUploadFixture(t *testing.T) (*Store, workUploadFixtureMetadata, *connectionTestTransport) {
	t.Helper()
	pool, _ := testsupport.PostgreSQL(t)
	return nativeGoUploadFixtureWithPool(t, pool, false)
}
func nativeGoUploadFixtureDatabase(t *testing.T, dsn string) (*Store, workUploadFixtureMetadata, *connectionTestTransport) {
	t.Helper()
	pool, err := postgres.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return nativeGoUploadFixtureWithPool(t, pool, false)
}
func nativeGoUploadFixtureDatabasePeer(t *testing.T, dsn string) (*Store, workUploadFixtureMetadata, *connectionTestTransport) {
	t.Helper()
	pool, err := postgres.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return nativeGoUploadFixtureWithPool(t, pool, true)
}
func nativeGoUploadFixtureWithPool(t *testing.T, pool *pgxpool.Pool, peer bool) (*Store, workUploadFixtureMetadata, *connectionTestTransport) {
	t.Helper()
	ctx := context.Background()
	store, base, transport, prepared := connectionServiceFixtureWithPool(t, pool)
	now := func() time.Time { return time.Unix(base.Now, 0) }
	peerID := ""
	if peer {
		public, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		publicPEM, err := identity.PublicPEM(public)
		if err != nil {
			t.Fatal(err)
		}
		state, err := prepared.Service.ControlPublicState(ctx, prepared.Materials.Genesis.ID)
		if err != nil {
			t.Fatal(err)
		}
		chainPointer, ok := state["chainHead"].(*string)
		if !ok || chainPointer == nil {
			t.Fatal("bootstrap control chain missing")
		}
		chain := *chainPointer
		peerID = uuid.NewString()
		request := deviceauth.ControlRequest{Version: 2, OperationID: uuid.NewString(), SubjectID: prepared.Materials.Genesis.ID, Kind: "authorize-device", ExpectedEpoch: integer(state["epoch"]), PreviousEventHash: &chain, SignerKeyID: identity.Digest([]byte(prepared.Materials.PublicKeyPEM)), NewDevice: &deviceauth.ControlDevice{DeviceID: peerID, PublicKeyPEM: publicPEM, Scopes: []string{"binding"}}}
		raw, _ := json.Marshal(request)
		challenge, err := prepared.Service.ControlChallenge(ctx, raw)
		if err != nil {
			t.Fatal(err)
		}
		controller, err := identity.PrivatePEM([]byte(prepared.Materials.OwnerPrivate))
		if err != nil {
			t.Fatal(err)
		}
		signed, err := identity.SignIdentityPayload(controller, text(challenge["challenge"]), "galaxy-identity-control-v2+jws")
		if err != nil {
			t.Fatal(err)
		}
		proof, err := identity.SignIdentityPayload(private, text(challenge["challenge"]), "galaxy-identity-control-v2+jws")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = prepared.Service.ControlCommit(ctx, deviceauth.ControlCommit{OperationID: request.OperationID, ControllerSignature: signed, NewDeviceProof: &proof}); err != nil {
			t.Fatal(err)
		}
		state, err = prepared.Service.ControlPublicState(ctx, prepared.Materials.Genesis.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err = writeJSON(connectionRecordPath(store.Directory, "native-trust-identity:"+store.Endpoint+":"+prepared.Materials.Genesis.ID), state); err != nil {
			t.Fatal(err)
		}
	}
	conn, err := NewConnection(store, base.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	credential := conn.session.credential
	conn.Close()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	nonce, issuer, externalSubject := "", "", "isolated-native-account"
	oidcServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/jwks", "response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}, "code_challenge_methods_supported": []string{"S256"}})
		case "/jwks":
			json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "fixture", "alg": "RS256", "use": "sig", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
		case "/token":
			r.ParseForm()
			if r.Form.Get("code") != "isolated-code" || len(r.Form.Get("code_verifier")) < 43 {
				w.WriteHeader(400)
				return
			}
			h, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": "fixture", "typ": "JWT"})
			c, _ := json.Marshal(map[string]any{"iss": issuer, "sub": externalSubject, "aud": "fixture-account-links", "iat": base.Now, "exp": base.Now + 600, "nonce": nonce, "email_verified": true})
			input := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
			digest := sha256.Sum256([]byte(input))
			signature, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
			json.NewEncoder(w).Encode(map[string]any{"access_token": "synthetic-access-token", "token_type": "Bearer", "expires_in": 600, "id_token": input + "." + base64.RawURLEncoding.EncodeToString(signature)})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(oidcServer.Close)
	issuer = oidcServer.URL
	oidc, err := portal.NewOIDC(ctx, portal.OIDCConfig{Issuer: issuer, ClientID: "fixture-account-links", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	oidc.Now = now
	redirect := base.Configuration.Endpoint + "/v1/identity/callback/fixture"
	login, err := portal.NewLogin(pool, oidc, portal.LoginOptions{ID: "fixture", Name: "isolated", RedirectURI: redirect, Namespace: "isolated-native-upload"})
	if err != nil {
		t.Fatal(err)
	}
	description := accountlinks.Description{"fixture", "isolated", issuer, "fixture-account-links", redirect, "openid-connect", "authorization_code", "S256", 300}
	provider := &accountlinks.OIDCProvider{Description: description, Login: login, Now: now}
	providers := accountlinks.ProviderMetadata([]accountlinks.LoginProvider{provider})
	profiles := &accounts.Service{Endpoint: base.Configuration.Endpoint, Now: now}
	registry := &accountlinks.Service{Pool: pool, Endpoint: base.Configuration.Endpoint, Devices: prepared.Service, Accounts: profiles, Providers: providers, Now: now}
	links, err := accountlinks.NewLinks(registry, []accountlinks.LoginProvider{provider}, nil)
	if err != nil {
		t.Fatal(err)
	}
	linkServer := httptest.NewServer(accountlinks.Handler{Links: links})
	t.Cleanup(linkServer.Close)
	call := func(method, path string, input any) map[string]any {
		t.Helper()
		var raw []byte
		if input != nil {
			raw, _ = json.Marshal(input)
		}
		req, e := http.NewRequest(method, linkServer.URL+path, strings.NewReader(string(raw)))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Content-Type", "application/json")
		if method == "POST" {
			req.Header.Set("Authorization", "Bearer "+credential)
		}
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		var v map[string]any
		if e = json.Unmarshal(body, &v); e != nil || res.StatusCode != 200 {
			t.Fatalf("account link %s: %d %s %v", path, res.StatusCode, body, e)
		}
		return v
	}
	begin := call("POST", "/v1/identity/begin", map[string]any{"providerId": "fixture"})
	authorization, err := url.Parse(text(begin["authorizationUrl"]))
	if err != nil {
		t.Fatal(err)
	}
	nonce = authorization.Query().Get("nonce")
	result := call("GET", "/v1/identity/callback/fixture?code=isolated-code&state="+url.QueryEscape(authorization.Query().Get("state")), nil)
	if result["state"] != "awaiting-local-signature" {
		t.Fatal(result)
	}
	pending := call("POST", "/v1/identity/status", map[string]any{"id": begin["loginId"]})
	private, err := identity.PrivatePEM([]byte(prepared.Materials.OwnerPrivate))
	if err != nil {
		t.Fatal(err)
	}
	signature, err := identity.SignIdentityPayload(private, text(pending["payloadJson"]), "galaxy-identity-link+jws")
	if err != nil {
		t.Fatal(err)
	}
	linked := call("POST", "/v1/identity/confirm", map[string]any{"id": begin["loginId"], "signed": signature})
	if linked["state"] != "linked" {
		t.Fatal(linked)
	}
	archives := &accountarchive.Service{Pool: pool, Endpoint: base.Configuration.Endpoint, Now: now, Devices: prepared.Service, Registry: registry, Profiles: profiles}
	server := httptest.NewServer(accountarchive.Handler{Service: archives, Devices: prepared.Service, Next: deviceauth.Handler{Service: prepared.Service}})
	t.Cleanup(server.Close)
	base.Origin = server.URL
	transport.origin, err = url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	rt, err := NewRuntime(store, base.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	if _, err = rt.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	upload := NewWorkUpload(rt)
	available, err := upload.Accounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	accountsList := uploadRows(uploadObject(available)["accounts"])
	if len(accountsList) != 1 {
		t.Fatal(available)
	}
	target := text(uploadObject(accountsList[0])["accountId"])
	scope, err := store.ChoiceScope(ctx)
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.RecordWorkNote(ctx, WorkNoteInput{GalaxyID: scope.Owner, Host: "opencode", SessionID: "opaque-session", Text: "Synthetic isolated work statement"})
	if err != nil {
		t.Fatal(err)
	}
	workID := text(uploadObject(note)["workId"])
	if _, err = upload.ChooseReviewed(ctx, WorkUploadChoice{ChoiceID: uuid.NewString(), Enabled: true, TargetAccountID: target, WorkIDs: []string{workID}, IncludeExisting: true}, &scope); err != nil {
		t.Fatal(err)
	}
	selected, err := upload.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	job, err := upload.Prepare(ctx, workID)
	if err != nil {
		t.Fatal(err)
	}
	selected, err = upload.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	operation := text(uploadObject(job)["operationId"])
	var data string
	if err = upload.queue(ctx, false, scope.Owner, &scope, func(db *sql.DB, _ string) error {
		return db.QueryRowContext(ctx, "SELECT data_json FROM work_sync_jobs WHERE id=?", operation).Scan(&data)
	}); err != nil {
		t.Fatal(err)
	}
	meta := workUploadFixtureMetadata{connectionFixtureMetadata: base, OperationID: operation, UnknownID: uuid.NewString(), WorkID: workID, TargetID: target, DataJSON: data, Settings: uploadObject(selected), PeerDeviceID: peerID}
	meta.Authorize = func(raw string) string {
		target, err := url.Parse(raw)
		if err != nil || target.Scheme+"://"+target.Host != issuer {
			t.Fatal("unexpected isolated issuer", err)
		}
		nonce = target.Query().Get("nonce")
		externalSubject = "isolated-native-account-two"
		return "/v1/identity/callback/forum-fixture?code=isolated-code&state=" + url.QueryEscape(target.Query().Get("state"))
	}
	return store, meta, transport
}
