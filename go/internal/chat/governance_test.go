package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func chatIdentityFixture(t *testing.T, dsn, service string, storeDir ...string) Object {
	return chatNativeFixture(t, dsn, service, "identity-server", storeDir...)
}
func chatNativeFixture(t *testing.T, dsn, service, command string, storeDir ...string) Object {
	t.Helper()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	args := []string{filepath.Join(root, "scripts", "go", "chat-interop.mjs"), command, service}
	args = append(args, storeDir...)
	cmd := exec.Command("node", args...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	stdin, e := cmd.StdinPipe()
	if e != nil {
		t.Fatal(e)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		stdin.Write([]byte("close\n"))
		stdin.Close()
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			cmd.Process.Kill()
			<-done
		}
	})
	ready := make(chan []byte, 1)
	go func() {
		reader := bufio.NewReader(stdout)
		for {
			line, e := reader.ReadBytes('\n')
			if json.Valid(line) {
				ready <- line
				return
			}
			if e != nil {
				ready <- nil
				return
			}
		}
	}()
	select {
	case raw := <-ready:
		if len(raw) == 0 {
			t.Fatalf("original chat fixture: %s", stderr.String())
		}
		var result Object
		if e = json.Unmarshal(raw, &result); e != nil {
			t.Fatal(e)
		}
		return result
	case <-time.After(60 * time.Second):
		t.Fatal("chat fixture startup timeout")
	}
	return nil
}
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
func TestOpenJoinRealAgentBindingExportAndWorker(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	archive := fakeArchive(t)
	serviceURL := "xmpp://" + archive.listener.Addr().String()
	f := chatIdentityFixture(t, dsn, serviceURL)
	now := time.Unix(num(f, "now"), 0)
	devices := &deviceauth.Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: func() time.Time { return now }}
	ctx := context.Background()
	owner, e := devices.Authenticate(ctx, str(obj(f, "owner"), "token"), "binding")
	if e != nil {
		t.Fatal(e)
	}
	peer, e := devices.Authenticate(ctx, str(obj(f, "peer"), "token"), "binding")
	if e != nil {
		t.Fatal(e)
	}
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
	s := &Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Links: &accountlinks.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Providers: []accountlinks.Provider{{Issuer: str(f, "issuer"), ClientID: "galaxy-fixture"}}, Now: func() time.Time { return now }}, Transport: transport, Rules: &businessrules.Service{Endpoint: str(f, "endpoint"), Now: func() time.Time { return now }}, Now: func() time.Time { return now }}
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
	status, js := chatRequest(t, str(f, "origin"), "/v2/chat/rooms/"+room+"/join-preview", str(obj(f, "peer"), "token"), Object{})
	if status != 200 {
		t.Fatal(js)
	}
	same(t, preview, js)
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
	status, js = chatRequest(t, str(f, "origin"), "/v2/chat/rooms/"+room+"/agent-grants", str(obj(f, "owner"), "token"), Object{})
	if status != 200 {
		t.Fatal(js)
	}
	same(t, grants, js)
	participants, e := s.QueryAgentParticipants(ctx, b, room, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	status, js = chatRequest(t, str(f, "origin"), "/v2/chat/rooms/"+room+"/agent-participants", str(obj(f, "peer"), "token"), Object{})
	if status != 200 {
		t.Fatal(js)
	}
	same(t, participants, js)
	sent, e := s.Send(ctx, a, room, encode(Object{"clientMessageId": uuid.NewString(), "text": "经本人实际绑定授权的响应", "agentGrantId": grant}))
	if e != nil {
		t.Fatal(e)
	}
	owned, e := s.ExportOwned(ctx, a, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	status, js = chatRequest(t, str(f, "origin"), "/v2/chat/export/owned", str(obj(f, "owner"), "token"), Object{})
	if status != 200 {
		t.Fatal(js)
	}
	same(t, owned, js)
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
	archive.mu.Lock()
	_, exists := archive.bodies[str(sent, "messageId")]
	archive.mu.Unlock()
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
	archive.mu.Lock()
	archive.eraseNegative = true
	archive.mu.Unlock()
	if _, e = s.PurgeExpired(ctx, 100); fault.Code(e) != "chat_archive_receipt_invalid" {
		t.Fatalf("negative erase acknowledgement: %v", e)
	}
	var state string
	var pending bool
	if e = pool.QueryRow(ctx, "SELECT state,purge_pending FROM chat_message_refs WHERE message_id=$1", peerMessage["messageId"]).Scan(&state, &pending); e != nil || state != "expired" || !pending {
		t.Fatalf("expiry failed to preserve retry: %s %v %v", state, pending, e)
	}
	archive.mu.Lock()
	archive.eraseNegative = false
	archive.mu.Unlock()
	purged, e := s.PurgeExpired(ctx, 100)
	if e != nil || num(purged, "archiveDeleted") != 1 {
		t.Fatalf("expiry retry: %v %v", purged, e)
	}
}
