package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDiscoveryV1OriginalProfilesCurrentPreferencesAndQuery(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	archive := fakeArchive(t)
	f := chatNativeFixture(t, dsn, "xmpp://"+archive.listener.Addr().String(), "opportunities-server")
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
	source := &opportunities.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Profiles: &profiles.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Now: clock}, Now: clock}
	server := httptest.NewServer(opportunities.Handler{Service: source})
	defer server.Close()
	peerToken := str(obj(f, "peer"), "token")
	ownerToken := str(obj(f, "owner"), "token")
	input := obj(f, "contacts")
	query := Object{"projectId": input["legacyProjectId"]}
	compare := func(path string, body Object) Object {
		t.Helper()
		status, got := chatRequest(t, server.URL, path, peerToken, body)
		if status != 200 {
			t.Fatal("Go original discovery", status, got)
		}
		status, want := chatRequest(t, str(f, "origin"), path, peerToken, body)
		if status != 200 {
			t.Fatal("original discovery", status, want)
		}
		same(t, got, want)
		return got
	}
	page := compare("/v1/discovery/query", query)
	if len(page["items"].([]any)) != 2 {
		t.Fatal("real declared-profile matches", page)
	}
	limited := compare("/v1/discovery/query", Object{"projectId": input["legacyProjectId"], "limit": 1})
	if !truth(limited, "resultLimited") || len(limited["items"].([]any)) != 1 {
		t.Fatal("original result window", limited)
	}
	status, missing := chatRequest(t, server.URL, "/v1/discovery/query", peerToken, Object{"projectId": obj(input, "project")["projectId"]})
	if status != 404 || str(missing, "error") != "discovery_project_not_found" {
		t.Fatal("V1 incorrectly expanded into ProjectV2", status, missing)
	}
	prefs := compare("/v1/discovery/preferences/read", Object{})
	status, saved := chatRequest(t, server.URL, "/v1/discovery/preferences/save", peerToken, Object{"expectedRevision": prefs["revision"], "preferences": Object{"enabled": true, "temporary": Object{"until": num(f, "now") + 100, "contact": "paused"}}})
	if status != 200 {
		t.Fatal("real preference save", status, saved)
	}
	compare("/v1/discovery/preferences/read", Object{})
	disabled := compare("/v1/discovery/query", query)
	if truth(disabled, "enabled") || len(disabled["items"].([]any)) != 0 {
		t.Fatal("current explicit pause lost", disabled)
	}
	status, conflict := chatRequest(t, server.URL, "/v1/discovery/preferences/save", peerToken, Object{"expectedRevision": prefs["revision"], "preferences": Object{"enabled": false}})
	if status != 409 || str(conflict, "error") != "notification_preferences_conflict" {
		t.Fatal("original optimistic preferences", status, conflict)
	}
	status, restored := chatRequest(t, str(f, "origin"), "/v1/discovery/preferences/save", peerToken, Object{"expectedRevision": saved["revision"], "preferences": Object{"enabled": true}})
	if status != 200 {
		t.Fatal(restored)
	}
	compare("/v1/discovery/query", query)
	// Revoke the latest source, retaining bytes; no earlier public declaration
	// may be substituted by the current profile projection.
	var consent string
	if e = admin.QueryRow(ctx, "SELECT consent_id::text FROM profile_statements WHERE subject_id=$1 ORDER BY revision DESC LIMIT 1", obj(f, "owner")["subjectId"]).Scan(&consent); e != nil {
		t.Fatal(e)
	}
	status, result := chatRequest(t, str(f, "origin"), "/v1/consents/"+consent+"/revoke", ownerToken, Object{})
	if status != 200 {
		t.Fatal(result)
	}
	revoked := compare("/v1/discovery/query", query)
	if len(revoked["items"].([]any)) != 0 {
		t.Fatal("revoked latest source remained discoverable", revoked)
	}
}
