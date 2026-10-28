package chat

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const testSecret = "isolated-component-secret-1234567890"

type archiveFixture struct {
	listener      net.Listener
	mu            sync.Mutex
	bodies        map[string]Object
	sendIDs       []string
	loseNext      bool
	loseNextEdit  bool
	eraseNegative bool
	probeBody     string
	readHook      func()
	connections   []net.Conn
}

func fakeArchive(t *testing.T) *archiveFixture {
	t.Helper()
	l, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	f := &archiveFixture{listener: l, bodies: map[string]Object{}}
	t.Cleanup(func() {
		l.Close()
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, c := range f.connections {
			c.Close()
		}
	})
	go func() {
		for {
			c, e := l.Accept()
			if e != nil {
				return
			}
			f.mu.Lock()
			f.connections = append(f.connections, c)
			f.mu.Unlock()
			go f.serve(c)
		}
	}()
	return f
}
func (f *archiveFixture) serve(c net.Conn) {
	defer c.Close()
	d := xml.NewDecoder(c)
	for {
		token, e := d.Token()
		if e != nil {
			return
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		if start.Name.Local == "stream" {
			io.WriteString(c, `<stream:stream xmlns='jabber:component:accept' xmlns:stream='http://etherx.jabber.org/streams' id='isolated-stream' from='gateway.example.invalid'>`)
			continue
		}
		if start.Name.Local == "handshake" {
			var sum string
			if d.DecodeElement(&sum, &start) != nil {
				return
			}
			digest := sha1.Sum([]byte("isolated-stream" + testSecret))
			if sum != hex.EncodeToString(digest[:]) {
				return
			}
			io.WriteString(c, "<handshake/>")
			continue
		}
		if start.Name.Local != "iq" {
			if d.Skip() != nil {
				return
			}
			continue
		}
		var stanza struct {
			Command string    `xml:"urn:galaxy:rooms:2 command"`
			Query   *struct{} `xml:"http://jabber.org/protocol/disco#info query"`
		}
		if d.DecodeElement(&stanza, &start) != nil {
			return
		}
		if stanza.Query != nil {
			f.mu.Lock()
			body := f.probeBody
			f.mu.Unlock()
			if body == "" {
				body = `<query xmlns='http://jabber.org/protocol/disco#info'><identity category='conference' type='text'/><feature var='http://jabber.org/protocol/muc'/></query>`
			}
			io.WriteString(c, `<iq type='result' from='rooms.example.invalid' to='gateway.example.invalid' id='`+attr(start, "id")+`'>`+body+`</iq>`)
			continue
		}
		var x Object
		if json.Unmarshal([]byte(stanza.Command), &x) != nil {
			return
		}
		result := Object{}
		f.mu.Lock()
		switch str(x, "action") {
		case "project":
			result["projected"] = true
		case "send":
			id := str(x, "messageId")
			f.sendIDs = append(f.sendIDs, id)
			if f.bodies[id] == nil {
				f.bodies[id] = Object{"archiveId": id, "text": x["text"], "revision": float64(1)}
			}
			result["archiveId"] = id
		case "read", "export-own":
			items := []any{}
			for _, id := range uniqueStrings(x["ids"]) {
				if body := f.bodies[id]; body != nil {
					copy := Object{}
					for k, v := range body {
						copy[k] = v
					}
					items = append(items, copy)
				}
			}
			result["messages"] = items
		case "edit":
			body := f.bodies[str(x, "messageId")]
			if body != nil {
				body["text"] = x["text"]
				body["revision"] = num(x, "expectedRevision") + 1
				result["revision"] = body["revision"]
			}
		case "erase":
			if !f.eraseNegative {
				delete(f.bodies, str(x, "messageId"))
			}
			result["archiveDeleted"] = !f.eraseNegative
		default:
			result["error"] = "unknown_command"
		}
		lose := str(x, "action") == "send" && f.loseNext
		if lose {
			f.loseNext = false
		}
		if str(x, "action") == "edit" && f.loseNextEdit {
			lose = true
			f.loseNextEdit = false
		}
		hook := f.readHook
		if str(x, "action") == "read" {
			f.readHook = nil
		} else {
			hook = nil
		}
		f.mu.Unlock()
		if hook != nil {
			hook()
		}
		if lose {
			continue
		}
		raw, _ := json.Marshal(result)
		if _, e := io.WriteString(c, `<iq type='result' from='rooms.example.invalid' to='gateway.example.invalid' id='`+attr(start, "id")+`'><result xmlns='`+roomsNS+`'>`+escaped(string(raw))+`</result></iq>`); e != nil {
			return
		}
	}
}
func chatNode(t *testing.T, dsn, command string, input Object) Object {
	t.Helper()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	args := []string{filepath.Join(root, "scripts", "go", "chat-interop.mjs"), command}
	if input != nil {
		args = append(args, string(encode(input)))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", args...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	b, e := cmd.Output()
	if e != nil {
		if ee, ok := e.(*exec.ExitError); ok {
			t.Fatalf("Node: %v %s", e, ee.Stderr)
		}
		t.Fatal(e)
	}
	var o Object
	if e = json.Unmarshal(b, &o); e != nil {
		t.Fatalf("%v %s", e, b)
	}
	return o
}

type testAuthorization struct{ revoked bool }
type testHTTPIdentity struct{ actor Actor }

func (a testHTTPIdentity) Account(_ *http.Request, _ bool) (string, Authorization, error) {
	return a.actor.AccountID, a.actor.Authority, nil
}

func (a *testAuthorization) Account(ctx context.Context, tx pgx.Tx, endpoint, id string) error {
	if a.revoked {
		return fail("official_account_login_required", 401)
	}
	var exists bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2)", id, endpoint).Scan(&exists)
	if e != nil {
		return e
	}
	if !exists {
		return fail("official_account_login_required", 401)
	}
	return nil
}
func same(t *testing.T, a, b any) {
	t.Helper()
	var x, y any
	json.Unmarshal(encode(a), &x)
	json.Unmarshal(encode(b), &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("projection differs\nGo %s\nJS %s", encode(a), encode(b))
	}
}
func TestPrivateChatOriginalProtocolAndReceipts(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	f := chatNode(t, dsn, "setup", nil)
	ids := uniqueStrings(f["accounts"])
	ctx := context.Background()
	archive := fakeArchive(t)
	serviceURL := "xmpp://" + archive.listener.Addr().String()
	transport, e := NewComponentTransport(serviceURL, "gateway.example.invalid", "rooms.example.invalid", testSecret, 200*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	if e = transport.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer transport.Stop()
	auth := &testAuthorization{}
	a, b := Actor{AccountID: ids[0], Authority: auth}, Actor{AccountID: ids[1], Authority: auth}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	s := &Service{Pool: pool, Endpoint: str(f, "endpoint"), Links: &accountlinks.Service{Pool: pool, Endpoint: str(f, "endpoint")}, Transport: transport, Rules: &businessrules.Service{Endpoint: str(f, "endpoint"), Now: now}, Now: now}
	room := uuid.NewString()
	create := Object{"roomId": room, "operationId": uuid.NewString(), "title": "原私聊"}
	first, e := s.Create(ctx, a, encode(create))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Create(ctx, a, encode(create)); e != nil {
		t.Fatal(e)
	}
	decision := uuid.NewString()
	d, e := s.Propose(ctx, a, room, encode(Object{"decisionId": decision, "expectedRevision": first["revision"], "action": "invite", "targetSubjectId": "account:" + b.AccountID}))
	if e != nil {
		t.Fatal(e)
	}
	if str(d, "state") != "approved" {
		t.Fatal(d)
	}
	_, e = s.Accept(ctx, b, room, encode(Object{"decisionId": decision}))
	if e != nil {
		t.Fatal(e)
	}
	handler := Handler{Service: s, Identity: testHTTPIdentity{b}}
	request := httptest.NewRequest("POST", "/v2/chat/rooms/"+room+"/read", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	request = httptest.NewRequest("POST", "/v2/chat/rooms/"+room+"/read", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "invalid")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 401 {
		t.Fatalf("authorization header fell back to cookie: %d", response.Code)
	}
	client := uuid.NewString()
	payload := Object{"clientMessageId": client, "text": "原私聊 🚀 <&>\u2028", "replyTo": nil}
	archive.mu.Lock()
	archive.loseNext = true
	archive.mu.Unlock()
	if _, e = s.Send(ctx, a, room, encode(payload)); fault.Code(e) != "chat_delivery_unknown" {
		t.Fatalf("unknown delivery: %v", e)
	}
	pending, e := s.MessageStatus(ctx, a, room, encode(Object{"clientMessageId": client, "requestHash": canonical(payload)}))
	if e != nil || str(pending, "state") != "pending" {
		t.Fatalf("pending: %v %v", pending, e)
	}
	accepted, e := s.Send(ctx, a, room, encode(payload))
	if e != nil {
		t.Fatal(e)
	}
	policy := resourcebudget.DefaultPolicy()
	policy.MaxPayloadBytesPerSubject = 0
	s.Resources, e = resourcebudget.New(&policy, now)
	if e != nil {
		t.Fatal(e)
	}
	blockedClient := uuid.NewString()
	if _, e = s.Send(ctx, a, room, encode(Object{"clientMessageId": blockedClient, "text": "超额增长"})); fault.Code(e) != "storage_quota_exceeded" {
		t.Fatalf("chat resource growth: %v", e)
	}
	var residue int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM chat_message_refs WHERE client_message_id=$1", blockedClient).Scan(&residue); e != nil || residue != 0 {
		t.Fatalf("resource failure left pending metadata: %d %v", residue, e)
	}
	s.Resources = nil
	if _, e = pool.Exec(ctx, "UPDATE operations_product_rules_v1 SET policy=jsonb_set(policy,'{features,chatSend}','false') WHERE endpoint=$1", s.Endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Send(ctx, a, room, encode(Object{"clientMessageId": uuid.NewString(), "text": "当前规则暂停"})); fault.Code(e) != "operations_feature_disabled" {
		t.Fatalf("chat current P14: %v", e)
	}
	if _, e = pool.Exec(ctx, "UPDATE operations_product_rules_v1 SET policy=jsonb_set(policy,'{features,chatSend}','true') WHERE endpoint=$1", s.Endpoint); e != nil {
		t.Fatal(e)
	}
	archive.mu.Lock()
	if len(archive.sendIDs) != 2 || archive.sendIDs[0] != archive.sendIDs[1] || len(archive.bodies) != 1 {
		t.Fatal("unknown result created a fresh message")
	}
	archive.mu.Unlock()
	snapshot := chatNode(t, dsn, "snapshot", Object{"account": a.AccountID, "room": room, "service": serviceURL, "clientMessageId": client, "requestHash": canonical(payload)})
	view, e := s.Get(ctx, a, room)
	if e != nil {
		t.Fatal(e)
	}
	same(t, view, snapshot["room"])
	eventReader := s.EventRead()
	principal := webevents.Principal{Kind: "official-account", Identity: a.AccountID, AccountID: a.AccountID, Endpoint: s.Endpoint, Surface: "web", Actor: auth}
	eventView, e := eventReader(ctx, principal, room, "")
	if e != nil {
		t.Fatal(e)
	}
	same(t, eventView, view)
	history, e := s.History(ctx, a, room, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	same(t, history, snapshot["history"])
	receipt, e := s.MessageStatus(ctx, a, room, encode(Object{"clientMessageId": client, "requestHash": canonical(payload)}))
	if e != nil {
		t.Fatal(e)
	}
	same(t, receipt, snapshot["receipt"])
	jsSend := chatNode(t, dsn, "send", Object{"account": b.AccountID, "room": room, "service": serviceURL, "payload": Object{"clientMessageId": uuid.NewString(), "text": "原 JS 回复", "replyTo": accepted["messageId"]}})
	if str(jsSend, "state") != "accepted" {
		t.Fatal(jsSend)
	}
	history, e = s.History(ctx, a, room, []byte(`{}`))
	if e != nil || len(history["messages"].([]Object)) != 2 {
		t.Fatalf("Go reads JS reply: %v %v", history, e)
	}
	editInput := Object{"operationId": uuid.NewString(), "expectedRevision": int64(1), "text": "原编辑，操作号保持。"}
	edited, e := s.Edit(ctx, a, room, str(accepted, "messageId"), encode(editInput))
	if e != nil {
		t.Fatal(e)
	}
	replayed, e := s.Edit(ctx, a, room, str(accepted, "messageId"), encode(editInput))
	if e != nil {
		t.Fatal(e)
	}
	same(t, edited, replayed)
	status, e := s.OperationStatus(ctx, a, room, encode(Object{"operationId": editInput["operationId"], "requestHash": canonical(editInput)}))
	if e != nil {
		t.Fatal(e)
	}
	if str(status, "state") != "acknowledged" || num(status, "revision") != 2 {
		t.Fatal(status)
	}
	contextView, e := s.Context(ctx, a, room, str(accepted, "messageId"), []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	snapshot = chatNode(t, dsn, "snapshot", Object{"account": a.AccountID, "room": room, "service": serviceURL, "clientMessageId": client, "requestHash": canonical(payload), "edit": Object{"operationId": editInput["operationId"], "requestHash": canonical(editInput)}, "message": accepted["messageId"], "directory": Object{}, "people": Object{"accountIds": []string{a.AccountID, b.AccountID}}})
	same(t, status, snapshot["edit"])
	same(t, contextView, snapshot["context"])
	directory, e := s.Directory(ctx, a, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	same(t, directory, snapshot["directory"])
	people, e := s.People(ctx, a, encode(Object{"accountIds": []string{a.AccountID, b.AccountID}}))
	if e != nil {
		t.Fatal(e)
	}
	same(t, people, snapshot["people"])
	history, e = s.History(ctx, a, room, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	same(t, history, snapshot["history"])
	cursor, e := s.Cursor(ctx, a, room, encode(Object{"sequence": str(history["messages"].([]Object)[1], "sequence"), "visibleMessageIds": []any{accepted["messageId"], jsSend["messageId"]}}))
	if e != nil || str(cursor, "kind") != "human" {
		t.Fatalf("cursor: %v %v", cursor, e)
	}
	directory, e = s.Directory(ctx, a, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	if num(directory["rooms"].([]Object)[0], "unreadHumanCount") != 0 {
		t.Fatalf("explicit human reads not reflected: %v", directory)
	}
	archive.mu.Lock()
	archive.readHook = func() {
		_, e := pool.Exec(ctx, `INSERT INTO chat_message_preferences(room_id,subject_id,message_id,hidden,updated_at) VALUES($1,$2,$3,true,$4)`, room, "account:"+a.AccountID, accepted["messageId"], now())
		if e != nil {
			panic(e)
		}
	}
	archive.mu.Unlock()
	history, e = s.History(ctx, a, room, []byte(`{}`))
	if e != nil || len(history["messages"].([]Object)) != 1 {
		t.Fatalf("post-I/O hide failed: %v %v", history, e)
	}
	retracted, e := s.Retract(ctx, b, room, str(jsSend, "messageId"))
	if e != nil || !truth(retracted, "archiveDeleted") {
		t.Fatalf("retract: %v %v", retracted, e)
	}
	history, e = s.History(ctx, a, room, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	if len(history["messages"].([]Object)) != 1 || history["messages"].([]Object)[0]["text"] != nil {
		t.Fatalf("retracted text exposed: %v", history)
	}
	if _, e = s.Leave(ctx, a, room); e != nil {
		t.Fatal(e)
	}
	if _, e = s.History(ctx, a, room, []byte(`{}`)); fault.Code(e) != "chat_access_denied" {
		t.Fatalf("former member read: %v", e)
	}
	if _, e = eventReader(ctx, principal, room, ""); fault.Code(e) != "chat_access_denied" {
		t.Fatalf("event ignored membership: %v", e)
	}
	receipt, e = s.MessageStatus(ctx, a, room, encode(Object{"clientMessageId": client, "requestHash": canonical(payload)}))
	if e != nil || !truth(receipt, "historicalAcceptanceRecorded") || truth(receipt, "contentReturned") {
		t.Fatalf("owned receipt: %v %v", receipt, e)
	}
	auth.revoked = true
	if _, e = s.MessageStatus(ctx, a, room, encode(Object{"clientMessageId": client, "requestHash": canonical(payload)})); fault.Code(e) != "official_account_login_required" {
		t.Fatal(e)
	}
}
