package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/hubs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestNativeHubOriginalToolsActualGoSourceAndChoice(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := nativeGoUploadFixtureDatabase(t, dsn)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	devices := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now}
	bs := &builders.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Now: now}
	hs := &hubs.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Builders: bs, Now: now}
	origin, _ := url.Parse(meta.Origin)
	fallback := httputil.NewSingleHostReverseProxy(origin)
	next := hubs.Handler{Service: hs, Devices: devices, Next: builders.Handler{Service: bs, Devices: devices, Next: fallback}}
	consents := deviceauth.Handler{Service: devices, Next: next}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/consents" || r.URL.Path == "/v2/consents/receipt" {
			consents.ServeHTTP(w, r)
		} else {
			next.ServeHTTP(w, r)
		}
	}))
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	r, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	shapes := nativeSourceShape(t, "hub-source-v1.json", scope.Owner)
	hubID, declID := uuid.NewString(), uuid.NewString()
	declaration := uploadObject(shapes["declaration"])
	declaration["endpoint"] = meta.Configuration.Endpoint
	event := map[string]any{"id": declID, "builderId": hubID, "expectedRevision": 0, "kind": "declare", "declaration": declaration}
	auth, e := r.AuthorizeReviewed(ctx, map[string]any{"requestId": uuid.NewString(), "action": "builder.publish", "objectId": declID, "payloadJson": hostJSONString(event), "visibility": "Public"}, &scope)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = r.Call(ctx, "/v1/builders/events", map[string]any{"consentId": auth["consentId"], "payloadJson": auth["payloadJson"]}, ConnectionCallOptions{ExpectedScope: &scope}); e != nil {
		t.Fatal(e)
	}
	mcpServer, e := NewRuntimeToolServer(store, r)
	if e != nil {
		t.Fatal(e)
	}
	defer mcpServer.Close()
	ct, st := mcp.NewInMemoryTransports()
	ss, e := mcpServer.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	choices := 0
	client := mcp.NewClient(&mcp.Implementation{Name: "hub-native-test", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		choices++
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}}, nil
	}})
	session, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	listed, e := session.ListTools(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	names := []string{}
	for _, tool := range listed.Tools {
		if strings.HasPrefix(tool.Name, "galaxy_hub_") || tool.Name == "galaxy_native_authorize" {
			names = append(names, tool.Name)
		}
	}
	sort.Strings(names)
	want := []string{"galaxy_native_authorize"}
	for name := range remoteHubPaths {
		want = append(want, name)
	}
	sort.Strings(want)
	if len(names) != 18 || hostJSONString(names) != hostJSONString(want) {
		t.Fatal("exact original Hub tools", names)
	}
	// Malformed source choices are refused before any HTTP or user choice.
	before := transport.count()
	id := uuid.NewString()
	materialCall(t, session, "galaxy_hub_peering_sources", map[string]any{"hubId": hubID, "kind": "case-event"}, true)
	materialCall(t, session, "galaxy_hub_peering_preview", map[string]any{"hubId": hubID, "agreementId": id, "source": map[string]any{"kind": "contribution-summary", "source": map[string]any{"kind": "case-event", "id": id, "eventVersion": 1, "payloadHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "fields": []any{"role", "actorId"}}}, true)
	if transport.count() != before || choices != 0 {
		t.Fatal("invalid source reached network/choice")
	}
	draft := map[string]any{"schemaVersion": 2, "id": uuid.NewString(), "kind": "charter", "hubId": hubID, "expectedVersion": 0, "declarationId": declID, "declarationHash": a2aHash([]byte(text(auth["payloadJson"]))), "charter": shapes["charter"]}
	payload := hostJSONString(draft)
	consent := materialCall(t, session, "galaxy_native_authorize", map[string]any{"requestId": uuid.NewString(), "action": "hub.publish", "objectId": draft["id"], "payloadJson": payload, "visibility": "Public"}, false)
	if choices != 1 || consent["payloadJson"] != payload {
		t.Fatal("exact selected Hub authorization", choices)
	}
	submission := map[string]any{"consentId": consent["consentId"], "payloadJson": consent["payloadJson"]}
	receipt := materialCall(t, session, "galaxy_hub_events", submission, false)
	materialCall(t, session, "galaxy_hub_events", submission, false)
	if receipt["state"] != "recorded" || choices != 1 {
		t.Fatal("ordinary signed submit added choice", receipt, choices)
	}
	view := materialCall(t, session, "galaxy_hub_read", map[string]any{"hubId": hubID}, false)
	if view["state"] != "active" || view["taskAccessGranted"] != false || view["autonomousDomainVerified"] != false {
		t.Fatal(view)
	}
	materialCall(t, session, "galaxy_hub_manage", map[string]any{"hubId": hubID}, false)
	materialCall(t, session, "galaxy_hub_query", map[string]any{}, false)
	materialCall(t, session, "galaxy_hub_memberships", map[string]any{"hubId": hubID}, false)
	materialCall(t, session, "galaxy_hub_intake", map[string]any{"hubId": hubID}, false)
	materialCall(t, session, "galaxy_hub_receipt", map[string]any{"operationId": draft["id"], "payloadHash": a2aHash([]byte(payload))}, false)
	if _, e = r.Disconnect(ctx); e != nil {
		t.Fatal(e)
	}
	before = transport.count()
	materialCall(t, session, "galaxy_hub_query", map[string]any{}, true)
	if transport.count() != before {
		t.Fatal("disabled Native sent Hub request")
	}
}
