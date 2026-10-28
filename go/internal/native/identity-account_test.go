package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNativeAccountSignedIntentAndOriginalJournal(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := workUploadServiceFixtureDatabase(t, dsn)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now}
	owner, e := store.Owner(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var issuer, clientID string
	if e = pool.QueryRow(ctx, "SELECT issuer,client_id FROM external_identity_links WHERE subject_id=$1 LIMIT 1", owner).Scan(&issuer, &clientID); e != nil {
		t.Fatal(e)
	}
	oidc, e := portal.NewOIDC(ctx, portal.OIDCConfig{Issuer: issuer, ClientID: clientID, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	oidc.Now = now
	redirect := meta.Configuration.Endpoint + "/v1/identity/callback/forum-fixture"
	login, e := portal.NewLogin(pool, oidc, portal.LoginOptions{ID: "forum-fixture", Name: "Isolated real OIDC fixture", RedirectURI: redirect, Namespace: "isolated-native-account"})
	if e != nil {
		t.Fatal(e)
	}
	provider := &accountlinks.OIDCProvider{Description: accountlinks.Description{ID: "forum-fixture", Name: "Isolated real OIDC fixture", Issuer: issuer, ClientID: clientID, RedirectURI: redirect, Protocol: "openid-connect", Grant: "authorization_code", PKCE: "S256", Lifetime: 300}, Login: login, Now: now}
	profiles := &accounts.Service{Endpoint: meta.Configuration.Endpoint, Now: now}
	registry := &accountlinks.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Accounts: profiles, Providers: accountlinks.ProviderMetadata([]accountlinks.LoginProvider{provider}), Now: now}
	links, e := accountlinks.NewLinks(registry, []accountlinks.LoginProvider{provider}, nil)
	if e != nil {
		t.Fatal(e)
	}
	original, _ := url.Parse(meta.Origin)
	server := httptest.NewServer(accountlinks.Handler{Links: links, Next: httputil.NewSingleHostReverseProxy(original)})
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	rt, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	client := NewNativeIdentityAccounts(rt)
	providers, e := client.Read(ctx, NativeIdentityAccountRead{Action: "providers"})
	if e != nil || len(uploadRows(uploadObject(providers)["providers"])) != 1 {
		t.Fatalf("configured providers: %v", e)
	}
	// The production Native client continues to require an HTTPS authorization
	// URL. This real OIDC provider is confined to HTTP loopback: only fixture
	// setup begins its pending login directly; no production trust check changes.
	begun, e := rt.Call(ctx, "/v1/identity/begin", map[string]any{"providerId": "forum-fixture"}, ConnectionCallOptions{})
	if e != nil {
		t.Fatal(e)
	}
	callback := meta.Authorize(text(begun["authorizationUrl"]))
	response, e := http.Get(server.URL + callback)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("isolated OIDC callback status %d", response.StatusCode)
	}
	id := text(begun["loginId"])
	status, e := client.Read(ctx, NativeIdentityAccountRead{Action: "status", ID: id})
	if e != nil || uploadObject(status)["state"] != "awaiting-local-signature" {
		t.Fatalf("OIDC status: %v", e)
	}
	prepared, e := client.Prepare(ctx, "link", id)
	if e != nil {
		t.Fatal(e)
	}
	previewID := text(uploadObject(prepared)["previewId"])
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var confirms, revokes atomic.Int32
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v1/identity/confirm" {
			confirms.Add(1)
			if response.StatusCode < 200 || response.StatusCode >= 300 {
				return response, nil
			}
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		if req.URL.Path == "/v1/identity/revoke" {
			revokes.Add(1)
			if response.StatusCode < 200 || response.StatusCode >= 300 {
				return response, nil
			}
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	linked, e := client.ExecuteReviewed(ctx, previewID, &scope)
	if e != nil || uploadObject(linked)["state"] != "linked" || uploadObject(linked)["remoteResent"] != false || confirms.Load() != 1 {
		t.Fatalf("signed intent lost ACK: %v confirms=%d", e, confirms.Load())
	}
	recovered, e := NewNativeIdentityAccounts(rt).Recover(ctx, id)
	if e != nil || uploadObject(recovered)["state"] != "linked" || confirms.Load() != 1 {
		t.Fatalf("durable signed intent resent: %v", e)
	}
	// A replacement binding can read that old result, but does not replace its
	// saved signed payload or signature. This is connection recovery, not an ID.
	rt.connection.Disconnect()
	if _, e = rt.Restore(ctx); e != nil {
		t.Fatal(e)
	}
	recovered, e = NewNativeIdentityAccounts(rt).Recover(ctx, id)
	if e != nil || uploadObject(recovered)["state"] != "linked" || confirms.Load() != 1 {
		t.Fatalf("old binding result unavailable: %v", e)
	}
	prepared, e = client.Prepare(ctx, "unlink", id)
	if e != nil {
		t.Fatal(e)
	}
	revoked, e := client.ExecuteReviewed(ctx, text(uploadObject(prepared)["previewId"]), &scope)
	if e != nil || uploadObject(revoked)["state"] != "revoked" || revokes.Load() != 1 {
		t.Fatalf("unlink lost ACK: %v", e)
	}
	pending, e := client.Recover(ctx, "")
	if e != nil || len(uploadRows(uploadObject(pending)["items"])) != 0 {
		t.Fatalf("terminal account journal pending: %v", e)
	}
	transport.setHook(nil)
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	script := `import {readFile} from 'node:fs/promises';import {createNativeRuntime} from './packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';const dir=process.argv[1],origin=process.argv[2],f=JSON.parse(await readFile(dir+'/work-upload-fixture.json','utf8')),c=f.configuration;const native=await createNativeRuntime({...c,trustedKeys:new Map(Object.entries(c.trustedKeys)),fetch:(url,options)=>fetch(origin+new URL(url).pathname,options),now:()=>f.now,autoResumePrivateSync:false});console.log(JSON.stringify(await native.identityAccounts.pending()));await native.close();`
	command := exec.Command("node", "--input-type=module", "-e", script, store.Directory, server.URL)
	command.Dir = root
	var diagnostic strings.Builder
	command.Stderr = &diagnostic
	out, e := command.Output()
	if e != nil {
		t.Fatalf("original account journal reader: %v %s", e, diagnostic.String())
	}
	var originalPending map[string]any
	if e = json.Unmarshal(out, &originalPending); e != nil || len(uploadRows(originalPending["items"])) != 0 || originalPending["originalOperationRetained"] != true {
		t.Fatalf("original account journal incompatible: %v", e)
	}
}
