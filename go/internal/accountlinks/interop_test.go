package accountlinks

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
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/jackc/pgx/v5"
)

func TestOriginalDeviceOIDCSignedAssociationAndRegistryInterop(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	origin := ""
	var descriptions []Description
	node := func(script, mode string, args ...string) []byte {
		t.Helper()
		cmd := exec.Command("node", append([]string{filepath.Join(root, "scripts/go", script), mode}, args...)...)
		cmd.Dir = root
		b, _ := json.Marshal(descriptions)
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_DEVICE_DIR="+dir, "GALAXY_GO_TEST_DEVICE_ORIGIN="+origin, "GALAXY_GO_TEST_LINK_PROVIDERS="+string(b))
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original JS %s: %v %s", mode, e, out)
		}
		return out
	}
	var metadata struct{ SubjectID string }
	metadata.SubjectID = deviceauthfixture.Prepare(t, pool, dir, []string{"binding", "history"}).Materials.Genesis.ID
	api, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_api")
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	at := int64(2000000000)
	now := func() time.Time { return time.Unix(at, 0) }
	endpoint := "https://device.example.invalid"
	devices, e := deviceauth.Load(ctx, api, deviceauth.Configuration{Endpoint: endpoint, SigningKeyFile: filepath.Join(dir, "hub-private.pem"), SigningKeyID: "fixture", RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: now})
	if e != nil {
		t.Fatal(e)
	}
	handshake := httptest.NewServer(deviceauth.Handler{Service: devices})
	origin = handshake.URL
	node("device-client-fixture.mjs", "client")
	handshake.Close()
	tokenBytes, _ := os.ReadFile(filepath.Join(dir, "credential.txt"))
	token := string(tokenBytes)
	actor, e := devices.Authenticate(ctx, token, "binding")
	if e != nil {
		t.Fatal(e)
	}
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	nonce, externalSubject := "", "external-person-one"
	issuer := ""
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
			header, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": "fixture", "typ": "JWT"})
			claims, _ := json.Marshal(map[string]any{"iss": issuer, "sub": externalSubject, "aud": "fixture-account-links", "iat": at, "exp": at + 600, "nonce": nonce, "email_verified": true})
			input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
			digest := sha256.Sum256([]byte(input))
			signature, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
			json.NewEncoder(w).Encode(map[string]any{"access_token": "synthetic-access-token", "token_type": "Bearer", "expires_in": 600, "id_token": input + "." + base64.RawURLEncoding.EncodeToString(signature)})
		default:
			w.WriteHeader(404)
		}
	}))
	defer oidcServer.Close()
	issuer = oidcServer.URL
	oidc, e := portal.NewOIDC(ctx, portal.OIDCConfig{Issuer: issuer, ClientID: "fixture-account-links", AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	oidc.Now = now
	redirect := endpoint + "/v1/identity/callback/fixture"
	login, e := portal.NewLogin(api, oidc, portal.LoginOptions{ID: "fixture", Name: "隔离OIDC", RedirectURI: redirect, Namespace: "isolated-account-links"})
	if e != nil {
		t.Fatal(e)
	}
	description := Description{"fixture", "隔离OIDC", issuer, "fixture-account-links", redirect, "openid-connect", "authorization_code", "S256", 300}
	provider := &OIDCProvider{Description: description, Login: login, Now: now}
	descriptions = []Description{description}
	providers := ProviderMetadata([]LoginProvider{provider})
	registry := &Service{Pool: api, Endpoint: endpoint, Devices: devices, Providers: providers, CurrentProviders: func() []Provider { return providers }, Now: now}
	links, e := NewLinks(registry, []LoginProvider{provider}, nil)
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(Handler{Links: links})
	defer server.Close()
	call := func(method, path string, input any) (int, Object) {
		t.Helper()
		var b []byte
		if input != nil {
			b, _ = json.Marshal(input)
		}
		r, _ := http.NewRequestWithContext(ctx, method, server.URL+path, strings.NewReader(string(b)))
		r.Header.Set("Content-Type", "application/json")
		if method == "POST" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		response, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		var out Object
		if json.Unmarshal(raw, &out) != nil {
			t.Fatalf("HTTP %d invalid JSON %s", response.StatusCode, raw)
		}
		return response.StatusCode, out
	}
	link := func(subject string) (string, string) {
		t.Helper()
		externalSubject = subject
		status, preview := call("POST", "/v1/identity/begin", Object{"providerId": "fixture"})
		if status != 200 {
			t.Fatalf("begin %d %+v", status, preview)
		}
		id := preview["loginId"].(string)
		authorization, _ := url.Parse(preview["authorizationUrl"].(string))
		nonce = authorization.Query().Get("nonce")
		returned := "/v1/identity/callback/fixture?code=isolated-code&state=" + url.QueryEscape(authorization.Query().Get("state"))
		status, returnedValue := call("GET", returned, nil)
		if status != 200 || returnedValue["state"] != "awaiting-local-signature" {
			t.Fatalf("verified callback %d %+v", status, returnedValue)
		}
		status, pending := call("POST", "/v1/identity/status", Object{"id": id})
		if status != 200 {
			t.Fatalf("status %d %+v", status, pending)
		}
		payload := pending["payloadJson"].(string)
		os.WriteFile(filepath.Join(dir, "link-payload.txt"), []byte(payload), 0600)
		node("account-links-interop.mjs", "sign")
		signed, _ := os.ReadFile(filepath.Join(dir, "signed-link.txt"))
		return id, string(signed)
	}
	first, signed := link("external-person-one")
	var mappings int
	pool.QueryRow(ctx, "SELECT count(*) FROM community_account_links").Scan(&mappings)
	if mappings != 0 {
		t.Fatal("OIDC alone associated a Galaxy identity")
	}
	status, result := call("POST", "/v1/identity/confirm", Object{"id": first, "signed": signed})
	if status != 200 || result["state"] != "linked" || result["galaxyAuthorization"] != false {
		t.Fatalf("signed association %d %+v", status, result)
	}
	status, result = call("POST", "/v1/identity/confirm", Object{"id": first, "signed": signed})
	if status != 200 {
		t.Fatalf("original signed replay %d %+v", status, result)
	}
	var stored struct {
		PayloadText  string `json:"payload_text"`
		PayloadHash  string `json:"payload_hash"`
		Signature    string `json:"signature"`
		SignerKeyID  string `json:"signer_key_id"`
		ControlEpoch int    `json:"control_epoch"`
	}
	if e = pool.QueryRow(ctx, `SELECT payload_text,payload_hash,signature,signer_key_id,control_epoch FROM external_identity_links WHERE id=$1`, first).Scan(&stored.PayloadText, &stored.PayloadHash, &stored.Signature, &stored.SignerKeyID, &stored.ControlEpoch); e != nil {
		t.Fatal(e)
	}
	storedJSON, e := json.Marshal(stored)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "link-stored.json"), storedJSON, 0600); e != nil {
		t.Fatal(e)
	}
	var evidence struct {
		ExactPayload, ExactHash, Signer bool
		Epoch                           int
	}
	if e = json.Unmarshal(node("account-links-interop.mjs", "verify", first), &evidence); e != nil || !evidence.ExactPayload || !evidence.ExactHash || !evidence.Signer || evidence.Epoch != 1 {
		t.Fatalf("original JS did not verify exact Go stored link: %+v %v", evidence, e)
	}
	goAvailable := func() ([]Object, error) {
		return postgres.InTx(ctx, api, func(tx pgx.Tx) ([]Object, error) { return registry.AvailableWithin(ctx, tx, actor) })
	}
	available, e := goAvailable()
	if e != nil || len(available) != 1 {
		t.Fatalf("current association unavailable: %+v %v", available, e)
	}
	firstAccount := available[0]["id"].(string)
	view := View(available[0], "")
	if view["id"] != firstAccount || view["accountId"] != firstAccount || view["endpoint"] != endpoint || view["current"] != false {
		t.Fatalf("invalid available account view: %+v", view)
	}
	second, signed2 := link("external-person-two")
	status, result = call("POST", "/v1/identity/confirm", Object{"id": second, "signed": signed2})
	if status != 200 {
		t.Fatalf("second verified association %d %+v", status, result)
	}
	_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) { return registry.ResolveWithin(ctx, tx, actor, "", false) })
	if fault.Code(e) != "account_selection_required" {
		t.Fatalf("multiple accounts selected automatically: %v", e)
	}
	selected, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) { return registry.ResolveWithin(ctx, tx, actor, firstAccount, true) })
	if e != nil || selected["id"] != firstAccount {
		t.Fatalf("explicit target %+v %v", selected, e)
	}
	providers = nil
	available, e = goAvailable()
	if e != nil || len(available) != 0 {
		t.Fatal("removed provider remained eligible")
	}
	providers = ProviderMetadata([]LoginProvider{provider})
	status, result = call("POST", "/v1/identity/revoke", Object{"id": first})
	if status != 200 || result["state"] != "revoked" {
		t.Fatalf("revoke %d %+v", status, result)
	}
	status, result = call("POST", "/v1/identity/confirm", Object{"id": first, "signed": signed})
	if status != 200 || result["state"] != "revoked" {
		t.Fatal("replayed signature regranted revoked association")
	}
	available, e = goAvailable()
	if e != nil || len(available) != 1 || available[0]["id"] == firstAccount {
		t.Fatal("revoked association remained available")
	}
	query, e := links.Query(ctx, actor, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	items, ok := query["items"].([]Object)
	if !ok || len(items) != 2 || query["subjectId"] != actor.SubjectID || query["endpoint"] != endpoint || query["nextAfter"] != nil {
		t.Fatalf("invalid association query: %+v", query)
	}
	states := map[string]string{}
	for _, item := range items {
		if item["galaxyAuthorization"] != false || item["subjectId"] != actor.SubjectID {
			t.Fatalf("association scope: %+v", item)
		}
		states[item["id"].(string)] = item["state"].(string)
	}
	if states[first] != "revoked" || states[second] != "linked" {
		t.Fatalf("association states: %+v", states)
	}
	var audits int
	pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE actor=$1 AND action IN('identity.link','identity.unlink')", actor.SubjectID).Scan(&audits)
	if audits != 3 {
		t.Fatalf("association/revoke audit replayed: %d", audits)
	}
}
