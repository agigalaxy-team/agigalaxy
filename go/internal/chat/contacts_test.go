package chat

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/google/uuid"
	"net/http/httptest"
	"testing"
	"time"
)

func TestContactsOriginalSignedProjectCurrentWishAndAcceptedRoom(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	archive := fakeArchive(t)
	url := "xmpp://" + archive.Listener.Addr().String()
	f := chatGoIdentityFixture(t, pool)
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
	discovery := &ContactDiscovery{Pool: pool, Devices: devices, Endpoint: s.Endpoint, Profiles: &profiles.Service{Pool: pool, Endpoint: s.Endpoint, Devices: devices, Now: clock}, Now: clock}
	discovery.UseProjects(source)
	contacts := &ContactService{Chat: s, Discovery: discovery}
	server := httptest.NewServer(ContactHandler{Service: contacts, Next: projects.Handler{Service: source, Next: notifications.Handler{Service: discovery.NotificationReader(), Next: deviceauth.Handler{Service: devices, Next: Handler{Service: s}}}}})
	defer server.Close()
	ownerFixture := f["ownerFixture"].(deviceauthfixture.Fixture)
	peerFixture := f["peerFixture"].(deviceauthfixture.Fixture)
	project := Object{"operationId": uuid.NewString(), "projectId": uuid.NewString(), "expectedRevision": 0, "kind": "create", "document": Object{"kind": "module", "title": "Synthetic parser 🚀", "summary": "Looking to discuss table extraction", "functions": []any{"table-extraction"}, "discoverable": true, "extension": "retained"}}
	projectGrant := peerFixture.Grant(t, project, "project.write", str(project, "operationId"), "Public", nil)
	if _, err := source.Submit(ctx, projects.Actor{Device: &peer}, encode(projectGrant)); err != nil {
		t.Fatal("create real project", err)
	}
	if _, err := discovery.SavePreferences(ctx, peer, Object{"expectedRevision": 0, "preferences": Object{"enabled": true}}, nil); err != nil {
		t.Fatal("enable peer discovery", err)
	}
	contextInput := Object{"kind": "ephemeral", "title": "Discuss a new parser", "functions": []any{"table-extraction"}}
	page, err := discovery.Query(ctx, &owner, Object{"context": contextInput, "purposes": []any{"conversation"}})
	if err != nil {
		t.Fatal("discover source", err)
	}
	var opportunity Object
	for _, value := range page["items"].([]Object) {
		if value["projectId"] == project["projectId"] {
			opportunity = value
			break
		}
	}
	if opportunity == nil {
		t.Fatal("project opportunity missing", page)
	}
	send := Object{"operationId": uuid.NewString(), "contactId": uuid.NewString(), "expectedRevision": 0, "kind": "send", "recipientId": peer.SubjectID, "purpose": "conversation", "context": contextInput, "opportunityRef": opportunity["opportunityRef"], "note": "Talk about parser trade-offs; no promised delivery", "roomTitle": "Parser conversation"}
	accept := Object{"operationId": uuid.NewString(), "contactId": send["contactId"], "expectedRevision": 1, "kind": "accept", "note": "Conversation only"}
	duplicate := Object{}
	for key, value := range send {
		duplicate[key] = value
	}
	duplicate["operationId"], duplicate["contactId"] = uuid.NewString(), uuid.NewString()
	inputs := Object{"project": project, "send": send, "denied": ownerFixture.Grant(t, send, "contact.write", str(send, "operationId"), "Private", nil), "grant": ownerFixture.Grant(t, send, "contact.write", str(send, "operationId"), "Private", []string{peer.SubjectID}), "responseGrant": peerFixture.Grant(t, accept, "contact.write", str(accept, "operationId"), "Private", []string{owner.SubjectID}), "duplicate": ownerFixture.Grant(t, duplicate, "contact.write", str(duplicate, "operationId"), "Private", []string{peer.SubjectID})}
	second, transferID, cancelID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	events := []any{}
	add := func(who string, kind string, extra Object, visibility string, viewers []string) {
		event := Object{"operationId": uuid.NewString(), "projectId": second, "expectedRevision": len(events), "kind": kind}
		for k, v := range extra {
			event[k] = v
		}
		signer := peerFixture
		if who == "owner" {
			signer = ownerFixture
		}
		events = append(events, Object{"event": event, "who": who, "grant": signer.Grant(t, event, "project.write", str(event, "operationId"), visibility, viewers)})
	}
	add("peer", "create", Object{"document": Object{"kind": "module", "title": "Go-owned source", "summary": "Original extensions retained", "functions": []any{"table-extraction"}, "sourceUrl": "https://docs.example.invalid/source", "discoverable": true, "extension": Object{"opaque": true}}}, "Public", nil)
	add("peer", "grant-role", Object{"subjectId": owner.SubjectID, "role": "editor"}, "Private", []string{owner.SubjectID})
	add("owner", "revise", Object{"patch": Object{"summary": "Editor private final writer", "sourceUrl": nil}}, "Private", []string{peer.SubjectID})
	add("peer", "offer-transfer", Object{"transferId": transferID, "toSubjectId": owner.SubjectID}, "Private", []string{owner.SubjectID})
	add("owner", "accept-transfer", Object{"transferId": transferID}, "Public", nil)
	add("owner", "archive", Object{}, "Public", nil)
	add("owner", "restore", Object{}, "Public", nil)
	add("owner", "grant-role", Object{"subjectId": peer.SubjectID, "role": "representative"}, "Private", []string{peer.SubjectID})
	add("owner", "revoke-role", Object{"subjectId": peer.SubjectID, "role": "representative"}, "Public", nil)
	add("owner", "offer-transfer", Object{"transferId": cancelID, "toSubjectId": peer.SubjectID}, "Private", []string{peer.SubjectID})
	add("owner", "cancel-transfer", Object{"transferId": cancelID}, "Public", nil)
	add("owner", "revise", Object{"patch": Object{"summary": "Public restored source"}}, "Public", nil)
	inputs["events"] = events
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
	if str(view, "projectId") != str(project, "projectId") {
		t.Fatal("project source changed", view)
	}
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
	status, goQuery := chatRequest(t, server.URL, "/v2/contacts/query", peerToken, Object{"direction": "incoming"})
	if status != 200 {
		t.Fatal(goQuery)
	}
	if len(goQuery["items"].([]any)) != 1 {
		t.Fatal("incoming contact missing", goQuery)
	}
	status, result = chatRequest(t, server.URL, "/v2/contacts", ownerToken, inputs["duplicate"])
	if status != 429 || str(result, "error") != "invitation_cooldown" {
		t.Fatalf("shared cooldown: %d %v", status, result)
	}
	status, options := chatRequest(t, server.URL, "/v2/notifications/options/read", peerToken, Object{})
	if status != 200 {
		t.Fatal(options)
	}
	status, result = chatRequest(t, server.URL, "/v2/notifications/options/save", peerToken, Object{"expectedRevision": options["revision"], "settings": Object{"blockedSubjectIds": []string{owner.SubjectID}}})
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
	_, options = chatRequest(t, server.URL, "/v2/notifications/options/read", peerToken, Object{})
	status, result = chatRequest(t, server.URL, "/v2/notifications/options/save", peerToken, Object{"expectedRevision": options["revision"], "settings": Object{"blockedSubjectIds": []string{}}})
	if status != 200 {
		t.Fatal(result)
	}
	status, accepted := chatRequest(t, server.URL, "/v2/contacts", peerToken, inputs["responseGrant"])
	if status != 200 || str(accepted, "state") != "accepted" || str(accepted, "roomId") != id {
		t.Fatalf("accepted: %d %v", status, accepted)
	}
	status, result = chatRequest(t, server.URL, "/v2/contacts", peerToken, inputs["responseGrant"])
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
	status, original := chatRequest(t, server.URL, "/v2/chat/rooms/"+id+"/read", peerToken, Object{})
	if status != 200 {
		t.Fatal(original)
	}
	if str(original, "roomId") != id {
		t.Fatal("accepted room read changed", original)
	}
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
		status, original = chatRequest(t, server.URL, "/v2/projects", token, item["grant"])
		if status != 200 || !truth(original, "replayed") {
			t.Fatalf("original project receipt %s: %d %v", str(event, "kind"), status, original)
		}

		path := "/v2/projects/" + str(event, "projectId")
		status, raw, _ := attachmentHTTP(t, server.URL, path, "GET", token, nil)
		if status == 200 {
			var view Object
			if err := json.Unmarshal(raw, &view); err != nil || str(view, "projectId") != str(event, "projectId") {
				t.Fatal("project read", view, err)
			}
		} else if status != 404 {
			t.Fatalf("project read %s: %d %s", str(event, "kind"), status, raw)
		}

		if num(event, "expectedRevision") == 0 {
			for _, collection := range []string{"directory", "portfolio"} {
				query := Object{}
				if collection == "portfolio" {
					query["ownerId"] = peer.SubjectID
				}
				status, result = chatRequest(t, server.URL, "/v2/projects/"+collection+"/query", ownerToken, query)
				if status != 200 {
					t.Fatal("public collection", result)
				}
				if result["items"] == nil {
					t.Fatal("public collection missing items", result)
				}
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
	if status != 200 {
		t.Fatal("project workspace list", result)
	}
	if result["items"] == nil {
		t.Fatal("project collection missing items", result)
	}
	projectID := str(obj(inputs["events"].([]any)[0].(map[string]any), "event"), "projectId")
	prefPath := "/v2/projects/" + projectID + "/preferences/"
	status, result = chatRequest(t, server.URL, prefPath+"save", ownerToken, Object{"expectedRevision": 0, "preferences": Object{"enabled": true, "functions": []string{" TABLE-EXTRACTION "}}})
	if status != 200 {
		t.Fatal("project preference", result)
	}
	status, original = chatRequest(t, server.URL, prefPath+"read", ownerToken, Object{})
	if status != 200 {
		t.Fatal(original)
	}
	if result["revision"] != original["revision"] {
		t.Fatal("project preference revision changed", result, original)
	}
	firstEvent := inputs["events"].([]any)[0].(map[string]any)
	status, result = chatRequest(t, server.URL, "/v1/consents/"+str(obj(firstEvent, "grant"), "consentId")+"/revoke", peerToken, Object{})
	if status != 200 {
		t.Fatal("original project source revoke", result)
	}
	status, _, _ = attachmentHTTP(t, server.URL, "/v2/projects/"+projectID, "GET", ownerToken, nil)
	if status != 404 {
		t.Fatal("revoked final writer resurrected", status)
	}
}
