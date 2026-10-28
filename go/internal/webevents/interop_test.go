package webevents

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
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
func node(t *testing.T, dsn string, args ...string) []byte {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", append([]string{filepath.Join(root, "scripts/go/web-events-interop.mjs")}, args...)...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original JS: %v %s", e, out)
	}
	return out
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
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	var originalCatalog any
	if e := json.Unmarshal(node(t, dsn, "setup"), &originalCatalog); e != nil {
		t.Fatal(e)
	}
	// A producer change must update the one fixed catalog consumed by Go.
	if !reflect.DeepEqual(normalize(t, catalog), originalCatalog) {
		t.Fatal("Go catalog differs from current JS topics")
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
	var original any
	if e = json.Unmarshal(node(t, dsn, "read", "0", "model-settings"), &original); e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(normalize(t, frames), original) {
		t.Fatalf("Go/JS event mismatch: %v / %v", frames, original)
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
