package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/recruitment"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRecruitmentOriginalSignedWritesCurrentSourcesAndReceipt(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	archive := fakeArchive(t)
	url := "xmpp://" + archive.listener.Addr().String()
	f := chatNativeFixture(t, dsn, url, "recruitment-server")
	ctx := context.Background()
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	clock := func() time.Time { return time.Unix(num(f, "now"), 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: clock}
	ownerToken, peerToken := str(obj(f, "owner"), "token"), str(obj(f, "peer"), "token")
	peer, e := devices.Authenticate(ctx, peerToken, "history")
	if e != nil {
		t.Fatal(e)
	}
	owner, e := devices.Authenticate(ctx, ownerToken, "history")
	if e != nil {
		t.Fatal(e)
	}
	links := &accountlinks.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Providers: []accountlinks.Provider{{Issuer: str(f, "issuer"), ClientID: "galaxy-fixture"}}, Now: clock}
	profiles := &profiles.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Now: clock}
	source := &projects.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Links: links, Profiles: profiles, Now: clock}
	inbox := &notifications.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Now: clock}
	discovery := &ContactDiscovery{Pool: pool, Devices: devices, History: &historyv2.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Profiles: profiles, Now: clock}, Endpoint: str(f, "endpoint"), Profiles: profiles, Notifications: inbox, Now: clock}
	discovery.UseProjects(source)
	policy := publicwrites.DefaultPolicy()
	obj(policy, "new")["task"] = 10
	writes := &publicwrites.Service{Pool: pool, Endpoint: str(f, "endpoint"), Links: links, Policy: policy, Now: clock}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Now: clock}
	discovery.History.(*historyv2.Service).Tasks = tasks.ReadHistoryWireWithin
	svc := &recruitment.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Projects: source, Opportunities: discovery, Tasks: tasks, Inbox: inbox, PublicWrites: writes, Now: clock}
	discovery.RecruitmentOpportunity = svc.RequireContactOpportunityWithin
	discovery.Recruitment = svc
	transport, e := NewComponentTransport(url, "gateway.example.invalid", "rooms.example.invalid", testSecret, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	if e = transport.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer transport.Stop()
	chat := &Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Links: links, Transport: transport, Rules: &businessrules.Service{Endpoint: str(f, "endpoint"), Now: clock}, Now: clock}
	contacts := &ContactService{Chat: chat, Discovery: discovery}
	server := httptest.NewServer(opportunities.Handler{Service: discovery, Next: recruitment.Handler{Service: svc, Next: ContactHandler{Service: contacts, Next: projects.Handler{Service: source}}}})
	defer server.Close()
	inputs := obj(f, "contacts")
	id := str(inputs, "recruitmentId")
	events := inputs["events"].([]any)
	compareRead := func(token string) {
		t.Helper()
		path := "/v2/recruitment/" + id
		get := func(origin string) (int, []byte) {
			t.Helper()
			req, e := http.NewRequest("GET", origin+path, nil)
			if e != nil {
				t.Fatal(e)
			}
			if token != "" {
				req.Header.Set("Authorization", "Bearer "+token)
			}
			res, e := http.DefaultClient.Do(req)
			if e != nil {
				t.Fatal(e)
			}
			defer res.Body.Close()
			raw, e := io.ReadAll(res.Body)
			if e != nil {
				t.Fatal(e)
			}
			return res.StatusCode, raw
		}
		status, raw := get(server.URL)
		var got Object
		if e = json.Unmarshal(raw, &got); e != nil || status != 200 {
			t.Fatalf("Go read status %d error %v", status, got)
		}
		status, raw = get(str(f, "origin"))
		var want Object
		if e = json.Unmarshal(raw, &want); e != nil || status != 200 {
			t.Fatalf("original read status %d", status)
		}
		same(t, got, want)
	}
	for i, v := range events {
		entry := v.(map[string]any)
		event := obj(entry, "event")
		if i == 2 {
			var scopes []byte
			if e = admin.QueryRow(ctx, "SELECT scopes FROM access_credentials WHERE token_hash=$1", peer.CredentialHash).Scan(&scopes); e != nil {
				t.Fatal(e)
			}
			if _, e = admin.Exec(ctx, "UPDATE access_credentials SET scopes='[\"history\"]' WHERE token_hash=$1", peer.CredentialHash); e != nil {
				t.Fatal(e)
			}
			status, result := chatRequest(t, server.URL, "/v2/recruitment", peerToken, entry["grant"])
			if status != 403 || str(result, "error") != "recruitment_task_scope_required" {
				t.Fatal("Task current scope", status, result)
			}
			if _, e = admin.Exec(ctx, "UPDATE access_credentials SET scopes=$2::jsonb WHERE token_hash=$1", peer.CredentialHash, scopes); e != nil {
				t.Fatal(e)
			}
		}
		status, receipt := chatRequest(t, server.URL, "/v2/recruitment", peerToken, entry["grant"])
		if status != 200 || num(receipt, "appliedRevision") != int64(i+1) {
			t.Fatal("Go signed write", i, status, receipt)
		}
		status, replay := chatRequest(t, str(f, "origin"), "/v2/recruitment", peerToken, entry["grant"])
		if status != 200 || !truth(replay, "replayed") {
			t.Fatal("original replay", i, status, replay)
		}
		delete(receipt, "replayed")
		delete(replay, "replayed")
		same(t, receipt, replay)
		compareRead(peerToken)
		compareRead("")
		query := Object{"view": "managed"}
		status, got := chatRequest(t, server.URL, "/v2/recruitment/query", peerToken, query)
		if status != 200 {
			t.Fatal(got)
		}
		status, want := chatRequest(t, str(f, "origin"), "/v2/recruitment/query", peerToken, query)
		if status != 200 {
			t.Fatal(want)
		}
		same(t, got, want)
		if i == 0 {
			global := Object{"context": inputs["context"], "purposes": []any{"conversation", "recruitment"}}
			status, globalGo := chatRequest(t, server.URL, "/v2/discovery/query", ownerToken, global)
			if status != 200 || len(globalGo["items"].([]any)) != 3 {
				t.Fatal("real global opportunities", status, globalGo)
			}
			status, globalJS := chatRequest(t, str(f, "origin"), "/v2/discovery/query", ownerToken, global)
			if status != 200 {
				t.Fatal(globalJS)
			}
			same(t, globalGo, globalJS)
			wire, e := discovery.QueryWire(ctx, &owner, global)
			if e != nil {
				t.Fatal(e)
			}
			status, originalWire, _ := attachmentHTTP(t, str(f, "origin"), "/v2/discovery/query", "POST", ownerToken, encode(global))
			if status != 200 || !bytes.Equal(bytes.TrimSpace(wire), bytes.TrimSpace(originalWire)) {
				t.Fatalf("original opportunity record member bytes differ\nGo %s\nJS %s", wire, originalWire)
			}
			firstCard := globalGo["items"].([]any)[0].(map[string]any)
			detail := Object{"context": inputs["context"], "purposes": []any{"conversation", "recruitment"}, "opportunityRef": firstCard["opportunityRef"]}
			status, detailGo := chatRequest(t, server.URL, "/v2/discovery/detail", ownerToken, detail)
			if status != 200 {
				t.Fatal("actual History detail", status, detailGo)
			}
			if len(obj(detailGo, "experience")["items"].([]any)) == 0 || str(obj(obj(detailGo, "opportunity"), "experience"), "status") != "loaded" {
				t.Fatal("real authorized Task History page was replaced by absence", detailGo)
			}
			status, detailJS := chatRequest(t, str(f, "origin"), "/v2/discovery/detail", ownerToken, detail)
			if status != 200 {
				t.Fatal(detailJS)
			}
			same(t, detailGo, detailJS)
			pageInput := Object{"context": inputs["context"], "purposes": []any{"conversation", "recruitment"}, "limit": 1}
			status, page := chatRequest(t, server.URL, "/v2/discovery/query", ownerToken, pageInput)
			if status != 200 || str(page, "nextAfter") == "" {
				t.Fatal("real cursor page", page)
			}
			after := str(page, "nextAfter")
			pageInput["after"] = after
			status, continued := chatRequest(t, server.URL, "/v2/discovery/query", ownerToken, pageInput)
			if status != 200 || continued["items"].([]any)[0].(map[string]any)["id"] == page["items"].([]any)[0].(map[string]any)["id"] {
				t.Fatal("current source continuation", status, continued)
			}
			status, prefs := chatRequest(t, str(f, "origin"), "/v1/discovery/preferences/read", peerToken, Object{})
			if status != 200 {
				t.Fatal(prefs)
			}
			status, changed := chatRequest(t, str(f, "origin"), "/v1/discovery/preferences/save", peerToken, Object{"expectedRevision": prefs["revision"], "preferences": Object{"enabled": false}})
			if status != 200 {
				t.Fatal(changed)
			}
			status, denied := chatRequest(t, server.URL, "/v2/discovery/query", ownerToken, pageInput)
			if status != 409 || str(denied, "error") != "discovery_sources_changed_retry" {
				t.Fatal("visible source change must reject old cursor", status, denied)
			}
			status, changed = chatRequest(t, str(f, "origin"), "/v1/discovery/preferences/save", peerToken, Object{"expectedRevision": changed["revision"], "preferences": Object{"enabled": true}})
			if status != 200 {
				t.Fatal(changed)
			}
			query = Object{"view": "discover", "context": inputs["context"]}
			status, got = chatRequest(t, server.URL, "/v2/recruitment/query", ownerToken, query)
			if status != 200 || len(got["items"].([]any)) != 1 {
				t.Fatal("actual opportunity", status, got)
			}
			status, want = chatRequest(t, str(f, "origin"), "/v2/recruitment/query", ownerToken, query)
			if status != 200 {
				t.Fatal(want)
			}
			same(t, got, want)
			status, sent := chatRequest(t, server.URL, "/v2/contacts", ownerToken, inputs["sendGrant"])
			if status != 200 || str(sent, "state") != "sent" {
				t.Fatal("actual recruitment contact", status, sent)
			}
		}
		if i == 1 {
			status, result := chatRequest(t, server.URL, "/v2/contacts", ownerToken, inputs["sendGrant"])
			if status != 200 || !truth(result, "replayed") {
				t.Fatal("original contact replay", status, result)
			}
		}
		grant := obj(entry, "grant")
		hash := identity.Digest([]byte(str(grant, "payloadJson")))
		path := "/v2/recruitment/" + id + "/receipt?operationId=" + str(event, "operationId") + "&payloadHash=" + hash
		status, raw, _ := attachmentHTTP(t, server.URL, path, "GET", peerToken, nil)
		var acknowledged Object
		if json.Unmarshal(raw, &acknowledged) != nil || status != 200 || str(acknowledged, "state") != "acknowledged" {
			t.Fatal("actual receipt", status, acknowledged)
		}
	}
	// Current source loss blocks ordinary replays; accepted author receipts remain.
	status, result := chatRequest(t, server.URL, "/v2/projects", peerToken, inputs["revoke"])
	if status != 200 {
		t.Fatal(result)
	}
	first := events[0].(map[string]any)
	status, result = chatRequest(t, server.URL, "/v2/projects", peerToken, inputs["offer"])
	if status != 200 {
		t.Fatal("real transfer offer", status, result)
	}
	status, result = chatRequest(t, server.URL, "/v2/projects", ownerToken, inputs["transfer"])
	if status != 200 {
		t.Fatal("real transfer acceptance", status, result)
	}
	status, result = chatRequest(t, server.URL, "/v2/recruitment", peerToken, first["grant"])
	if status != 403 || str(result, "error") != "project_role_required" {
		t.Fatal("current role cannot replay", status, result)
	}
	hash := identity.Digest([]byte(str(obj(first, "grant"), "payloadJson")))
	path := "/v2/recruitment/" + id + "/receipt?operationId=" + str(obj(first, "event"), "operationId") + "&payloadHash=" + hash
	status, raw, _ := attachmentHTTP(t, server.URL, path, "GET", peerToken, nil)
	var acknowledged Object
	if json.Unmarshal(raw, &acknowledged) != nil || status != 200 || str(acknowledged, "state") != "acknowledged" {
		t.Fatal("independent accepted receipt", status)
	}
	var count int
	if e = admin.QueryRow(ctx, "SELECT count(*) FROM task_requests").Scan(&count); e != nil || count != 1 {
		t.Fatal("recruitment created Task", count, e)
	}
}
