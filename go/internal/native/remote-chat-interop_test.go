package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"sync/atomic"
	"testing"
	"time"
)

type remoteChatArchive struct{ sends atomic.Int32 }

func (f *remoteChatArchive) Available() bool { return true }
func (f *remoteChatArchive) Command(_ context.Context, action string, input chat.Object) (chat.Object, error) {
	if action == "send" {
		f.sends.Add(1)
		return chat.Object{"archiveId": input["messageId"]}, nil
	}
	return chat.Object{"projected": true}, nil
}
func TestRemoteChatGoServiceOriginalGrantAndUnknownMessage(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := nativeGoUploadFixtureDatabase(t, dsn)
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
	archive := &remoteChatArchive{}
	service := &chat.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now, Devices: devices, Links: links, Transport: archive}
	original, _ := url.Parse(meta.Origin)
	server := httptest.NewServer(chat.Handler{Service: service, Next: httputil.NewSingleHostReverseProxy(original)})
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	runtime, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	client := NewNativeChat(runtime)
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	room, operation, grant, message := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	create := map[string]any{"roomId": room, "operationId": operation, "title": "  Original Native room  "}
	created, e := client.Call(ctx, "galaxy_chat_create", create, &scope)
	if e != nil {
		t.Fatal(e)
	}
	if created["roomId"] != room || created["title"] != "Original Native room" {
		t.Fatal(created)
	}
	if _, e = client.Call(ctx, "galaxy_chat_room", map[string]any{"roomId": room}, nil); e != nil {
		t.Fatal(e)
	}
	grantInput := map[string]any{"roomId": room, "grantId": grant, "mode": "respond", "primaryResponder": true, "expiresAt": meta.Now + 3600}
	if _, e = client.Call(ctx, "galaxy_chat_agent_grant", grantInput, &scope); e != nil {
		t.Fatal(e)
	}
	reconciled, e := client.Call(ctx, "galaxy_chat_agent_grant", grantInput, &scope)
	if e != nil || reconciled["reconciled"] != true || reconciled["hostRuntimeStarted"] != false {
		t.Fatal(reconciled, e)
	}
	changed := identityClone(grantInput)
	changed["mode"] = "read"
	if _, e = client.Call(ctx, "galaxy_chat_agent_grant", changed, &scope); e == nil {
		t.Fatal("original grant widened/changed")
	}
	transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v2/chat/rooms/"+room+"/send" {
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	send := map[string]any{"roomId": room, "agentGrantId": grant, "clientMessageId": message, "text": "Synthetic own-Agent message"}
	if _, e = client.Call(ctx, "galaxy_chat_send", send, nil); e == nil {
		t.Fatal("lost ACK reported success")
	}
	transport.setHook(nil)
	normalized, e := remoteChatNormalize("galaxy_chat_send", send)
	if e != nil {
		t.Fatal(e)
	}
	delete(normalized, "roomId")
	canonical, e := identity.Canonical(normalized)
	if e != nil {
		t.Fatal(e)
	}
	receipt, e := client.Call(ctx, "galaxy_chat_message_status", map[string]any{"roomId": room, "clientMessageId": message, "requestHash": identity.Digest(canonical)}, nil)
	if e != nil || receipt["state"] != "accepted" || archive.sends.Load() != 1 {
		t.Fatal(receipt, e, archive.sends.Load())
	}
	if _, e = client.Call(ctx, "galaxy_chat_agent_revoke", map[string]any{"roomId": room, "grantId": grant}, nil); e != nil {
		t.Fatal(e)
	}
	if _, e = client.Call(ctx, "galaxy_chat_send", map[string]any{"roomId": room, "agentGrantId": grant, "clientMessageId": uuid.NewString(), "text": "must refuse"}, nil); e == nil {
		t.Fatal("revoked grant sent")
	}
	if archive.sends.Load() != 1 {
		t.Fatal("unknown/revoked operation resent")
	}
	if _, e = runtime.Disconnect(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = client.Call(ctx, "galaxy_chat_room", map[string]any{"roomId": room}, nil); e == nil {
		t.Fatal("disabled runtime sent")
	}
}
