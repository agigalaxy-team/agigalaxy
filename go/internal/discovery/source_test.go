package discovery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type accountAuthority struct{}

func (accountAuthority) Account(context.Context, pgx.Tx, string, string) error { return nil }
func originalNode(t *testing.T, dsn string, script bool, args ...string) []byte {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	command := []string{}
	if script {
		command = append(command, "--input-type=module", "-e")
	} else {
		command = append(command, filepath.Join(root, "scripts/go/community-interop.mjs"))
	}
	command = append(command, args...)
	cmd := exec.Command("node", command...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	raw, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original isolated fixture %v %s", e, raw)
	}
	return raw
}
func TestOriginalPublicSourceAndActualIndexSearchUnderWorkerRole(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	var fixture Object
	if e := decode(originalNode(t, dsn, false, "setup"), &fixture); e != nil {
		t.Fatal(e)
	}
	endpoint := str(fixture, "endpoint")
	root, _ := filepath.Abs("../../..")
	for _, name := range []string{"api-role.sql", "worker-role.sql"} {
		raw, e := os.ReadFile(filepath.Join(root, "packages/galaxy-official/src/infrastructure", name))
		if e != nil {
			t.Fatal(e)
		}
		if _, e = pool.Exec(ctx, string(raw)); e != nil {
			t.Fatal(e)
		}
	}
	account := fixture["accounts"].([]any)[0].(string)
	payload := object(fixture["payload"])
	now := func() time.Time { return time.Unix(2_000_000_000, 0) }
	forum := &community.Service{Pool: pool, Endpoint: endpoint, Authority: accountAuthority{}, Now: now}
	if _, e := forum.Publish(ctx, account, jsonString(payload)); e != nil {
		t.Fatal("real forum publication", e)
	}
	config, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	workerPool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer workerPool.Close()
	source := &CommunitySource{Pool: workerPool, Forum: forum, Endpoint: endpoint, Worker: true}
	reference := Reference{Kind: "post", ID: str(payload, "postId")}
	document, e := source.Load(ctx, reference)
	if e != nil || document == nil {
		t.Fatalf("actual restricted source: %v %+v", e, document)
	}
	script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import{createDiscoveryReadOnlySource}from './packages/galaxy-official/src/discovery-runtime/public-content-source.mjs';const db=new pg.Pool({connectionString:process.env.GALAXY_GO_TEST_DATABASE_URL});try{const s=createDiscoveryReadOnlySource({db,endpoint:process.argv[1],now:()=>2000000000});const d=await s.load(JSON.parse(process.argv[2]));console.log(JSON.stringify({document:d,view:s.view(d)}))}finally{await db.end()}`
	var original Object
	if e = decode(originalNode(t, dsn, true, script, endpoint, jsonString(reference)), &original); e != nil {
		t.Fatal(e)
	}
	var got Object
	_ = decode([]byte(jsonString(document)), &got)
	if !reflect.DeepEqual(got, object(original["document"])) {
		t.Fatalf("source projection/hash differs Go %s JS %s", jsonString(got), jsonString(original["document"]))
	}
	var view Object
	_ = decode([]byte(jsonString(View(document))), &view)
	if !reflect.DeepEqual(view, object(original["view"])) {
		t.Fatalf("view differs Go %s JS %s", jsonString(view), jsonString(original["view"]))
	}
	var mu sync.Mutex
	paths := []string{}
	hits := []Object{}
	indexed := Object{}
	var revokeOnUpsert atomic.Bool
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		paths = append(paths, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/tasks/1":
			_, _ = w.Write([]byte(`{"status":"succeeded"}`))
		case strings.HasSuffix(r.URL.Path, "/documents") && r.Method == "POST":
			var docs []Object
			_ = json.NewDecoder(r.Body).Decode(&docs)
			indexed = docs[0]
			if revokeOnUpsert.Swap(false) {
				if _, e := pool.Exec(ctx, "UPDATE forum_permissions_v1 SET revoked_at=$2 WHERE object_id=$1", str(payload, "versionId"), now()); e != nil {
					t.Error(e)
				}
			}
			_, _ = w.Write([]byte(`{"taskUid":1}`))
		case strings.HasSuffix(r.URL.Path, "/search"):
			_, _ = w.Write([]byte(jsonString(Object{"hits": hits, "estimatedTotalHits": 999999, "rawSecret": "must-not-escape"})))
		case strings.Contains(r.URL.Path, "/documents/"):
			_, _ = w.Write([]byte(`{"taskUid":1}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer engine.Close()
	key := strings.Repeat("synthetic-", 5)
	meili, e := NewMeilisearch(engine.URL, key, "", ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	gorse, e := NewGorse(engine.URL, key, ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	store := &Store{Pool: workerPool, Endpoint: endpoint, Now: now}
	if e = store.Initialize(ctx); e != nil {
		t.Fatal(e)
	}
	runtime := &Runtime{Store: store, Source: source, Meili: meili, Gorse: gorse, Now: now}
	worker := &Worker{Runtime: runtime}
	if _, e = worker.SeedBatch(ctx, 100); e != nil {
		t.Fatal(e)
	}
	result, e := worker.IndexOne(ctx)
	if e != nil || str(result, "state") != "indexed" {
		t.Fatalf("real outbox -> HTTP index %s %v", jsonString(result), e)
	}
	mu.Lock()
	if indexed["version"] != document.IndexVersion {
		t.Errorf("indexed version %+v", indexed)
	}
	hits = []Object{{"id": document.ID, "version": document.IndexVersion, "title": "untrusted indexed title"}}
	mu.Unlock()
	result, e = runtime.Search(ctx, Object{"query": "银河"})
	if e != nil || len(result["items"].([]Object)) != 1 || strings.Contains(jsonString(result), "must-not-escape") || strings.Contains(jsonString(result), "untrusted indexed title") {
		t.Fatalf("qualified search %s %v", jsonString(result), e)
	}
	// Real API-role event persistence is separate from the read-only worker pool.
	apiConfig, _ := pgxpool.ParseConfig(dsn)
	apiConfig.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	apiPool, e := pgxpool.NewWithConfig(ctx, apiConfig)
	if e != nil {
		t.Fatal(e)
	}
	defer apiPool.Close()
	var submitted atomic.Int32
	var nativeVisible atomic.Bool
	var dropACK atomic.Bool
	dropACK.Store(true)
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/track" {
			submitted.Add(1)
			if dropACK.Swap(false) {
				connection, _, e := w.(http.Hijacker).Hijack()
				if e == nil {
					_ = connection.Close()
				}
				return
			}
			_, _ = w.Write([]byte(`{}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/events") && nativeVisible.Load() {
			var properties Object
			_ = json.Unmarshal([]byte(r.URL.Query().Get("properties")), &properties)
			_, _ = w.Write([]byte(jsonString(Object{"items": []Object{{"properties": properties}}})))
			return
		}
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	defer panel.Close()
	openpanel, e := NewOpenPanel(OpenPanelConfiguration{URL: panel.URL, ClientID: uuid.NewString(), ReadClientID: uuid.NewString(), ProjectID: uuid.NewString(), ClientSecret: key, ReadClientSecret: key}, ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	openpanel.Now = now
	runtime.OpenPanel = openpanel
	apiRuntime := &Runtime{Store: &Store{Pool: apiPool, Endpoint: endpoint, Now: now}, Source: &CommunitySource{Pool: apiPool, Forum: forum, Endpoint: endpoint}, OpenPanel: openpanel, Now: now}
	visitor := UsageIdentity{VisitorID: uuid.NewString()}
	pageview := Object{"eventId": uuid.NewString(), "name": "pageview", "pageKey": "home"}
	accepted, e := apiRuntime.RecordUsage(ctx, visitor, pageview, "SyntheticBrowser/1")
	if e != nil || accepted["replayed"] != false {
		t.Fatalf("API event acceptance %s %v", jsonString(accepted), e)
	}
	if replay, e := apiRuntime.RecordUsage(ctx, visitor, pageview, "SyntheticBrowser/2"); e != nil || replay["replayed"] != true {
		t.Fatalf("event replay transport ignored %s %v", jsonString(replay), e)
	}
	if delivery, e := worker.DeliverOne(ctx); e != nil || str(delivery, "state") != "failed" {
		t.Fatalf("native ACK loss %s %v", jsonString(delivery), e)
	}
	due := func() {
		t.Helper()
		if _, e := pool.Exec(ctx, "UPDATE discovery_delivery_outbox_v1 SET next_attempt_at=$2 WHERE event_id=$1", pageview["eventId"], now()); e != nil {
			t.Fatal(e)
		}
	}
	due()
	if delivery, e := worker.DeliverOne(ctx); e != nil || str(delivery, "state") != "result-unknown" || submitted.Load() != 1 {
		t.Fatalf("unknown accepted event re-sent %s %v count %d", jsonString(delivery), e, submitted.Load())
	}
	nativeVisible.Store(true)
	due()
	if delivery, e := worker.DeliverOne(ctx); e != nil || str(delivery, "state") != "confirmed" || submitted.Load() != 1 {
		t.Fatalf("native receipt confirmation %s %v count %d", jsonString(delivery), e, submitted.Load())
	}
	viewEvent := Object{"eventId": uuid.NewString(), "name": "content-view", "pageKey": "community", "content": Object{"kind": "post", "id": reference.ID, "version": document.Version}}
	if _, e = apiRuntime.RecordUsage(ctx, visitor, viewEvent, "SyntheticBrowser/1"); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 2; i++ {
		if delivery, e := worker.DeliverOne(ctx); e != nil || str(delivery, "state") != "delivered" {
			t.Fatalf("qualified event target %s %v", jsonString(delivery), e)
		}
	}
	var stored []byte
	if e = pool.QueryRow(ctx, "SELECT payload FROM discovery_usage_events_v1 WHERE id=$1", viewEvent["eventId"]).Scan(&stored); e != nil || strings.Contains(string(stored), str(payload, "body")) {
		t.Fatalf("body entered analytics or DB read failed %v", e)
	}
	viewEvent["accountId"] = uuid.NewString()
	if _, e = apiRuntime.RecordUsage(ctx, visitor, viewEvent, "SyntheticBrowser/1"); fault.Code(e) != "invalid_discovery_request" {
		t.Fatalf("caller supplied account accepted %v", e)
	}
	// An ordinary current-source revocation hides an otherwise matching native
	// candidate immediately and schedules durable removal, without cached grants.
	if e = store.Enqueue(ctx, reference); e != nil {
		t.Fatal(e)
	}
	revokeOnUpsert.Store(true)
	result, e = worker.IndexOne(ctx)
	if e != nil || str(result, "state") != "source-changed" {
		t.Fatalf("source revoked after native write %s %v", jsonString(result), e)
	}
	result, e = runtime.Search(ctx, Object{"query": "银河"})
	if e != nil || len(result["items"].([]Object)) != 0 {
		t.Fatalf("revoked candidate leaked %s %v", jsonString(result), e)
	}
	result, e = worker.IndexOne(ctx)
	if e != nil || str(result, "state") != "removed" {
		t.Fatalf("revoked index removal %s %v", jsonString(result), e)
	}
	// Actual loopback HTTP collector: signed visitor continuity, separate CSRF,
	// current ambient account guard, closed body and original event-only purpose.
	var ambient atomic.Bool
	insecure := false
	handler := Handler{Runtime: apiRuntime, WebsiteOrigin: "https://website.example.invalid", VisitorSecret: strings.Repeat("synthetic-visitor-", 3), SecureCookies: &insecure, CurrentAccount: func(*http.Request) (bool, error) { return ambient.Load(), nil }}
	website := httptest.NewServer(handler)
	defer website.Close()
	jar, _ := cookiejar.New(nil)
	browser := &http.Client{Jar: jar}
	response, e := browser.Get(website.URL + "/v1/discovery/config")
	if e != nil {
		t.Fatal(e)
	}
	var configuration Object
	if e = json.NewDecoder(response.Body).Decode(&configuration); e != nil {
		t.Fatal(e)
	}
	_ = response.Body.Close()
	if response.StatusCode != 200 || str(configuration, "csrfToken") == "" || !strings.Contains(response.Header.Get("Set-Cookie"), "HttpOnly; SameSite=Lax") {
		t.Fatal("visitor collector configuration", response.StatusCode)
	}
	postEvent := func(input Object, origin, csrf string) (int, Object) {
		t.Helper()
		request, _ := http.NewRequest("POST", website.URL+"/v1/discovery/events", strings.NewReader(jsonString(input)))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		request.Header.Set("X-Galaxy-Discovery-CSRF", csrf)
		reply, e := browser.Do(request)
		if e != nil {
			t.Fatal(e)
		}
		defer reply.Body.Close()
		var value Object
		if e = json.NewDecoder(reply.Body).Decode(&value); e != nil {
			t.Fatal(e)
		}
		return reply.StatusCode, value
	}
	httpEvent := Object{"eventId": uuid.NewString(), "name": "pageview", "pageKey": "home"}
	if status, value := postEvent(httpEvent, handler.WebsiteOrigin, str(configuration, "csrfToken")); status != 202 || value["accepted"] != true {
		t.Fatalf("actual HTTP collector %d %s", status, jsonString(value))
	}
	if status, value := postEvent(httpEvent, "https://other.example.invalid", str(configuration, "csrfToken")); status != 403 || str(value, "error") != "discovery_csrf_invalid" {
		t.Fatalf("cross origin collector %d %s", status, jsonString(value))
	}
	ambient.Store(true)
	if status, value := postEvent(httpEvent, handler.WebsiteOrigin, str(configuration, "csrfToken")); status != 409 || str(value, "error") != "official_account_changed" {
		t.Fatalf("ambient login silently reattributed %d %s", status, jsonString(value))
	}
	ambient.Store(false)
	httpEvent["accountId"] = uuid.NewString()
	if status, value := postEvent(httpEvent, handler.WebsiteOrigin, str(configuration, "csrfToken")); status != 400 || str(value, "error") != "invalid_discovery_request" {
		t.Fatalf("HTTP identity injected %d %s", status, jsonString(value))
	}
	response, e = browser.Get(website.URL + "/v1/discovery/search?q=a&q=b")
	if e != nil {
		t.Fatal(e)
	}
	_ = response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatalf("duplicate search parameter %d", response.StatusCode)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(paths) < 6 {
		t.Fatal("actual professional-protocol HTTP calls missing", paths)
	}
}
