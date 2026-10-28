package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"sync/atomic"
	"testing"
	"time"
)

type summaryNoticeArchive struct{ sends atomic.Int32 }

func (f *summaryNoticeArchive) Available() bool { return true }
func (f *summaryNoticeArchive) Command(_ context.Context, action string, input chat.Object) (chat.Object, error) {
	if action == "send" {
		f.sends.Add(1)
		return chat.Object{"archiveId": input["messageId"]}, nil
	}
	if action == "erase" {
		return chat.Object{"removed": true}, nil
	}
	return chat.Object{"projected": true}, nil
}
func TestRemoteSummaryGoNoticeReceiptAndReviewedInbox(t *testing.T) {
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
	archive := &summaryNoticeArchive{}
	rooms := &chat.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now, Devices: devices, Links: links, Transport: archive}
	summaries := &chat.SharedSummaryService{Chat: rooms}
	inboxService := &notifications.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now, Devices: devices}
	original, _ := url.Parse(meta.Origin)
	server := httptest.NewServer(chat.SharedSummaryHandler{Service: summaries, Next: notifications.Handler{Service: inboxService, Next: chat.Handler{Service: rooms, Next: httputil.NewSingleHostReverseProxy(original)}}})
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	runtime, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	chatClient := NewNativeChat(runtime)
	room, grant, share := uuid.NewString(), uuid.NewString(), uuid.NewString()
	created, e := chatClient.Call(ctx, "galaxy_chat_create", map[string]any{"roomId": room, "operationId": uuid.NewString(), "title": "Synthetic explicit summary room"}, &scope)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = chatClient.Call(ctx, "galaxy_chat_agent_grant", map[string]any{"roomId": room, "grantId": grant, "mode": "respond", "primaryResponder": true, "expiresAt": meta.Now + 3600}, &scope); e != nil {
		t.Fatal(e)
	}
	input := sharedSummaryFixture(room, grant, share)
	input["expectedMemberRevision"] = created["memberRevision"]
	client := NewNativeSharedSummaries(runtime)
	transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v2/chat/shared-summaries/publish" {
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	if _, e = client.Call(ctx, "galaxy_chat_shared_summary_publish", input); e == nil {
		t.Fatal("lost summary ACK reported success")
	}
	transport.setHook(nil)
	normalized, e := remoteSummaryNormalize("galaxy_chat_shared_summary_publish", input)
	if e != nil {
		t.Fatal(e)
	}
	canonical, e := identity.Canonical(normalized)
	if e != nil {
		t.Fatal(e)
	}
	receiptInput := map[string]any{"roomId": room, "shareId": share, "requestHash": identity.Digest(canonical)}
	receipt, e := client.Call(ctx, "galaxy_chat_shared_summary_receipt", receiptInput)
	if e != nil || receipt["state"] != "published" || receipt["acceptedByRoom"] != true || receipt["contentReturned"] != false || archive.sends.Load() != 1 {
		t.Fatal(receipt, e, archive.sends.Load())
	}
	if _, e = client.Call(ctx, "galaxy_chat_shared_summary_get", map[string]any{"roomId": room, "shareId": share}); e != nil {
		t.Fatal(e)
	}
	if _, e = client.Call(ctx, "galaxy_chat_shared_summary_retract", map[string]any{"roomId": room, "shareId": share}); e != nil {
		t.Fatal(e)
	}
	receipt, e = client.Call(ctx, "galaxy_chat_shared_summary_receipt", receiptInput)
	if e != nil || receipt["state"] != "retracted" || receipt["contentReturned"] != false || archive.sends.Load() != 1 {
		t.Fatal("retraction or receipt resent notice", receipt, e)
	}
	inbox := NewNativeInbox(runtime)
	options, e := inbox.Call(ctx, "galaxy_inbox_options", map[string]any{}, nil)
	if e != nil {
		t.Fatal(e)
	}
	serverMCP := mcp.NewServer(&mcp.Implementation{Name: "inbox", Version: "1"}, nil)
	registerRemoteInboxTools(serverMCP, &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := serverMCP.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	choices := 0
	mcpClient := mcp.NewClient(&mcp.Implementation{Name: "inbox", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		choices++
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}}, nil
	}})
	session, e := mcpClient.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	saved := materialCall(t, session, "galaxy_inbox_options_save", map[string]any{"expectedRevision": options["revision"], "settings": map[string]any{"rooms": false}}, false)
	if uploadObject(saved["settings"])["rooms"] != false || saved["externalDelivery"] != "disabled" || choices != 1 {
		t.Fatal("inbox choice changed delivery", saved, choices)
	}
	if _, e = inbox.Call(ctx, "galaxy_inbox_query", map[string]any{}, nil); e != nil {
		t.Fatal(e)
	}
	transport.mu.Lock()
	for _, path := range transport.paths {
		if path == "/v2/notifications/read" || path == "/v2/notifications/presentation/claim" || path == "/v2/notifications/presentation/ack" {
			transport.mu.Unlock()
			t.Fatal("read/save implied actual human or external delivery", path)
		}
	}
	transport.mu.Unlock()
	if _, e = runtime.Disconnect(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = inbox.Call(ctx, "galaxy_inbox_query", map[string]any{}, nil); e == nil {
		t.Fatal("disabled runtime queried inbox")
	}
}
