package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/accountlinkfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"testing"
	"time"
)

func chatRequest(t *testing.T, origin, path, token string, input any) (int, Object) {
	t.Helper()
	request, e := http.NewRequest("POST", origin+path, bytes.NewReader(encode(input)))
	if e != nil {
		t.Fatal(e)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response, e := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	raw, e := io.ReadAll(response.Body)
	if e != nil {
		t.Fatal(e)
	}
	var result Object
	if e = json.Unmarshal(raw, &result); e != nil {
		t.Fatalf("response: %v %s", e, raw)
	}
	return response.StatusCode, result
}

// chatGoIdentityFixture creates two real device sessions and OIDC-signed account links.
func chatGoIdentityFixture(t *testing.T, pool *pgxpool.Pool) Object {
	t.Helper()
	ctx := context.Background()
	owner := deviceauthfixture.New(t, pool, t.TempDir(), []string{"binding", "consent", "history", "notifications", "case-teaser", "evidence", "proof", "assistance", "moderation"})
	peer := deviceauthfixture.New(t, pool, t.TempDir(), []string{"binding", "consent", "history", "notifications", "case-teaser", "evidence", "proof", "assistance", "moderation"})
	links := accountlinkfixture.New(t, pool, owner.Service)
	links.Link(owner, "isolated-chat-owner")
	links.Link(peer, "isolated-chat-peer")
	if _, err := pool.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3) ON CONFLICT DO NOTHING`, devicefixture.Endpoint, operationsrules.EmptyControls(), time.Unix(devicefixture.Now, 0)); err != nil {
		t.Fatal(err)
	}
	return Object{"endpoint": devicefixture.Endpoint, "issuer": links.Issuer, "now": devicefixture.Now, "owner": Object{"token": owner.Credential, "subjectId": owner.Actor.SubjectID}, "peer": Object{"token": peer.Credential, "subjectId": peer.Actor.SubjectID}, "ownerFixture": owner, "peerFixture": peer}
}

func TestOpenJoinRealAgentBindingExportAndWorker(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	ownerFixture := deviceauthfixture.New(t, pool, t.TempDir(), []string{"binding", "consent", "history"})
	peerFixture := deviceauthfixture.New(t, pool, t.TempDir(), []string{"binding", "consent", "history"})
	links := accountlinkfixture.New(t, pool, ownerFixture.Service)
	links.Link(ownerFixture, "isolated-chat-owner")
	links.Link(peerFixture, "isolated-chat-peer")
	owner, peer := ownerFixture.Actor, peerFixture.Actor
	now := time.Unix(devicefixture.Now, 0)
	if _, e := pool.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3)`, devicefixture.Endpoint, operationsrules.EmptyControls(), now); e != nil {
		t.Fatal(e)
	}
	archive := fakeArchive(t)
	serviceURL := "xmpp://" + archive.Listener.Addr().String()
	devices := ownerFixture.Service
	var e error
	// Two callers already hold their verified binding SHARE lock. The target
	// reader must not turn both into competing UPDATE lock upgrades.
	locked := make(chan struct{}, 2)
	release := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			tx, e := pool.Begin(ctx)
			if e != nil {
				results <- e
				return
			}
			defer tx.Rollback(ctx)
			if e = devices.AuthorizeWithin(ctx, tx, owner, "binding"); e != nil {
				results <- e
				return
			}
			locked <- struct{}{}
			<-release
			check, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			_, e = devices.BindingControlWithin(check, tx, owner.BindingID, owner.SubjectID, "binding")
			results <- e
		}()
	}
	for range 2 {
		select {
		case <-locked:
		case e := <-results:
			t.Fatal(e)
		case <-time.After(3 * time.Second):
			t.Fatal("binding SHARE lock unavailable")
		}
	}
	close(release)
	for range 2 {
		if e = <-results; e != nil {
			t.Fatal(e)
		}
	}
	transport, e := NewComponentTransport(serviceURL, "gateway.example.invalid", "rooms.example.invalid", testSecret, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	if e = transport.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer transport.Stop()
	s := &Service{Pool: pool, Endpoint: devicefixture.Endpoint, Devices: devices, Links: links.Registry, Transport: transport, Rules: &businessrules.Service{Endpoint: devicefixture.Endpoint, Now: func() time.Time { return now }}, Now: func() time.Time { return now }}
	a, b := Actor{Device: &owner}, Actor{Device: &peer}
	room := uuid.NewString()
	first, e := s.Create(ctx, a, encode(Object{"roomId": room, "operationId": uuid.NewString(), "title": "原开放讨论"}))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Propose(ctx, a, room, encode(Object{"decisionId": uuid.NewString(), "expectedRevision": first["revision"], "action": "join-rule", "joinRule": Object{"mode": "open"}})); e != nil {
		t.Fatal(e)
	}
	preview, e := s.JoinPreview(ctx, b, room)
	if e != nil {
		t.Fatal(e)
	}
	if preview["joiningGrantsOtherMaterials"] != false || preview["joiningStartsAgent"] != false || preview["requiresVerifiedAccount"] != true {
		t.Fatal("join authority changed", preview)
	}
	join := Object{"operationId": uuid.NewString(), "ruleVersion": preview["ruleVersion"], "ruleHash": preview["ruleHash"]}
	joined, e := s.Join(ctx, b, room, encode(join))
	if e != nil {
		t.Fatal(e)
	}
	replayed, e := s.Join(ctx, b, room, encode(join))
	if e != nil {
		t.Fatal(e)
	}
	same(t, joined, replayed)
	grant := uuid.NewString()
	granted, e := s.GrantAgent(ctx, a, room, encode(Object{"grantId": grant, "bindingId": owner.BindingID, "mode": "respond", "primaryResponder": true, "expiresAt": now.Unix() + 3600}))
	if e != nil {
		t.Fatal(e)
	}
	if truth(granted, "hostRuntimeStarted") {
		t.Fatal("grant started host")
	}
	grants, e := s.QueryAgentGrants(ctx, a, room, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	if len(grants["items"].([]Object)) != 1 || str(grants["items"].([]Object)[0], "grantId") != grant {
		t.Fatal("agent grant read changed", grants)
	}
	participants, e := s.QueryAgentParticipants(ctx, b, room, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	if len(participants["items"].([]Object)) != 1 {
		t.Fatal("agent participant read changed", participants)
	}
	sent, e := s.Send(ctx, a, room, encode(Object{"clientMessageId": uuid.NewString(), "text": "经本人实际绑定授权的响应", "agentGrantId": grant}))
	if e != nil {
		t.Fatal(e)
	}
	owned, e := s.ExportOwned(ctx, a, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	if len(owned["messages"].([]Object)) != 1 || str(owned, "scope") != "own-authored-retained-messages" {
		t.Fatal("owned export changed", owned)
	}
	ready, e := s.MaintenanceReadiness(ctx)
	if e != nil || truth(ready, "bodyReturned") || !truth(ready, "roundTrip") {
		t.Fatalf("body-free probe: %v %v", ready, e)
	}
	revoked, e := s.RevokeAgent(ctx, a, room, encode(Object{"grantId": grant}))
	if e != nil || truth(revoked, "hostRuntimeStopped") {
		t.Fatalf("revoke: %v %v", revoked, e)
	}
	if _, e = s.Send(ctx, a, room, encode(Object{"clientMessageId": uuid.NewString(), "text": "已撤销代理不能再发", "agentGrantId": grant})); fault.Code(e) != "chat_agent_not_authorized" {
		t.Fatal(e)
	}
	erased, e := s.EraseSubject(ctx, owner.SubjectID, 100)
	if e != nil || !truth(erased, "complete") || num(erased, "archiveDeleted") != 1 {
		t.Fatalf("erase: %v %v", erased, e)
	}
	archive.Mu.Lock()
	_, exists := archive.Bodies[str(sent, "messageId")]
	archive.Mu.Unlock()
	if exists {
		t.Fatal("erase ack did not delete real fixture archive")
	}
	if _, e = s.Get(ctx, a, room); fault.Code(e) != "chat_access_denied" {
		t.Fatalf("erased owner stayed member: %v", e)
	}
	if _, e = s.Get(ctx, b, room); e != nil {
		t.Fatal(e)
	}
	peerMessage, e := s.Send(ctx, b, room, encode(Object{"clientMessageId": uuid.NewString(), "text": "保留至原到期时间"}))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, "UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1", peerMessage["messageId"], now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	now = now.Add(2 * time.Second)
	archive.Mu.Lock()
	archive.EraseNegative = true
	archive.Mu.Unlock()
	if _, e = s.PurgeExpired(ctx, 100); fault.Code(e) != "chat_archive_receipt_invalid" {
		t.Fatalf("negative erase acknowledgement: %v", e)
	}
	var state string
	var pending bool
	if e = pool.QueryRow(ctx, "SELECT state,purge_pending FROM chat_message_refs WHERE message_id=$1", peerMessage["messageId"]).Scan(&state, &pending); e != nil || state != "expired" || !pending {
		t.Fatalf("expiry failed to preserve retry: %s %v %v", state, pending, e)
	}
	archive.Mu.Lock()
	archive.EraseNegative = false
	archive.Mu.Unlock()
	purged, e := s.PurgeExpired(ctx, 100)
	if e != nil || num(purged, "archiveDeleted") != 1 {
		t.Fatalf("expiry retry: %v %v", purged, e)
	}
}
