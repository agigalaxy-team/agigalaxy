package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identityreturn"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"sync/atomic"
	"testing"
	"time"
)

func TestNativeAccountSignedIntentAndOriginalJournal(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := nativeGoUploadFixtureDatabase(t, dsn)
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
	login, e := portal.NewLogin(pool, oidc, portal.LoginOptions{ID: "forum-fixture", Name: "Isolated real OIDC fixture", RedirectURI: redirect, Namespace: "isolated-native-account", IncludeProfile: true})
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
	links.NativeIssuer = issuer
	original, _ := url.Parse(meta.Origin)
	routes := accountlinks.Handler{Links: links, Next: httputil.NewSingleHostReverseProxy(original)}
	callbackHandler, e := identityreturn.New(identityreturn.Options{Endpoint: meta.Configuration.Endpoint, Callback: func(ctx context.Context, provider, returned string) (string, error) {
		out, err := links.Callback(ctx, provider, returned)
		if out["state"] == "awaiting-native-approval" {
			return text(out["reviewPath"]), err
		}
		return text(out["state"]), err
	}, Next: routes, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	boundary, e := httpboundary.New(httpboundary.Config{Endpoint: meta.Configuration.Endpoint})
	if e != nil {
		t.Fatal(e)
	}
	handler := boundary.Handler(callbackHandler)
	// The fixture serves the production handler on loopback instead of using
	// the configured HTTPS name; preserve the expected browser Origin.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Origin") == "http://"+req.Host {
			req.Header.Set("Origin", meta.Configuration.Endpoint)
		}
		handler.ServeHTTP(w, req)
	}))
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
	for range 40 {
		client.previews[uuid.NewString()] = &nativeAccountPreview{state: "completed", expiresAt: meta.Now*1000 + 300000, lease: client.previews[previewID].lease}
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
	if uploadObject(pending)["originalOperationRetained"] != true {
		t.Fatal("terminal original operation was not retained", pending)
	}

	for _, alreadyConnected := range []bool{false, true} {
		name := "first-use-in-browser"
		if alreadyConnected {
			name = "connected-before-account"
		}
		t.Run(name, func(t *testing.T) {
			config := meta.Configuration
			config.DataDirectory = t.TempDir()
			local, err := NewStore(config.DataDirectory, config.Endpoint)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = local.Initialize(ctx, InitializationInput{SubjectType: "person"}, true, nil); err != nil {
				t.Fatal(err)
			}
			subject, err := local.Owner(ctx)
			if err != nil {
				t.Fatal(err)
			}
			runtime, err := NewRuntime(local, config, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			var beforeConnection *ConnectionSnapshot
			var beforeSelection connectionSelection
			if alreadyConnected {
				beforeConnection, err = runtime.ConnectService(ctx)
				if err != nil || beforeConnection == nil {
					t.Fatalf("service connection: %v", err)
				}
				beforeSelection, err = runtime.connection.selection(ctx)
				if err != nil {
					t.Fatal(err)
				}
			}
			browser := NewBrowserChoices(local, now)
			defer browser.Close()
			plan, err := runtime.PrepareConnect(ctx)
			if err != nil {
				t.Fatal(err)
			}
			attempt := &nativeAccountConnect{runtime: runtime, accounts: NewNativeIdentityAccounts(runtime), pending: map[ChoiceScope]*nativeAccountLogin{}}
			first, err := attempt.review(ctx, browser, plan)
			if err != nil {
				t.Fatal(err)
			}
			var login *nativeAccountLogin
			for _, value := range attempt.pending {
				login = value
			}
			redirectClient := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			redirected, err := redirectClient.Get(text(uploadObject(first)["url"]))
			if err != nil {
				t.Fatal(err)
			}
			redirected.Body.Close()
			if redirected.StatusCode != http.StatusSeeOther || redirected.Header.Get("Location") != login.loginURL {
				t.Fatal("account login introduced another local approval")
			}
			callback := meta.Authorize(login.loginURL)
			var exists bool
			if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM bindings WHERE subject_id=$1)", subject).Scan(&exists); err != nil || exists != alreadyConnected {
				t.Fatalf("login created a binding before confirmation: %v %v", exists, err)
			}
			script := `import {chromium} from 'playwright';
            const browser=await chromium.launch({headless:true});try {
            const review=await browser.newPage();await review.goto(process.argv[2]);
            await review.getByText('fixture-account@example.invalid',{exact:true}).waitFor();
            await review.getByText(process.argv[3],{exact:true}).waitFor();
            const before=await (await review.request.get(process.argv[1]+'?status=1')).json();if(before.state!=='awaiting-account')throw Error('connected without confirmation');
            await review.getByRole('button',{name:'确认关联',exact:true}).click();
            for(;;){const state=await (await review.request.get(process.argv[1]+'?status=1')).json();if(state.state==='finished')break;if(!['awaiting-account','processing'].includes(state.state))throw Error('association did not complete');await new Promise(r=>setTimeout(r,200));}
            const page=await browser.newPage();await page.goto(process.argv[1]);await page.getByText('银河账户关联已完成，可以回到原聊天。',{exact:true}).waitFor();
            console.log(JSON.stringify({confirmed:true}));} finally { await browser.close(); }`
			if initializationNode(t, script, text(uploadObject(first)["url"]), server.URL+callback, subject)["confirmed"] != true {
				t.Fatal("browser did not finish")
			}
			var linkCount int
			if err := pool.QueryRow(ctx, "SELECT count(*) FROM community_account_links WHERE subject_id=$1", subject).Scan(&linkCount); err != nil || linkCount != 1 {
				t.Fatalf("browser account link count: %d, %v", linkCount, err)
			}
			if alreadyConnected {
				afterConnection, err := runtime.connection.Snapshot(ctx)
				if err != nil || afterConnection == nil || afterConnection.BindingID != beforeConnection.BindingID || afterConnection.Generation != beforeConnection.Generation {
					t.Fatalf("account linking replaced the service connection: before=%+v after=%+v err=%v", beforeConnection, afterConnection, err)
				}
				afterSelection, err := runtime.connection.selection(ctx)
				if err != nil || afterSelection.fingerprint != beforeSelection.fingerprint || afterSelection.Revision != beforeSelection.Revision {
					t.Fatalf("account linking changed the selected identity or device: %v", err)
				}
			}
			connected, err := runtime.Status(ctx, RuntimeStatusOptions{RestoreSelected: true})
			if err != nil || connected["connected"] != true || connected["identity"] != subject {
				t.Fatalf("original runtime identity not connected: %v", err)
			}
		})
	}

}
