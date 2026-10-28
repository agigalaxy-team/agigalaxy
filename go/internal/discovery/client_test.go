package discovery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestOriginalMeiliGorseRequestsAndProtectedRedirect(t *testing.T) {
	type request struct {
		Method, Path, Authorization, APIKey string
		Query                               map[string][]string
		Body                                any
	}
	var mu sync.Mutex
	requests := []request{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body any
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		mu.Lock()
		requests = append(requests, request{Method: r.Method, Path: r.URL.Path, Authorization: r.Header.Get("Authorization"), APIKey: r.Header.Get("X-API-Key"), Query: r.URL.Query(), Body: body})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/indexes/test":
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == "/tasks/7":
			_, _ = w.Write([]byte(`{"status":"succeeded"}`))
		case strings.HasSuffix(r.URL.Path, "/search"):
			_, _ = w.Write([]byte(`{"hits":[]}`))
		case r.URL.Path == "/api/latest":
			_, _ = w.Write([]byte(`["post_00000000-0000-4000-8000-000000000001",{"ItemId":"reply_00000000-0000-4000-8000-000000000002"}]`))
		case strings.HasPrefix(r.URL.Path, "/indexes"):
			_, _ = w.Write([]byte(`{"taskUid":7}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer server.Close()
	key := strings.Repeat("synthetic-", 5)
	meili, e := NewMeilisearch(server.URL, key, "test", ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	gorse, e := NewGorse(server.URL, key, ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	ctx := context.Background()
	d := Document{ID: "post_00000000-0000-4000-8000-000000000001", Kind: "post", SourceID: "00000000-0000-4000-8000-000000000001", Version: "version", IndexVersion: "index-version", Title: "标题 <&>", Body: "正文", Topic: "technology", Tags: []string{"Go"}, PublishedAt: 2000000000}
	if _, e = meili.Configure(ctx); e != nil {
		t.Fatal(e)
	}
	if e = meili.Upsert(ctx, d); e != nil {
		t.Fatal(e)
	}
	if _, e = meili.Search(ctx, SearchRequest{Query: "<Go>", After: 2, Limit: 9, Topic: "technology"}, []string{d.ID}, "newest"); e != nil {
		t.Fatal(e)
	}
	if e = meili.Remove(ctx, d.ID); e != nil {
		t.Fatal(e)
	}
	if e = gorse.Upsert(ctx, d); e != nil {
		t.Fatal(e)
	}
	if e = gorse.Remove(ctx, d.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = gorse.Recommend(ctx, RecommendationRequest{Mode: "latest", Limit: 3, Topic: "technology"}, "visitor:test", 4); e != nil {
		t.Fatal(e)
	}
	mu.Lock()
	goRequests := append([]request{}, requests...)
	requests = nil
	mu.Unlock()
	root, _ := filepath.Abs("../../..")
	script := `import{MeilisearchClient,GorseClient}from './packages/galaxy-official/src/discovery-runtime/native-clients.mjs';let [url,key,d]=process.argv.slice(1);d=JSON.parse(d);const m=new MeilisearchClient({url,apiKey:key,index:'test'}),g=new GorseClient({url,apiKey:key});await m.configure();await m.upsert({id:d.id,kind:d.kind,sourceId:d.sourceId,version:d.indexVersion,title:d.title,body:d.body,topic:d.topic,tags:d.tags,publishedAt:d.publishedAt});await m.search({query:'<Go>',after:2,limit:9,topic:'technology',itemKeys:[d.id],rankingMode:'newest'});await m.remove(d.id);await g.upsert(d);await g.remove(d.id);await g.recommend({mode:'latest',limit:3,topic:'technology',profileId:'visitor:test',offset:4})`
	cmd := exec.Command("node", "--input-type=module", "-e", script, server.URL, key, jsonString(d))
	cmd.Dir = root
	if raw, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("original clients %v %s", e, raw)
	}
	mu.Lock()
	jsRequests := append([]request{}, requests...)
	mu.Unlock()
	if !reflect.DeepEqual(goRequests, jsRequests) {
		t.Fatalf("native contract differs Go %s JS %s", jsonString(goRequests), jsonString(jsRequests))
	}
	var received atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { received.Add(1); _, _ = w.Write([]byte(`{}`)) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	m, _ := NewMeilisearch(redirect.URL, key, "test", ClientOptions{})
	_, e = m.Search(ctx, SearchRequest{Query: "test", Limit: 1}, nil, "")
	if fault.Code(e) != "discovery_engine_unavailable" || received.Load() != 0 {
		t.Fatalf("credential redirect followed: %v count %d", e, received.Load())
	}
	malformed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		_, _ = w.Write([]byte(key + " raw backend response"))
	}))
	defer malformed.Close()
	m, _ = NewMeilisearch(malformed.URL, key, "test", ClientOptions{})
	_, e = m.Search(ctx, SearchRequest{Query: "test", Limit: 1}, nil, "")
	if fault.Code(e) != "discovery_engine_authorization_failed" || strings.Contains(e.Error(), key) {
		t.Fatalf("unsafe engine error %v", e)
	}
}
