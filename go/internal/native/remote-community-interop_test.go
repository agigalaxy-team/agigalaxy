package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountarchive"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"testing"
	"time"
)

func TestRemoteCommunityGoServicesBindingAndAnonymousSeparation(t *testing.T) {
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
	profiles := &accounts.Service{Endpoint: meta.Configuration.Endpoint, Now: now}
	links := &accountlinks.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Accounts: profiles, Providers: []accountlinks.Provider{{Issuer: issuer, ClientID: clientID}}, Now: now}
	archives := &accountarchive.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now, Devices: devices, Registry: links, Profiles: profiles}
	forum := &community.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now, DeviceAuth: devices, AccountLinks: links, IdentityProviders: []community.IdentityProvider{{Issuer: issuer, ClientID: clientID}}}
	original, _ := url.Parse(meta.Origin)
	server := httptest.NewServer(community.Handler{Service: forum, Next: accountarchive.Handler{Service: archives, Devices: devices, Next: httputil.NewSingleHostReverseProxy(original)}})
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	runtime, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	client := NewNativeCommunity(runtime)
	options, e := client.Call(ctx, "galaxy_community_account_options", map[string]any{})
	if e != nil || len(uploadRows(options["items"])) != 1 || uploadObject(uploadRows(options["items"])[0])["id"] != meta.TargetID {
		t.Fatal(options, e)
	}
	owned, e := client.Call(ctx, "galaxy_community_owned", map[string]any{})
	if e != nil || owned["items"] == nil {
		t.Fatal(owned, e)
	}
	blank, e := NewStore(filepath.Join(t.TempDir(), "blank"), meta.Configuration.Endpoint)
	if e != nil {
		t.Fatal(e)
	}
	config := meta.Configuration
	config.DataDirectory = blank.Directory
	anonymous, e := NewRuntime(blank, config, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer anonymous.Close()
	public := NewNativeCommunity(anonymous)
	result, e := public.Call(ctx, "galaxy_community_query", map[string]any{"accountId": meta.TargetID})
	if e != nil || result["items"] == nil {
		t.Fatal(result, e)
	}
	if _, e = public.Call(ctx, "galaxy_community_owned", map[string]any{}); e == nil {
		t.Fatal("blank identity read owned source")
	}
	if _, e = public.Call(ctx, "galaxy_community_account_options", map[string]any{}); e == nil {
		t.Fatal("blank identity read associated accounts")
	}
	if _, e = runtime.Disconnect(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = client.Call(ctx, "galaxy_community_owned", map[string]any{}); e == nil {
		t.Fatal("disabled connection read owned")
	}
	if _, e = client.Call(ctx, "galaxy_community_query", map[string]any{}); e != nil {
		t.Fatal("saved disable incorrectly disabled public reads", e)
	}
}
