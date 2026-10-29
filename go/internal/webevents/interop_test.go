package webevents

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
)

type fixtureAuthority struct {
	mu                             sync.Mutex
	revoked, transient, denyModule bool
}

func (a *fixtureAuthority) AuthorizeConnection(_ context.Context, _ *http.Request, surface string) (Principal, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.transient {
		return Principal{}, fault.New("temporary", 503)
	}
	if a.revoked {
		return Principal{}, fault.New("revoked", 401)
	}
	return Principal{Identity: "fixture", Endpoint: "https://events.invalid", Surface: surface}, nil
}
func (a *fixtureAuthority) AuthorizeModule(_ context.Context, _ Principal, _ string) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return !a.denyModule, nil
}
func (a *fixtureAuthority) AuthorizeSource(context.Context, Principal, Event) (SourceDecision, error) {
	return Denied, fault.New("domain_authority_unavailable", 503)
}
func normalize(t *testing.T, v any) any {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	var out any
	if e = json.Unmarshal(b, &out); e != nil {
		t.Fatal(e)
	}
	return out
}
func TestCurrentSchemaInteropAndHTTP(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	if _, e := databaseschema.Migrate(ctx, pool, nil); e != nil {
		t.Fatal(e)
	}
	// Captured from the original Node reader and its topics catalog.
	var originalCatalog any
	fixture, e := os.ReadFile("testdata/original-catalog.json")
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(fixture, &originalCatalog); e != nil {
		t.Fatal(e)
	}
	// The current catalog must preserve the captured browser wire mapping.
	if !reflect.DeepEqual(normalize(t, catalog), originalCatalog) {
		t.Fatal("Go catalog differs from captured topics")
	}
	auth := &fixtureAuthority{}
	s := &Service{Pool: pool, Endpoint: "https://events.invalid", Authority: auth}
	defer s.Stop()
	request := httptest.NewRequest("GET", "/v1/operations/web-events", nil)
	connect := func(topics ...string) *Connection {
		c, e := s.Connect(ctx, request, "admin", topics)
		if e != nil {
			t.Fatal(e)
		}
		return c
	}
	execSQL := func(sql string, args ...any) {
		t.Helper()
		if _, e := pool.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	execSQL("SELECT galaxy_web_events_promote_v1(256)")
	execSQL("TRUNCATE web_event_log_v1")
	execSQL("UPDATE web_event_sequence_v1 SET cursor=0")
	// An earlier outbox allocation is uncommitted when the later writer commits.
	first, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer first.Rollback(ctx)
	if _, e = first.Exec(ctx, "INSERT INTO operations_model_settings_state_v1(endpoint,updated_at) VALUES('https://events.invalid',now())"); e != nil {
		t.Fatal(e)
	}
	execSQL("INSERT INTO operations_model_settings_state_v1(endpoint,updated_at) VALUES('https://other.invalid',now())")
	if _, e = s.Position(ctx); e != nil {
		t.Fatal(e)
	}
	if e = first.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Position(ctx); e != nil {
		t.Fatal(e)
	}
	var endpoints []string
	rows, e := pool.Query(ctx, "SELECT endpoint FROM web_event_log_v1 ORDER BY cursor")
	if e != nil {
		t.Fatal(e)
	}
	for rows.Next() {
		var v string
		rows.Scan(&v)
		endpoints = append(endpoints, v)
	}
	rows.Close()
	if !reflect.DeepEqual(endpoints, []string{"https://other.invalid", "https://events.invalid"}) {
		t.Fatalf("commit sequence %v", endpoints)
	}
	zero := "0"
	c := connect("model-settings")
	frames, e := s.Read(ctx, c, &zero)
	if e != nil {
		t.Fatal(e)
	}
	// Exact original frame projection captured for this isolated scenario.
	var original any
	if e = json.Unmarshal([]byte(`[{"cursor":"2","module":"model-settings","operationId":null,"type":"change","version":"0"},{"cursor":"2","modules":["model-settings"],"type":"snapshot"}]`), &original); e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(normalize(t, frames), original) {
		t.Fatalf("event projection mismatch: %v / %v", frames, original)
	}
	if len(frames) != 2 || frames[0].Type != "change" || frames[0].Cursor != "2" {
		t.Fatalf("endpoint isolation: %+v", frames)
	}
	b, _ := json.Marshal(frames)
	if strings.Contains(string(b), "source_ref") || strings.Contains(string(b), "endpoint") {
		t.Fatal("private source in browser frame")
	}
	high := frames[len(frames)-1].Cursor
	auth.mu.Lock()
	auth.denyModule = true
	auth.mu.Unlock()
	revoked, e := s.Read(ctx, c, &high)
	if e != nil || len(revoked) != 2 || len(revoked[0].Modules) != 1 {
		t.Fatalf("module revocation: %+v %v", revoked, e)
	}
	auth.mu.Lock()
	auth.denyModule = false
	auth.mu.Unlock()
	// Ordinary directory observations do not reset unrelated management modules.
	execSQL("INSERT INTO operations_management_directory_v1(endpoint,issuer,last_completed_at) VALUES('https://events.invalid','https://issuer.invalid',now()) ON CONFLICT(endpoint) DO UPDATE SET last_completed_at=now()")
	f, e := s.Read(ctx, connect("model-settings", "agentos"), &high)
	if e != nil {
		t.Fatal(e)
	}
	for _, v := range f {
		if v.Type == "reset" {
			t.Fatalf("directory caused broad reset: %+v", f)
		}
	}
	high = f[len(f)-1].Cursor
	execSQL("DELETE FROM operations_model_settings_state_v1 WHERE endpoint='https://events.invalid'")
	f, e = s.Read(ctx, connect("model-settings"), &high)
	if e != nil || len(f) != 2 || f[0].Type != "reset" {
		t.Fatalf("source deletion %+v %v", f, e)
	}
	// Two subscriptions share one physical LISTEN connection, with active LISTEN
	// established before Subscribe returns.
	_, unsubA, e := s.Subscribe(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer unsubA()
	_, unsubB, e := s.Subscribe(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer unsubB()
	var listeners int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE query='LISTEN galaxy_web_event_pending_v1; LISTEN galaxy_web_event_ready_v1'").Scan(&listeners); e != nil || listeners != 1 {
		t.Fatalf("listeners=%d %v", listeners, e)
	}
	server := httptest.NewServer(Handler{Service: s, Heartbeat: 30 * time.Millisecond})
	defer server.Close()
	for _, path := range []string{"?cursor=01", "?topics=model-settings,model-settings", "?stream=bad", "?cursor=0&cursor=1", "?unknown=1"} {
		resp, e := http.Get(server.URL + "/v1/operations/web-events" + path)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("validation %s=%d", path, resp.StatusCode)
		}
	}
	resp, e := http.Get(server.URL + "/v1/operations/web-events?stream=false&topics=model-settings")
	if e != nil {
		t.Fatal(e)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), `"snapshot"`) {
		t.Fatalf("HTTP poll %d %s", resp.StatusCode, body)
	}
	stream := func() *http.Response {
		resp, e := http.Get(server.URL + "/v1/operations/web-events?topics=model-settings")
		if e != nil {
			t.Fatal(e)
		}
		return resp
	}
	resp = stream()
	reader := bufio.NewReader(resp.Body)
	for {
		line, e := reader.ReadString('\n')
		if e != nil {
			t.Fatal(e)
		}
		if strings.Contains(line, `"snapshot"`) {
			break
		}
	}
	auth.mu.Lock()
	auth.transient = true
	auth.mu.Unlock()
	remaining, e := io.ReadAll(reader)
	resp.Body.Close()
	if e != nil || strings.Contains(string(remaining), `"reset"`) {
		t.Fatalf("temporary failure reset %s %v", remaining, e)
	}
	auth.mu.Lock()
	auth.transient = false
	auth.mu.Unlock()
	resp = stream()
	reader = bufio.NewReader(resp.Body)
	for {
		line, e := reader.ReadString('\n')
		if e != nil {
			t.Fatal(e)
		}
		if strings.Contains(line, `"snapshot"`) {
			break
		}
	}
	auth.mu.Lock()
	auth.revoked = true
	auth.mu.Unlock()
	remaining, e = io.ReadAll(reader)
	resp.Body.Close()
	if e != nil || !strings.Contains(string(remaining), `"reset"`) {
		t.Fatalf("confirmed revocation did not reset %s %v", remaining, e)
	}
	auth.mu.Lock()
	auth.revoked = false
	auth.mu.Unlock()
	execSQL("UPDATE web_event_log_v1 SET committed_at=now()-interval '8 days'")
	f, e = s.Read(ctx, connect("model-settings"), &zero)
	if e != nil || len(f) != 2 || f[0].Type != "reset" {
		t.Fatalf("retention gap %+v %v", f, e)
	}
	_, e = s.Connect(ctx, request, "web", []string{"forum"})
	if e != nil {
		t.Fatal(e)
	}
	decision, e := s.authorizeSource(ctx, Principal{Identity: "fixture", Endpoint: s.Endpoint, Surface: "web"}, Event{SourceTable: "forum_posts_v1", Module: "forum", Ref: map[string]any{"id": "private"}})
	if decision != Denied || fault.Status(e) != 503 {
		t.Fatal("unconnected public domain was allowed")
	}
}

func TestAgentOSChangesIdentifyOwnedRows(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	if _, err := databaseschema.Migrate(ctx, pool, nil); err != nil {
		t.Fatal(err)
	}
	s := &Service{Pool: pool, Endpoint: "https://events.invalid", Authority: &fixtureAuthority{}}
	defer s.Stop()
	const conversation = "11111111-1111-4111-8111-111111111111"
	const foreignConversation = "22222222-2222-4222-8222-222222222222"
	const turn = "33333333-3333-4333-8333-333333333333"
	const foreignTurn = "44444444-4444-4444-8444-444444444444"
	const tool = "55555555-5555-4555-8555-555555555555"
	const card = "66666666-6666-4666-8666-666666666666"
	const cardOperation = "77777777-7777-4777-8777-777777777777"
	execSQL := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	execSQL(`INSERT INTO operations_agentos_conversations_v1(id,endpoint,operator_id,domain,permission_key,session_id,created_at) VALUES ($1,$2,'fixture','overview','workbench.read','88888888-8888-4888-8888-888888888888',now()),($3,$2,'other','overview','workbench.read','99999999-9999-4999-8999-999999999999',now())`, conversation, s.Endpoint, foreignConversation)
	execSQL(`INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES ($1,$2,$3,'fixture','digest','dispatching','{}',now()),($4,$2,$5,'other','digest','dispatching','{}',now())`, turn, s.Endpoint, conversation, foreignTurn, foreignConversation)
	execSQL(`INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,'run','call','prepare-operation','digest','started',now(),now())`, tool, s.Endpoint, conversation, turn)
	execSQL(`INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'fixture','overview',$6,'digest','{}','prepared',now(),now())`, card, s.Endpoint, conversation, turn, tool, cardOperation)
	cursor, err := s.Position(ctx)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := s.Connect(ctx, httptest.NewRequest("GET", "/v1/operations/web-events", nil), "admin", []string{"agentos"})
	if err != nil {
		t.Fatal(err)
	}
	execSQL(`UPDATE operations_agentos_conversation_commands_v1 SET state='accepted' WHERE id IN ($1,$2)`, turn, foreignTurn)
	execSQL(`UPDATE operations_agentos_conversation_tool_calls_v1 SET state='completed' WHERE id=$1`, tool)
	execSQL(`UPDATE operations_agentos_conversation_cards_v1 SET state='processing' WHERE id=$1`, card)
	frames, err := s.Read(ctx, connection, &cursor)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Frame{}
	for _, frame := range frames {
		if frame.Type == "change" {
			if frame.ObjectID == foreignTurn {
				t.Fatal("foreign operator locator leaked")
			}
			got[frame.Entity] = frame
		}
	}
	if len(got) != 3 {
		t.Fatalf("unexpected frames: %+v", frames)
	}
	for _, want := range []struct{ entity, id string }{{"conversation-operation", turn}, {"conversation-tool", tool}, {"conversation-card", card}} {
		f := got[want.entity]
		if f.ObjectID != want.id || f.ParentID != conversation || f.TurnID != turn {
			t.Fatalf("bad %s locator: %+v", want.entity, f)
		}
	}
	if f := got["conversation-operation"]; f.OperationID != nil {
		t.Fatalf("command event must use its row id, not an invented operation_id: %+v", f)
	}
	if f := got["conversation-card"]; f.OperationID == nil || *f.OperationID != cardOperation {
		t.Fatalf("card receipt id differs from its turn: %+v", f)
	}
	// A disappeared source cannot provide a current owner or locator. It should
	// request background resync without disclosing its old ID or clearing scope.
	const removedTurn = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	execSQL(`INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,'fixture','digest','dispatching','{}',now())`, removedTurn, s.Endpoint, conversation)
	cursor, err = s.Position(ctx)
	if err != nil {
		t.Fatal(err)
	}
	execSQL(`DELETE FROM operations_agentos_conversation_commands_v1 WHERE id=$1`, removedTurn)
	frames, err = s.Read(ctx, connection, &cursor)
	if err != nil {
		t.Fatal(err)
	}
	var resync bool
	for _, f := range frames {
		if f.Type == "reset" {
			t.Fatalf("missing source cleared scope: %+v", f)
		}
		if f.Type == "change" {
			if f.Entity != "" || f.ObjectID != "" || f.ParentID != "" || f.TurnID != "" {
				t.Fatalf("missing source leaked locator: %+v", f)
			}
			resync = true
		}
	}
	if !resync {
		t.Fatalf("missing source did not request resync: %+v", frames)
	}
}
