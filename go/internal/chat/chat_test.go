package chat

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/chatarchivefixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const testSecret = "isolated-component-secret-1234567890"

// The shared fixture is a synthetic loopback component, not a deployed Prosody.
func fakeArchive(t *testing.T) *chatarchivefixture.Fixture { return chatarchivefixture.New(t) }

func chatNode(t *testing.T, dsn, command string, input Object) Object {
	t.Helper()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	args := []string{filepath.Join(root, "scripts", "go", "protocol-codec-fixture.mjs"), command}
	if input != nil {
		args = append(args, string(encode(input)))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", args...)
	cmd.Dir = root
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
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, pool, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	endpoint := "https://go-chat.example.invalid"
	ids := []string{uuid.NewString(), uuid.NewString()}
	for index, id := range ids {
		if _, err := pool.Exec(ctx, `INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1::uuid,$2,'https://login.example.invalid',($1::uuid)::text,'external-account',$3,$3)`, id, endpoint, time.Unix(2000000000, 0)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,query_enabled,updated_at) VALUES($1,'person',$2,false,$3)`, id, []string{"聊天甲", "聊天乙"}[index], time.Unix(2000000000, 0)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3)`, endpoint, operationsrules.EmptyControls(), time.Unix(2000000000, 0)); err != nil {
		t.Fatal(err)
	}
	archive := fakeArchive(t)
	serviceURL := "xmpp://" + archive.Listener.Addr().String()
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
	s := &Service{Pool: pool, Endpoint: endpoint, Links: &accountlinks.Service{Pool: pool, Endpoint: endpoint}, Transport: transport, Rules: &businessrules.Service{Endpoint: endpoint, Now: now}, Now: now}
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
	archive.Mu.Lock()
	archive.LoseNext = true
	archive.Mu.Unlock()
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
	archive.Mu.Lock()
	if len(archive.SendIDs) != 2 || archive.SendIDs[0] != archive.SendIDs[1] || len(archive.Bodies) != 1 {
		t.Fatal("unknown result created a fresh message")
	}
	archive.Mu.Unlock()
	view, e := s.Get(ctx, a, room)
	if e != nil {
		t.Fatal(e)
	}
	if str(view, "roomId") != room || str(view, "title") != "原私聊" {
		t.Fatal("room read changed", view)
	}
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
	if len(history["messages"].([]Object)) != 1 || str(history["messages"].([]Object)[0], "messageId") != str(accepted, "messageId") {
		t.Fatal("accepted history changed", history)
	}
	receipt, e := s.MessageStatus(ctx, a, room, encode(Object{"clientMessageId": client, "requestHash": canonical(payload)}))
	if e != nil {
		t.Fatal(e)
	}
	if str(receipt, "state") != "accepted" && !truth(receipt, "historicalAcceptanceRecorded") {
		t.Fatal("accepted receipt changed", receipt)
	}
	jsSend, e := s.Send(ctx, b, room, encode(Object{"clientMessageId": uuid.NewString(), "text": "合成对方回复", "replyTo": accepted["messageId"]}))
	if e != nil {
		t.Fatal(e)
	}
	if str(jsSend, "state") != "accepted" {
		t.Fatal(jsSend)
	}
	history, e = s.History(ctx, a, room, []byte(`{}`))
	if e != nil || len(history["messages"].([]Object)) != 2 {
		t.Fatalf("Go reads peer reply: %v %v", history, e)
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
	if str(contextView, "roomId") != room || str(contextView, "messageId") != str(accepted, "messageId") {
		t.Fatal("message context changed", contextView)
	}
	directory, e := s.Directory(ctx, a, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	if len(directory["rooms"].([]Object)) != 1 {
		t.Fatal("room directory changed", directory)
	}
	people, e := s.People(ctx, a, encode(Object{"accountIds": []string{a.AccountID, b.AccountID}}))
	if e != nil {
		t.Fatal(e)
	}
	if len(people["items"].([]Object)) != 2 {
		t.Fatal("people projection changed", people)
	}
	history, e = s.History(ctx, a, room, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	if len(history["messages"].([]Object)) != 2 {
		t.Fatal("edited history changed", history)
	}
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
	archive.Mu.Lock()
	archive.ReadHook = func() {
		_, e := pool.Exec(ctx, `INSERT INTO chat_message_preferences(room_id,subject_id,message_id,hidden,updated_at) VALUES($1,$2,$3,true,$4)`, room, "account:"+a.AccountID, accepted["messageId"], now())
		if e != nil {
			panic(e)
		}
	}
	archive.Mu.Unlock()
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
