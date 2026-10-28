package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSharedSummaryOriginalNoticeUnknownAndSourceTransitions(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	archive := fakeArchive(t)
	url := "xmpp://" + archive.listener.Addr().String()
	f := chatIdentityFixture(t, dsn, url)
	now := time.Unix(num(f, "now"), 0)
	clock := func() time.Time { return now }
	ctx := context.Background()
	devices := &deviceauth.Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: clock}
	owner, e := devices.Authenticate(ctx, str(obj(f, "owner"), "token"), "binding")
	if e != nil {
		t.Fatal(e)
	}
	peer, e := devices.Authenticate(ctx, str(obj(f, "peer"), "token"), "binding")
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
	shares := &SharedSummaryService{Chat: s}
	a, b := Actor{Device: &owner}, Actor{Device: &peer}
	room := uuid.NewString()
	created, e := s.Create(ctx, a, encode(Object{"roomId": room, "operationId": uuid.NewString(), "title": "原共享摘要房间"}))
	if e != nil {
		t.Fatal(e)
	}
	decision := uuid.NewString()
	if _, e = s.Propose(ctx, a, room, encode(Object{"decisionId": decision, "expectedRevision": created["revision"], "action": "invite", "targetSubjectId": peer.SubjectID})); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Accept(ctx, b, room, encode(Object{"decisionId": decision})); e != nil {
		t.Fatal(e)
	}
	source, e := s.Send(ctx, b, room, encode(Object{"clientMessageId": uuid.NewString(), "text": "当前真实源消息"}))
	if e != nil {
		t.Fatal(e)
	}
	view, e := s.Get(ctx, a, room)
	if e != nil {
		t.Fatal(e)
	}
	ref := Object{"messageId": source["messageId"], "revision": int64(1)}
	input := Object{"shareId": uuid.NewString(), "roomId": room, "expectedMemberRevision": view["memberRevision"], "audience": "room-authorized-members", "content": Object{"generator": Object{"kind": "manual", "label": "本人选择"}, "coverage": Object{"fromSequence": "0", "throughSequence": "1", "complete": true}, "fragments": []any{Object{"id": uuid.NewString(), "kind": "derived", "text": "当前源的简短归纳", "sourceRefs": []any{ref}}}, "keyMessageRefs": []any{ref}}}
	server := httptest.NewServer(SharedSummaryHandler{Service: shares})
	defer server.Close()
	token := str(obj(f, "owner"), "token")
	archive.mu.Lock()
	archive.loseNext = true
	archive.mu.Unlock()
	status, result := chatRequest(t, server.URL, "/v2/chat/shared-summaries/publish", token, input)
	if status != 504 || str(result, "error") != "chat_delivery_unknown" {
		t.Fatalf("unknown shared send: %d %v", status, result)
	}
	receiptInput := Object{"roomId": room, "shareId": input["shareId"], "requestHash": canonical(input)}
	pending, e := shares.Receipt(ctx, a, encode(receiptInput))
	if e != nil || str(pending, "state") != "pending" {
		t.Fatalf("pending receipt: %v %v", pending, e)
	}
	status, published := chatRequest(t, server.URL, "/v2/chat/shared-summaries/publish", token, input)
	if status != 200 {
		t.Fatal(published)
	}
	if !truth(published, "acceptedByRoom") {
		t.Fatal(published)
	}
	status, js := chatRequest(t, str(f, "origin"), "/v2/chat/shared-summaries/get", str(obj(f, "peer"), "token"), Object{"roomId": room, "shareId": input["shareId"]})
	if status != 200 {
		t.Fatal(js)
	}
	same(t, published, js)
	receipt, e := shares.Receipt(ctx, a, encode(receiptInput))
	if e != nil {
		t.Fatal(e)
	}
	status, js = chatRequest(t, str(f, "origin"), "/v2/chat/shared-summaries/receipt", token, receiptInput)
	if status != 200 {
		t.Fatal(js)
	}
	same(t, receipt, js)
	archive.mu.Lock()
	notice := archive.bodies[str(published, "messageId")]
	if str(notice, "text") != str(summaryNotice(str(input, "shareId"), ""), "text") {
		t.Fatal("summary body copied into MAM")
	}
	if len(archive.sendIDs) != 3 || archive.sendIDs[1] != archive.sendIDs[2] {
		t.Fatal("unknown notice created a new message ID")
	}
	archive.mu.Unlock()
	input2 := cloneSummary(input)
	input2["shareId"] = uuid.NewString()
	input2["supersedesShareId"] = input["shareId"]
	status, js2 := chatRequest(t, str(f, "origin"), "/v2/chat/shared-summaries/publish", token, input2)
	if status != 200 {
		t.Fatal(js2)
	}
	current2, e := shares.Get(ctx, b, encode(Object{"roomId": room, "shareId": input2["shareId"]}))
	if e != nil {
		t.Fatal(e)
	}
	same(t, current2, js2)
	archive.mu.Lock()
	archive.loseNextEdit = true
	archive.mu.Unlock()
	edit := Object{"operationId": uuid.NewString(), "expectedRevision": int64(1), "text": "新的源版本"}
	if _, e = s.Edit(ctx, b, room, str(source, "messageId"), encode(edit)); fault.Code(e) != "chat_delivery_unknown" {
		t.Fatal(e)
	}
	temporary, e := shares.Get(ctx, a, encode(Object{"roomId": room, "shareId": input["shareId"]}))
	if e != nil || !truth(temporary, "sourcesTemporarilyUnavailable") || len(obj(temporary, "content")["fragments"].([]any)) != 0 {
		t.Fatalf("pending edit: %v %v", temporary, e)
	}
	status, js = chatRequest(t, str(f, "origin"), "/v2/chat/shared-summaries/get", token, Object{"roomId": room, "shareId": input["shareId"]})
	if status != 200 {
		t.Fatal(js)
	}
	same(t, temporary, js)
	var retained int
	if e = pool.QueryRow(ctx, "SELECT jsonb_array_length(content->'fragments') FROM room_shared_summaries WHERE share_id=$1", input["shareId"]).Scan(&retained); e != nil || retained != 1 {
		t.Fatalf("temporary source loss erased copy: %d %v", retained, e)
	}
	if _, e = s.Edit(ctx, b, room, str(source, "messageId"), encode(edit)); e != nil {
		t.Fatal(e)
	}
	purged, e := shares.PurgeInvalidSources(ctx, "", 20)
	if e != nil || num(purged, "changed") != 2 {
		t.Fatalf("permanent source change: %v %v", purged, e)
	}
	current, e := shares.Get(ctx, a, encode(Object{"roomId": room, "shareId": input["shareId"]}))
	if e != nil {
		t.Fatal(e)
	}
	status, js = chatRequest(t, str(f, "origin"), "/v2/chat/shared-summaries/get", token, Object{"roomId": room, "shareId": input["shareId"]})
	if status != 200 {
		t.Fatal(js)
	}
	same(t, current, js)
	archive.mu.Lock()
	archive.eraseNegative = true
	archive.mu.Unlock()
	withdrawn, e := shares.Retract(ctx, a, encode(Object{"roomId": room, "shareId": input["shareId"]}))
	if e != nil || !truth(withdrawn, "noticeCleanupPending") || truth(withdrawn, "noticeArchiveDeleted") {
		t.Fatalf("withdraw reservation: %v %v", withdrawn, e)
	}
	if _, e = s.Leave(ctx, a, room); e != nil {
		t.Fatal(e)
	}
	archive.mu.Lock()
	archive.eraseNegative = false
	archive.mu.Unlock()
	withdrawn, e = shares.Retract(ctx, a, encode(Object{"roomId": room, "shareId": input["shareId"]}))
	if e != nil || !truth(withdrawn, "noticeArchiveDeleted") {
		t.Fatalf("post-leave stop completion: %v %v", withdrawn, e)
	}
	receipt, e = shares.Receipt(ctx, a, encode(receiptInput))
	if e != nil {
		t.Fatal(e)
	}
	status, js = chatRequest(t, str(f, "origin"), "/v2/chat/shared-summaries/receipt", token, receiptInput)
	if status != 200 {
		t.Fatal(js)
	}
	same(t, receipt, js)
	if _, e = shares.Get(ctx, a, encode(Object{"roomId": room, "shareId": input["shareId"]})); fault.Code(e) != "chat_access_denied" {
		t.Fatalf("former member read shared copy: %v", e)
	}
}
