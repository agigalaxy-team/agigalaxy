package chat

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"net/http/httptest"
	"testing"
	"time"
)

func TestContactsOriginalSignedProjectCurrentWishAndAcceptedRoom(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	archive := fakeArchive(t)
	url := "xmpp://" + archive.listener.Addr().String()
	f := chatNativeFixture(t, dsn, url, "contacts-server")
	ctx := context.Background()
	clock := func() time.Time { return time.Unix(num(f, "now"), 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: clock}
	ownerToken, peerToken := str(obj(f, "owner"), "token"), str(obj(f, "peer"), "token")
	owner, e := devices.Authenticate(ctx, ownerToken, "history")
	if e != nil {
		t.Fatal(e)
	}
	peer, e := devices.Authenticate(ctx, peerToken, "history")
	if e != nil {
		t.Fatal(e)
	}
	transport, e := NewComponentTransport(url, "gateway.example.invalid", "rooms.example.invalid", testSecret, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	if e = transport.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer transport.Stop()
	s := &Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Links: &accountlinks.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Providers: []accountlinks.Provider{{Issuer: str(f, "issuer"), ClientID: "galaxy-fixture"}}, Now: clock}, Transport: transport, Rules: &businessrules.Service{Endpoint: str(f, "endpoint"), Now: clock}, Now: clock}
	source := &projects.Service{Pool: pool, Endpoint: s.Endpoint, Devices: devices, Links: s.Links, Profiles: &profiles.Service{Pool: pool, Endpoint: s.Endpoint, Devices: devices, Now: clock}, Now: clock}
	discovery := &ContactDiscovery{Endpoint: s.Endpoint, Profiles: &profiles.Service{Pool: pool, Endpoint: s.Endpoint, Devices: devices, Now: clock}, Now: clock}
	discovery.UseProjects(source)
	contacts := &ContactService{Chat: s, Discovery: discovery}
	server := httptest.NewServer(ContactHandler{Service: contacts, Next: projects.Handler{Service: source, Next: Handler{Service: s}}})
	defer server.Close()
	inputs := obj(f, "contacts")
	project := obj(inputs, "project")
	send := obj(inputs, "send")
	id := str(send, "contactId")
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	view, e := source.ReadWithin(ctx, tx, &owner, str(project, "projectId"))
	tx.Rollback(ctx)
	if e != nil {
		t.Fatal(e)
	}
	status, raw, _ := attachmentHTTP(t, str(f, "origin"), "/v2/projects/"+str(project, "projectId"), "GET", ownerToken, nil)
	var js Object
	if e = json.Unmarshal(raw, &js); e != nil || status != 200 {
		t.Fatalf("original project read: %d %s", status, raw)
	}
	delete(js, "management")
	same(t, view, js)
	var ownerScopes []byte
	if e = pool.QueryRow(ctx, "SELECT scopes FROM access_credentials WHERE token_hash=$1", owner.CredentialHash).Scan(&ownerScopes); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, "UPDATE access_credentials SET scopes='[\"history\"]'::jsonb WHERE token_hash=$1", owner.CredentialHash); e != nil {
		t.Fatal(e)
	}
	if _, e = devices.Authenticate(ctx, ownerToken, "binding"); e == nil {
		t.Fatal("history-only credential gained binding")
	}
	status, result := chatRequest(t, server.URL, "/v2/contacts", ownerToken, inputs["denied"])
	if status != 403 || str(result, "error") != "contact_recipient_consent_required" {
		t.Fatalf("private recipient consent: %d %v", status, result)
	}
	var n int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM contacts_v2").Scan(&n); e != nil || n != 0 {
		t.Fatal("denied contact persisted", n, e)
	}
	status, sent := chatRequest(t, server.URL, "/v2/contacts", ownerToken, inputs["grant"])
	if status != 200 || str(sent, "state") != "sent" || sent["roomId"] != nil || sent["taskId"] != nil {
		t.Fatalf("sent: %d %v", status, sent)
	}
	status, result = chatRequest(t, server.URL, "/v2/contacts", ownerToken, inputs["grant"])
	if status != 200 || !truth(result, "replayed") {
		t.Fatal("send replay", result)
	}
	status, original := chatRequest(t, str(f, "origin"), "/v2/contacts/query", peerToken, Object{"direction": "incoming"})
	if status != 200 {
		t.Fatal(original)
	}
	status, goQuery := chatRequest(t, server.URL, "/v2/contacts/query", peerToken, Object{"direction": "incoming"})
	if status != 200 {
		t.Fatal(goQuery)
	}
	same(t, goQuery, original)
	status, result = chatRequest(t, server.URL, "/v2/contacts", ownerToken, inputs["duplicate"])
	if status != 429 || str(result, "error") != "invitation_cooldown" {
		t.Fatalf("shared cooldown: %d %v", status, result)
	}
	status, options := chatRequest(t, str(f, "origin"), "/v2/notifications/options/read", peerToken, Object{})
	if status != 200 {
		t.Fatal(options)
	}
	status, result = chatRequest(t, str(f, "origin"), "/v2/notifications/options/save", peerToken, Object{"expectedRevision": options["revision"], "settings": Object{"blockedSubjectIds": []string{owner.SubjectID}}})
	if status != 200 {
		t.Fatal(result)
	}
	status, result = chatRequest(t, server.URL, "/v2/contacts", peerToken, inputs["responseGrant"])
	if status != 403 {
		t.Fatalf("current block: %d %v", status, result)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM chat_rooms").Scan(&n); e != nil || n != 0 {
		t.Fatal("blocked acceptance made room", n, e)
	}
	_, options = chatRequest(t, str(f, "origin"), "/v2/notifications/options/read", peerToken, Object{})
	status, result = chatRequest(t, str(f, "origin"), "/v2/notifications/options/save", peerToken, Object{"expectedRevision": options["revision"], "settings": Object{"blockedSubjectIds": []string{}}})
	if status != 200 {
		t.Fatal(result)
	}
	status, accepted := chatRequest(t, server.URL, "/v2/contacts", peerToken, inputs["responseGrant"])
	if status != 200 || str(accepted, "state") != "accepted" || str(accepted, "roomId") != id {
		t.Fatalf("accepted: %d %v", status, accepted)
	}
	status, result = chatRequest(t, str(f, "origin"), "/v2/contacts", peerToken, inputs["responseGrant"])
	if status != 200 || !truth(result, "replayed") {
		t.Fatal("original acceptance replay", result)
	}
	a, b := Actor{Device: &owner}, Actor{Device: &peer}
	if _, e = pool.Exec(ctx, "UPDATE access_credentials SET scopes=$2::jsonb WHERE token_hash=$1", owner.CredentialHash, ownerScopes); e != nil {
		t.Fatal(e)
	}
	room, e := s.Get(ctx, b, id)
	if e != nil {
		t.Fatal(e)
	}
	if str(room, "mode") != "ownerless" || num(room, "independentMemberCount") != 2 || room["ownerSubjectId"] != nil {
		t.Fatal("contact room", room)
	}
	status, original = chatRequest(t, str(f, "origin"), "/v2/chat/rooms/"+id+"/read", peerToken, Object{})
	if status != 200 {
		t.Fatal(original)
	}
	same(t, room, original)
	message := uuid.NewString()
	if _, e = s.Send(ctx, a, id, encode(Object{"clientMessageId": message, "text": "Conversation without work participation"})); e != nil {
		t.Fatal(e)
	}
	history, e := s.History(ctx, b, id, encode(Object{}))
	if e != nil || len(history["messages"].([]Object)) != 1 {
		t.Fatal("accepted room delivery", history, e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM task_participations").Scan(&n); e != nil || n != 0 {
		t.Fatal("fabricated participation", n, e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE action='contact.event'").Scan(&n); e != nil || n != 2 {
		t.Fatal("signed audit", n, e)
	}
	var publicCursor string
	for _, value := range inputs["events"].([]any) {
		item := value.(map[string]any)
		event := obj(item, "event")
		token := peerToken
		if str(item, "who") == "owner" {
			token = ownerToken
		}
		status, result = chatRequest(t, server.URL, "/v2/projects", token, item["grant"])
		if status != 200 || num(result, "revision") != num(event, "expectedRevision")+1 {
			t.Fatalf("Go project %s: %d %v", str(event, "kind"), status, result)
		}
		status, original = chatRequest(t, str(f, "origin"), "/v2/projects", token, item["grant"])
		if status != 200 || !truth(original, "replayed") {
			t.Fatalf("original project receipt %s: %d %v", str(event, "kind"), status, original)
		}
		delete(original, "replayed")
		delete(result, "replayed")
		same(t, result, original)
		path := "/v2/projects/" + str(event, "projectId")
		status, goRaw, _ := attachmentHTTP(t, server.URL, path, "GET", token, nil)
		jsStatus, jsRaw, _ := attachmentHTTP(t, str(f, "origin"), path, "GET", token, nil)
		if status != jsStatus {
			t.Fatalf("workspace %s: Go%d JS%d: %s %s", str(event, "kind"), status, jsStatus, goRaw, jsRaw)
		}
		if status == 200 {
			var left, right Object
			json.Unmarshal(goRaw, &left)
			json.Unmarshal(jsRaw, &right)
			same(t, left, right)
		}
		if num(event, "expectedRevision") == 0 {
			for _, collection := range []string{"directory", "portfolio"} {
				query := Object{}
				if collection == "portfolio" {
					query["ownerId"] = peer.SubjectID
				}
				status, result = chatRequest(t, server.URL, "/v2/projects/"+collection+"/query", ownerToken, query)
				jsStatus, original = chatRequest(t, str(f, "origin"), "/v2/projects/"+collection+"/query", ownerToken, query)
				if status != 200 || jsStatus != 200 {
					t.Fatal("public collection", result, original)
				}
				same(t, result, original)
			}
			status, result = chatRequest(t, server.URL, "/v2/projects/portfolio/query", ownerToken, Object{"ownerId": peer.SubjectID, "limit": 1})
			if status != 200 || str(result, "nextAfter") == "" {
				t.Fatal("sealed project cursor", result)
			}
			publicCursor = str(result, "nextAfter")
			status, result = chatRequest(t, server.URL, "/v2/projects/portfolio/query", ownerToken, Object{"ownerId": peer.SubjectID, "limit": 1, "after": publicCursor})
			if status != 200 || len(result["items"].([]any)) != 1 || result["nextAfter"] != nil {
				t.Fatal("current project cursor continuation", result)
			}
			status, result = chatRequest(t, server.URL, "/v2/projects/portfolio/query", peerToken, Object{"ownerId": peer.SubjectID, "limit": 1, "after": publicCursor})
			if status != 409 || str(result, "error") != "project_directory_cursor_unavailable_restart" {
				t.Fatal("cursor viewer scope", result)
			}
		}
	}
	status, result = chatRequest(t, server.URL, "/v2/projects/portfolio/query", ownerToken, Object{"ownerId": peer.SubjectID, "limit": 1, "after": publicCursor})
	if status != 409 || str(result, "error") != "project_directory_sources_changed_retry" {
		t.Fatal("cursor current sources", result)
	}
	status, result = chatRequest(t, server.URL, "/v2/projects/query", ownerToken, Object{})
	jsStatus, original := chatRequest(t, str(f, "origin"), "/v2/projects/query", ownerToken, Object{})
	if status != 200 || jsStatus != 200 {
		t.Fatal("project workspace list", result, original)
	}
	same(t, result, original)
	projectID := str(obj(inputs["events"].([]any)[0].(map[string]any), "event"), "projectId")
	prefPath := "/v2/projects/" + projectID + "/preferences/"
	status, result = chatRequest(t, server.URL, prefPath+"save", ownerToken, Object{"expectedRevision": 0, "preferences": Object{"enabled": true, "functions": []string{" TABLE-EXTRACTION "}}})
	if status != 200 {
		t.Fatal("project preference", result)
	}
	jsStatus, original = chatRequest(t, str(f, "origin"), prefPath+"read", ownerToken, Object{})
	if jsStatus != 200 {
		t.Fatal(original)
	}
	same(t, result, original)
	firstEvent := inputs["events"].([]any)[0].(map[string]any)
	status, result = chatRequest(t, str(f, "origin"), "/v1/consents/"+str(obj(firstEvent, "grant"), "consentId")+"/revoke", peerToken, Object{})
	if status != 200 {
		t.Fatal("original project source revoke", result)
	}
	status, _, _ = attachmentHTTP(t, server.URL, "/v2/projects/"+projectID, "GET", ownerToken, nil)
	jsStatus, _, _ = attachmentHTTP(t, str(f, "origin"), "/v2/projects/"+projectID, "GET", ownerToken, nil)
	if status != 404 || jsStatus != 404 {
		t.Fatal("revoked final writer resurrected", status, jsStatus)
	}
}
