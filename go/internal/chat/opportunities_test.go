package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDiscoveryV1OriginalProfilesCurrentPreferencesAndQuery(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	f := chatGoIdentityFixture(t, admin)
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
	owner := f["ownerFixture"].(deviceauthfixture.Fixture)
	peer := f["peerFixture"].(deviceauthfixture.Fixture)
	profileService := &profiles.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Now: clock}
	legacyProject := uuid.NewString()
	publish := func(who deviceauthfixture.Fixture, name string, entries []any) string {
		t.Helper()
		id := uuid.NewString()
		payload := Object{"id": id, "expectedRevision": 0, "selfDeclared": Object{"displayName": name, "projects": entries}, "sharing": Object{"visibility": "Public", "viewers": []any{}, "expiresAt": num(f, "now") + 3600}}
		grant := who.Grant(t, payload, "profile.publish", id, "Public", nil)
		if _, err := profileService.Publish(ctx, who.Actor, encode(grant), ""); err != nil {
			t.Fatal("publish signed profile", err)
		}
		return grant["consentId"].(string)
	}
	publish(peer, "Parser participant", []any{Object{"id": legacyProject, "kind": "module", "title": "Legacy declared parser", "summary": "Current self-declaration", "functions": []any{"table-extraction"}, "discoverable": true}})
	ownerConsent := publish(owner, "Matching declarations", []any{Object{"id": uuid.NewString(), "kind": "module", "title": "Full overlap", "summary": "Declared only", "functions": []any{"table-extraction"}, "discoverable": true}, Object{"id": uuid.NewString(), "kind": "project", "title": "Partial overlap", "summary": "Declared only", "functions": []any{"table-extraction", "normalization"}, "technologies": []any{"Go"}, "discoverable": true}})
	for _, who := range []deviceauthfixture.Fixture{owner, peer} {
		if _, err := source.SavePreferences(ctx, who.Actor, Object{"expectedRevision": 0, "preferences": Object{"enabled": true}}, nil); err != nil {
			t.Fatal("enable discovery", err)
		}
	}
	query := Object{"projectId": legacyProject}
	compare := func(path string, body Object) Object {
		t.Helper()
		status, got := chatRequest(t, server.URL, path, peerToken, body)
		if status != 200 {
			t.Fatal("Go original discovery", status, got)
		}
		return got
	}
	page := compare("/v1/discovery/query", query)
	if len(page["items"].([]any)) != 2 {
		t.Fatal("real declared-profile matches", page)
	}
	limited := compare("/v1/discovery/query", Object{"projectId": legacyProject, "limit": 1})
	if !truth(limited, "resultLimited") || len(limited["items"].([]any)) != 1 {
		t.Fatal("original result window", limited)
	}
	status, missing := chatRequest(t, server.URL, "/v1/discovery/query", peerToken, Object{"projectId": uuid.NewString()})
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
	status, restored := chatRequest(t, server.URL, "/v1/discovery/preferences/save", peerToken, Object{"expectedRevision": saved["revision"], "preferences": Object{"enabled": true}})
	if status != 200 {
		t.Fatal(restored)
	}
	compare("/v1/discovery/query", query)
	// Revoke the latest source, retaining bytes; no earlier public declaration
	// may be substituted by the current profile projection.
	if _, e = devices.RevokeConsent(ctx, owner.Actor, ownerConsent, nil); e != nil {
		t.Fatal("revoke source", e)
	}
	revoked := compare("/v1/discovery/query", query)
	if len(revoked["items"].([]any)) != 0 {
		t.Fatal("revoked latest source remained discoverable", revoked)
	}
}
