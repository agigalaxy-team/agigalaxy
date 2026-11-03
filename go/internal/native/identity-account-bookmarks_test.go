package native

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountsocial"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestAccountBookmarksUseSelectedLinkedAccount(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := nativeGoUploadFixtureDatabase(t, dsn)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now}
	owner, err := store.Owner(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var issuer, clientID string
	if err = pool.QueryRow(ctx, "SELECT issuer,client_id FROM external_identity_links WHERE subject_id=$1 LIMIT 1", owner).Scan(&issuer, &clientID); err != nil {
		t.Fatal(err)
	}
	profiles := &accounts.Service{Endpoint: meta.Configuration.Endpoint, Now: now}
	links := &accountlinks.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Accounts: profiles, Providers: []accountlinks.Provider{{Issuer: issuer, ClientID: clientID}}, Now: now}
	social := &accountsocial.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Links: links, Accounts: profiles, Now: now}
	original, _ := url.Parse(meta.Origin)
	httpServer := httptest.NewServer(accountsocial.Handler{Service: social, Devices: devices, Next: httputil.NewSingleHostReverseProxy(original)})
	defer httpServer.Close()
	transport.origin, _ = url.Parse(httpServer.URL)
	runtime, err := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	server := mcp.NewServer(&mcp.Implementation{Name: "account-bookmarks", Version: "1"}, nil)
	registerAccountBookmarkTools(server, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, err := server.Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
	session, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	page := materialCall(t, session, "galaxy_account_bookmarks", map[string]any{"accountId": meta.TargetID}, false)
	if page["accountId"] != meta.TargetID {
		t.Fatal("wrong account page", page)
	}
	ref := map[string]any{"kind": "person", "subjectId": owner}
	state := materialCall(t, session, "galaxy_account_bookmark_status", map[string]any{"accountId": meta.TargetID, "reference": ref}, false)
	if state["saved"] != false {
		t.Fatal("unexpected original state", state)
	}
	operation := uuid.NewString()
	command := map[string]any{"accountId": meta.TargetID, "operationId": operation, "reference": ref, "saved": false, "expectedRevision": 0}
	receipt := materialCall(t, session, "galaxy_account_bookmark_command", command, false)
	if receipt["state"] != "acknowledged" || receipt["operationId"] != operation {
		t.Fatal("missing account receipt", receipt)
	}
	again := materialCall(t, session, "galaxy_account_bookmark_receipt", map[string]any{"accountId": meta.TargetID, "operationId": operation, "payloadHash": receipt["payloadHash"]}, false)
	if !connectionEqual(receipt, again) {
		t.Fatal("original receipt changed", again)
	}
	materialCall(t, session, "galaxy_account_bookmarks", map[string]any{"accountId": uuid.NewString()}, true)
	materialCall(t, session, "galaxy_account_bookmarks", map[string]any{"accountId": meta.TargetID, "after": uuid.NewString()}, true)
}
