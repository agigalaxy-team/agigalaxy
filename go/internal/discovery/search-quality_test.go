package discovery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Only external administrative authentication and the professional engine are
// controlled counterparts; command locks, original tables and receipts are real.
type qualityAuthority struct {
	actor  Actor
	denied atomic.Bool
}

func (a *qualityAuthority) AuthorizeOperations(*http.Request, bool, string) (Actor, error) {
	return a.actor, nil
}
func (a *qualityAuthority) RequireWithin(_ context.Context, _ pgx.Tx, actor Actor, _ string) (Actor, error) {
	if a.denied.Load() || actor.ID != a.actor.ID || actor.Endpoint != a.actor.Endpoint {
		return Actor{}, qualityFailure("operations_permission_denied", 403)
	}
	return actor, nil
}
func (a *qualityAuthority) EffectiveWithin(ctx context.Context, tx pgx.Tx, actor Actor) (Actor, error) {
	return a.RequireWithin(ctx, tx, actor, "")
}
func (a *qualityAuthority) PersonWithin(context.Context, pgx.Tx, string, bool) (Actor, error) {
	return a.actor, nil
}
func TestOriginalSearchConfigurationPersistentACKRecoveryAndCurrentProvenance(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	var fixture Object
	if e := decode(originalNode(t, dsn, false, "setup"), &fixture); e != nil {
		t.Fatal(e)
	}
	endpoint := str(fixture, "endpoint")
	actor := Actor{ID: "quality-fixture", Role: "reader", Endpoint: endpoint, Permissions: []string{"search-quality.read", "search-quality.configure", "search-quality.publish", "search-quality.restore"}}
	if _, e := pool.Exec(ctx, `INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.example.invalid','quality','Quality',now(),now())`, actor.ID, endpoint); e != nil {
		t.Fatal(e)
	}
	authority := &qualityAuthority{actor: actor}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	var mu sync.Mutex
	current := Object{"synonyms": Object{}, "rankingRules": rankingRules["relevance"]}
	tasks := map[int64]Object{}
	var patches atomic.Int32
	var loseACK atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/indexes/test/settings" && r.Method == "GET":
			_, _ = w.Write([]byte(jsonString(current)))
		case r.URL.Path == "/indexes/test/settings" && r.Method == "PATCH":
			var next Object
			_ = json.NewDecoder(r.Body).Decode(&next)
			current = next
			id := int64(patches.Add(1))
			tasks[id] = Object{"uid": id, "type": "settingsUpdate", "indexUid": "test", "status": "succeeded", "details": next}
			if loseACK.Swap(false) {
				connection, _, e := w.(http.Hijacker).Hijack()
				if e == nil {
					_ = connection.Close()
				}
				return
			}
			_, _ = w.Write([]byte(jsonString(Object{"taskUid": id})))
		case r.URL.Path == "/tasks":
			rows := []Object{}
			ids := []int64{}
			for id := range tasks {
				ids = append(ids, id)
			}
			sort.Slice(ids, func(i, j int) bool { return ids[i] > ids[j] })
			limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
			for _, id := range ids {
				if r.URL.Query().Get("statuses") != "" {
					continue
				}
				if len(rows) == limit {
					break
				}
				rows = append(rows, tasks[id])
			}
			_, _ = w.Write([]byte(jsonString(Object{"results": rows, "next": nil})))
		case strings.HasPrefix(r.URL.Path, "/tasks/"):
			id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/tasks/"), 10, 64)
			task := tasks[id]
			if task == nil {
				w.WriteHeader(404)
				_, _ = w.Write([]byte(`{}`))
			} else {
				_, _ = w.Write([]byte(jsonString(task)))
			}
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer server.Close()
	meili, e := NewMeilisearch(server.URL, strings.Repeat("synthetic-", 5), "test", ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	service := &SearchQuality{Pool: pool, Endpoint: endpoint, Authority: &operationspermissions.BusinessAuthority{Human: authority}, Meili: meili, Now: now}
	input := Object{"operationId": uuid.NewString(), "expectedRevision": 0, "reason": "  原搜索优化  ", "settings": Object{"synonyms": []any{Object{"term": " Go ", "alternatives": []string{" Golang ", "GOLANG"}}}, "rankingMode": "newest", "fixedConstraints": fixedConstraints}}
	draft, e := service.Command(ctx, actor, "draft", input)
	if e != nil || str(draft, "phase") != "applied" {
		t.Fatalf("draft %s %v", jsonString(draft), e)
	}
	replay, e := service.Command(ctx, actor, "draft", input)
	if e != nil || replay["replayed"] != true || patches.Load() != 0 {
		t.Fatalf("draft replay %s %v", jsonString(replay), e)
	}
	// The original service must recognize the Go receipt from its exact normalized
	// original intent, not reconstruct one from the mutable current configuration.
	script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import{OperationsSearchQualityService}from './packages/galaxy-official/src/operations/search-quality/service.mjs';const db=new pg.Pool({connectionString:process.env.GALAXY_GO_TEST_DATABASE_URL});try{let actor={kind:'business-operator',operatorId:'quality-fixture',role:'reader',endpoint:process.argv[1]};const s=new OperationsSearchQualityService({db,endpoint:actor.endpoint,permissions:{requireAction:async x=>x},now:()=>2000000000});console.log(JSON.stringify(await s.saveDraft(actor,JSON.parse(process.argv[2]),{authorize:async()=>actor})))}finally{await db.end()}`
	var original Object
	if e = decode(originalNode(t, dsn, true, script, endpoint, jsonString(input)), &original); e != nil {
		t.Fatal(e)
	}
	if !sameValue(original, replay) {
		t.Fatalf("original receipt differs Go %s JS %s", jsonString(replay), jsonString(original))
	}
	loseACK.Store(true)
	applyInput := Object{"operationId": uuid.NewString(), "expectedRevision": 1, "versionId": draft["versionId"], "reason": "原应用"}
	applied, e := service.Command(ctx, actor, "apply", applyInput)
	if e != nil || str(applied, "phase") != "applied" || patches.Load() != 1 {
		t.Fatalf("lost ACK reconcile %s %v patches=%d", jsonString(applied), e, patches.Load())
	}
	if _, e = service.Command(ctx, actor, "apply", applyInput); e != nil || patches.Load() != 1 {
		t.Fatalf("replayed apply re-sent %v %d", e, patches.Load())
	}
	plan, e := service.PublicPlan(ctx)
	if e != nil || number(plan, "version") != 1 || str(plan, "rankingMode") != "newest" {
		t.Fatalf("real public plan %s %v", jsonString(plan), e)
	}
	// Request-bound facts identify only the exact qualified page and profile.
	request := SearchRequest{Query: "Go", Limit: 20}
	result := Object{"items": []Object{{"kind": "post", "id": uuid.NewString(), "version": uuid.NewString()}}, "scanLimited": false, "nextAfter": nil}
	reference, e := service.IssueSearch(ctx, "visitor:fixture", request, result, plan)
	if e != nil {
		t.Fatal(e)
	}
	item := result["items"].([]Object)[0]
	event := Object{"name": "search-click", "search": Object{"requestId": reference["requestId"]}, "content": Object{"kind": item["kind"], "id": item["id"], "version": item["version"]}}
	evidence, e := service.Evidence(ctx, "visitor:fixture", event)
	if e != nil || number(evidence, "position") != 1 {
		t.Fatalf("request-bound evidence %s %v", jsonString(evidence), e)
	}
	if _, e = service.Evidence(ctx, "visitor:other", event); fault.Code(e) != "discovery_search_reference_invalid" {
		t.Fatalf("foreign profile accepted %v", e)
	}
	object(event["content"])["version"] = uuid.NewString()
	if _, e = service.Evidence(ctx, "visitor:fixture", event); fault.Code(e) != "discovery_search_reference_invalid" {
		t.Fatalf("wrong source version accepted %v", e)
	}
	for _, event := range []Object{{"name": "search", "query": "Go", "search": evidence}, {"name": "search-click", "search": evidence}, {"name": "search", "query": "未测量"}, {"name": "content-bookmark", "search": evidence}} {
		id := uuid.NewString()
		event["purpose"] = "site-usage-analytics"
		event["profileId"] = "visitor:fixture"
		event["visitorId"] = "00000000-0000-4000-8000-000000000001"
		event["eventId"] = id
		if _, e = pool.Exec(ctx, `INSERT INTO discovery_usage_events_v1(endpoint,id,visitor_id,profile_id,name,purpose,payload,created_at) VALUES($1,$2,$3,$4,$5,'site-usage-analytics',$6,$7)`, endpoint, id, event["visitorId"], event["profileId"], event["name"], jsonString(event), now().Add(-time.Second)); e != nil {
			t.Fatal(e)
		}
	}
	operationRead, e := service.Operation(ctx, actor, str(applied, "operationId"))
	if e != nil {
		t.Fatal(e)
	}
	history, e := service.History(ctx, actor, Object{"limit": 1})
	if e != nil {
		t.Fatal(e)
	}
	overview, e := service.Overview(ctx, actor, Object{})
	if e != nil {
		t.Fatal(e)
	}
	readScript := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import{OperationsSearchQualityService}from './packages/galaxy-official/src/operations/search-quality/service.mjs';import{MeilisearchClient}from './packages/galaxy-official/src/discovery-runtime/native-clients.mjs';const db=new pg.Pool({connectionString:process.env.GALAXY_GO_TEST_DATABASE_URL});try{let actor={kind:'business-operator',operatorId:'quality-fixture',role:'reader',endpoint:process.argv[1],businessAuthorization:{permissions:['search-quality.read','search-quality.configure','search-quality.publish','search-quality.restore']}};const s=new OperationsSearchQualityService({db,endpoint:actor.endpoint,permissions:{requireAction:async x=>x},meili:new MeilisearchClient({url:process.argv[2],apiKey:'synthetic-'.repeat(5),index:'test'}),now:()=>2000000000});console.log(JSON.stringify({operation:await s.operation(actor,process.argv[3]),history:await s.history(actor,{limit:1}),overview:await s.overview(actor,{})}))}finally{await db.end()}`
	var originalReads Object
	if e = decode(originalNode(t, dsn, true, readScript, endpoint, server.URL, str(applied, "operationId")), &originalReads); e != nil {
		t.Fatal(e)
	}
	actualReads := Object{"operation": operationRead, "history": history, "overview": overview}
	if !sameValue(actualReads, originalReads) {
		t.Fatalf("actual search-quality reads differ Go %s JS %s", jsonString(actualReads), jsonString(originalReads))
	}
	// Native drift loses attribution rather than claiming the saved policy ran.
	mu.Lock()
	current = Object{"synonyms": Object{}, "rankingRules": rankingRules["relevance"]}
	mu.Unlock()
	plan, e = service.PublicPlan(ctx)
	if e != nil || plan["version"] != nil {
		t.Fatalf("drift attributed as current %s %v", jsonString(plan), e)
	}
	authority.denied.Store(true)
	input["operationId"] = uuid.NewString()
	input["expectedRevision"] = 3
	if _, e = service.Command(ctx, actor, "draft", input); fault.Code(e) != "operations_permission_denied" || patches.Load() != 1 {
		t.Fatalf("revoked authority changed engine %v %d", e, patches.Load())
	}
}
