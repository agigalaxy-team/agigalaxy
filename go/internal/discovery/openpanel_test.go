package discovery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestOpenPanelWireReportsScopeAndReceiptReader(t *testing.T) {
	var mu sync.Mutex
	calls := []Object{}
	var omitScope atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := Object{}
		for key, values := range r.URL.Query() {
			var decoded any
			if json.Unmarshal([]byte(values[0]), &decoded) == nil {
				query[key] = decoded
			} else {
				query[key] = values[0]
			}
		}
		var body any
		_ = json.NewDecoder(r.Body).Decode(&body)
		agent := ""
		if r.URL.Path == "/track" {
			agent = r.UserAgent()
		}
		mu.Lock()
		calls = append(calls, Object{"method": r.Method, "path": r.URL.Path, "query": query, "body": body, "clientId": r.Header.Get("openpanel-client-id"), "clientSecret": r.Header.Get("openpanel-client-secret"), "userAgent": agent})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/export/charts":
			var definitions []Object
			_ = json.Unmarshal([]byte(r.URL.Query().Get("series")), &definitions)
			series := []Object{}
			for i, d := range definitions {
				series = append(series, Object{"event": Object{"name": d["name"], "id": d["id"]}, "metrics": Object{"sum": i}, "data": []Object{{"date": "2026-01-01", "count": i}, {"date": "2026-01-01 01:00:00", "count": 99}, {"date": "2026-02-30", "count": 3}, {"date": "2026-01-02T01:00:00Z", "count": 0}, {"date": "2026-01-03", "count": "unknown"}}})
			}
			_, _ = w.Write([]byte(jsonString(Object{"series": series})))
		case strings.HasSuffix(r.URL.Path, "/user_flow"):
			if !omitScope.Load() {
				w.Header().Set("X-Galaxy-Analytics-Scope", "accounts")
				if id := r.URL.Query().Get("accountId"); id != "" {
					w.Header().Set("X-Galaxy-Analytics-Account-Id", id)
				}
				w.Header().Set("X-Galaxy-Analytics-Timezone", "Asia/Shanghai")
			}
			_, _ = w.Write([]byte(`{"nodes":[],"links":[]}`))
		case strings.HasSuffix(r.URL.Path, "/events"):
			var props Object
			_ = json.Unmarshal([]byte(r.URL.Query().Get("properties")), &props)
			_, _ = w.Write([]byte(jsonString(Object{"data": []Object{{"properties": Object{"galaxy_event_id": props["galaxy_event_id"]}}}})))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer server.Close()
	config := OpenPanelConfiguration{URL: server.URL, ClientID: "00000000-0000-4000-8000-000000000001", ReadClientID: "00000000-0000-4000-8000-000000000002", ProjectID: "00000000-0000-4000-8000-000000000003", ClientSecret: strings.Repeat("writer-", 7), ReadClientSecret: strings.Repeat("reader-", 7)}
	client, e := NewOpenPanel(config, ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	client.Now = func() time.Time { return time.Unix(2000000000, 0) }
	ctx := context.Background()
	event := Object{"eventId": "00000000-0000-4000-8000-000000000004", "name": "search-click", "pageKey": "find", "visitorId": "00000000-0000-4000-8000-000000000005", "profileId": "visitor:fixture", "occurredAt": "2026-01-01T00:00:00.000Z", "itemKey": "post_fixture", "sourceVersion": "version", "topic": "technology", "transport": Object{"kind": "website-http", "userAgent": "SyntheticBrowser/1"}, "search": Object{"requestId": "request-fixture", "query": "Go", "configurationVersion": nil, "resultState": "has-results", "position": 2}}
	if e = client.Track(ctx, event); e != nil {
		t.Fatal(e)
	}
	from, to := "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"
	business, e := client.BusinessCounts(ctx, from, to)
	if e != nil {
		t.Fatal(e)
	}
	recommendation, e := client.RecommendationReport(ctx, from, to)
	if e != nil {
		t.Fatal(e)
	}
	quality, e := client.SearchQualityReport(ctx, from, to)
	if e != nil {
		t.Fatal(e)
	}
	scope, e := client.AccountAnalysis(ctx, "get_user_flow", Object{"accountId": "00000000-0000-4000-8000-000000000006", "steps": 5})
	if e != nil {
		t.Fatal(e)
	}
	observed, e := client.EventObserved(ctx, event)
	if e != nil || !observed {
		t.Fatalf("actual native receipt reader %v %v", observed, e)
	}
	mu.Lock()
	goCalls := append([]Object{}, calls...)
	calls = nil
	mu.Unlock()
	var expected struct {
		Result Object
		Calls  []Object
	}
	loadWireFixture(t, "openpanel", &expected)
	goResult := Object{"business": business, "recommendation": recommendation, "quality": quality, "scope": scope, "observed": observed}
	if !sameValue(goResult, expected.Result) {
		t.Errorf("native report projection differs actual %s expected %s", jsonString(goResult), jsonString(expected.Result))
	}
	normalize := func(value any) any { var x any; _ = json.Unmarshal([]byte(jsonString(value)), &x); return x }
	if !reflect.DeepEqual(normalize(goCalls), normalize(expected.Calls)) {
		t.Errorf("native OpenPanel wire differs actual %s expected %s", jsonString(goCalls), jsonString(expected.Calls))
	}
	omitScope.Store(true)
	if _, e = client.AccountAnalysis(ctx, "get_user_flow", Object{}); fault.Code(e) != "discovery_analysis_scope_unavailable" {
		t.Fatalf("mixed native result labelled account-only %v", e)
	}
}
