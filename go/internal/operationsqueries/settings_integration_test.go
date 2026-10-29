package operationsqueries

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/systemsettings"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func verifySystemQuerySources(t *testing.T, ctx context.Context, q *Service, owner *pgxpool.Pool, gateway *access.Gateway, request *http.Request, human Actor, endpoint, rootID string, now func() time.Time) {
	t.Helper()
	// Actual signed Native read RPC; these fixture observations never configure
	// SMTP, test credentials, submit mail or change the user's host settings.
	mailID, credentialID, publicationID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	marker := publicationID
	key := strings.Repeat("K", 43)
	var mailReads, nativeEffects atomic.Int32
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/site-publication.json" {
			json.NewEncoder(w).Encode(Object{"version": 1, "publicationId": marker})
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/fixture-native" && r.Header.Get("X-Galaxy-Service-Signature") != maintenance.Signature(key, r.Header.Get("X-Galaxy-Request-Id"), r.Header.Get("X-Galaxy-Request-At"), raw) {
			w.WriteHeader(401)
			return
		}
		var input Object
		json.Unmarshal(raw, &input)
		if input["kind"] != "settings-overview" {
			nativeEffects.Add(1)
			w.WriteHeader(400)
			return
		}
		current, credentials := []any{}, []any{}
		if input["section"] == "mail" {
			mailReads.Add(1)
			current = append(current, Object{"target": "operations-worker", "state": "configured", "adoptedVersionId": nil, "connectionId": mailID, "source": "protected-runtime", "configured": true})
			credentials = append(credentials, Object{"reference": "system-key:" + credentialID, "connectionId": mailID, "configured": true})
		}
		json.NewEncoder(w).Encode(Object{"availability": Object{"state": "available"}, "current": current, "credentials": credentials, "observedConfiguration": nil, "capabilities": Object{"canTest": true, "canApply": true, "canWriteCredential": true}})
	}))
	defer host.Close()
	origin, _ := url.Parse(host.URL)
	native := &systemsettings.NativeClient{Client: maintenance.New(maintenance.Configuration{SocketPath: "/run/galaxy-maintenance/query-only.sock", Key: key}, maintenance.Options{Now: now, Transport: registeredProviderRoute{origin}})}
	settings := &systemsettings.Service{Pool: q.Pool, Endpoint: endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators(), Native: native, Now: now}
	configuration := Object{"connections": []any{Object{"id": mailID, "name": "Current saved mail", "host": "smtp.example.invalid", "port": 465, "tls": "implicit", "credentialRef": "system-key:" + credentialID, "connectionTimeoutMs": nil, "greetingTimeoutMs": nil, "socketTimeoutMs": nil, "maxConnections": nil, "rateLimit": nil, "rateWindowSeconds": nil, "dkimSelector": nil}}, "bindings": Object{"operations": mailID, "account-authentication": nil, "runtime-alerts": nil}}
	if _, e := settings.Command(ctx, human, "mail", "save", Object{"operationId": uuid.NewString(), "expectedRevision": 0, "configuration": configuration}, func() (Actor, error) { return gateway.AuthorizeOperations(request, false, "") }); e != nil {
		t.Fatal("save local settings source", e)
	}
	if _, e := owner.Exec(ctx, `INSERT INTO site_publications_v1(id,endpoint,requested_by,snapshot,state,created_at,updated_at,published_at) VALUES($1,$2,$3,$4,'published',$5,$5,$5)`, publicationID, endpoint, rootID, Object{"version": 1, "settings": Object{"siteTitle": "Current published title", "description": "Published only", "footerLinks": []any{}}, "pages": []any{}, "media": []any{}}, now()); e != nil {
		t.Fatal(e)
	}
	q.SystemSettings = settings
	q.SystemGeneral = &systemsettings.General{Settings: settings, WebsiteOrigin: "https://website.example.invalid", Client: &http.Client{Transport: registeredProviderRoute{origin}}}
	for _, view := range []string{"general", "mail", "service-connections", "advanced", "overview"} {
		input := Object{"module": "system-settings", "view": view}
		before := mailReads.Load()
		got, e := q.Query(ctx, human, "overview", "query-operations", input)
		if e != nil {
			t.Fatalf("system settings %s %v", view, e)
		}
		if view == "overview" && mailReads.Load()-before != 1 {
			t.Fatal("overview reread a second mail version for advanced")
		}
		if got["availability"] != "available" || got["data"] == nil || object(got["pagination"])["complete"] != true {
			t.Fatalf("settings %s current read unavailable: %s", view, encoded(got))
		}
		if strings.Contains(encoded(got), credentialID) || strings.Contains(encoded(got), key) {
			t.Fatal("protected Native credential reference escaped query")
		}
	}
	marker = uuid.NewString()
	unavailable, e := q.Query(ctx, human, "overview", "query-operations", Object{"module": "system-settings", "view": "general"})
	if e != nil || unavailable["availability"] != "unavailable" || object(unavailable["data"])["configuration"] != nil || object(unavailable["pagination"])["complete"] != false {
		t.Fatalf("missing publication became saved draft %v %s", e, encoded(unavailable))
	}
	if nativeEffects.Load() != 0 {
		t.Fatal("read facade submitted a Native effect")
	}
}
