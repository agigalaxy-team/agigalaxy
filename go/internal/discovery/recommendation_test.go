package discovery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOriginalRecommendationPolicySupplyFeedbackAndProfileProvenance(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Second)
	defer cancel()
	var fixture Object
	if e := decode(forumFixture(t, dsn, "setup"), &fixture); e != nil {
		t.Fatal(e)
	}
	endpoint := str(fixture, "endpoint")
	accounts := fixture["accounts"].([]any)
	now := func() time.Time { return time.Unix(2000000000, 0) }
	forum := &community.Service{Pool: pool, Endpoint: endpoint, Authority: accountAuthority{}, Now: now}
	post := object(fixture["payload"])
	if _, e := forum.Publish(ctx, accounts[0].(string), jsonString(post)); e != nil {
		t.Fatal(e)
	}
	secondInput := merge(Object{}, post)
	secondInput["operationId"] = uuid.NewString()
	secondInput["accountId"] = accounts[1]
	secondInput["title"] = "艺术主题"
	secondInput["body"] = "创作尝试"
	secondInput["topic"] = "arts"
	secondInput["attachments"] = []any{}
	var second Object
	if e := decode(forumFixture(t, dsn, "bind", "create-post", accounts[1].(string), jsonString(secondInput)), &second); e != nil {
		t.Fatal(e)
	}
	if _, e := forum.Publish(ctx, accounts[1].(string), jsonString(second)); e != nil {
		t.Fatal(e)
	}
	root, _ := filepath.Abs("../../..")
	raw, e := os.ReadFile(filepath.Join(root, "go/internal/databaseschema/sql/api-role.sql"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, string(raw)); e != nil {
		t.Fatal(e)
	}
	config, _ := pgxpool.ParseConfig(dsn)
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	api, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	actor := Actor{ID: "recommendation-fixture", Role: "reader", Endpoint: endpoint, Permissions: []string{"recommendations.read", "recommendations.configure"}}
	if _, e = pool.Exec(ctx, `INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.example.invalid','recommendation','Recommendation',now(),now())`, actor.ID, endpoint); e != nil {
		t.Fatal(e)
	}
	authority := &qualityAuthority{actor: actor}
	business := &operationspermissions.BusinessAuthority{Human: authority}
	source := &CommunitySource{Pool: api, Forum: forum, Endpoint: endpoint}
	service := &Recommendations{Pool: api, Endpoint: endpoint, Authority: business, Source: source, Now: now}
	themeInput := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "label": "艺术映射", "enabled": true, "mapping": Object{"categories": []string{"arts"}, "tagIds": []string{}, "queryTerms": []string{" 艺术 ", "艺术创作"}}, "reason": "原主题范围"}
	created, e := service.SaveTheme(ctx, actor, themeInput)
	if e != nil {
		t.Fatal("theme", e)
	}
	theme := object(created["theme"])
	policyInput := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "enabled": true, "themeKey": theme["key"], "direction": "increase", "controls": Object{"avoidRepetition": true, "avoidConcentration": true}, "reason": "原推荐方向"}
	saved, e := service.SavePolicy(ctx, actor, policyInput, &ThemeExpectation{Key: str(theme, "key"), ExpectedVersion: 1, Enabled: true})
	if e != nil {
		t.Fatal("policy", e)
	}
	if replay, e := service.SavePolicy(ctx, actor, policyInput, nil); e != nil || replay["replayed"] != true {
		t.Fatalf("policy replay %s %v", jsonString(replay), e)
	}
	firstKey, _ := ItemKey(Reference{Kind: "post", ID: str(post, "postId")})
	secondKey, _ := ItemKey(Reference{Kind: "post", ID: str(second, "postId")})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/api/recommend/") {
			_, _ = w.Write([]byte(jsonString([]string{firstKey})))
			return
		}
		if r.URL.Path == "/api/latest" {
			_, _ = w.Write([]byte(jsonString([]string{secondKey, firstKey})))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	gorse, e := NewGorse(server.URL, strings.Repeat("synthetic-", 5), ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	store := &Store{Pool: api, Endpoint: endpoint, Now: now}
	runtime := &Runtime{Store: store, Source: source, Gorse: gorse, Recommendations: service, Authority: business, Now: now}
	visitor := UsageIdentity{VisitorID: uuid.NewString()}
	result, e := runtime.Recommend(ctx, visitor, Object{"limit": 2})
	if e != nil {
		t.Fatal(e)
	}
	items := result["items"].([]Object)
	if len(items) != 2 || items[0]["id"] != second["postId"] || result["fallback"] != true {
		t.Fatalf("one neighbour control/fallback %s", jsonString(result))
	}
	overview, e := service.Overview(ctx, actor, Object{})
	if e != nil {
		t.Fatal(e)
	}
	history, e := service.History(ctx, actor, Object{})
	if e != nil {
		t.Fatal(e)
	}
	receipt, e := service.CommandResult(ctx, actor, str(saved, "operationId"))
	if e != nil {
		t.Fatal(e)
	}
	if overview == nil || history == nil || receipt == nil || receipt["operationId"] != saved["operationId"] {
		t.Fatalf("current recommendation reads: %s", jsonString(Object{"overview": overview, "history": history, "receipt": receipt}))
	}
	// The actual last displayed request affects repetition only after exposure.
	exposure := Object{"eventId": uuid.NewString(), "name": "content-exposure", "pageKey": "home", "content": Object{"kind": "post", "id": items[0]["id"], "version": items[0]["version"]}, "recommendation": Object{"requestId": object(result["recommendation"])["requestId"]}}
	if _, e = runtime.RecordUsage(ctx, visitor, exposure, "SyntheticBrowser/1"); e != nil {
		t.Fatal(e)
	}
	next, e := runtime.Recommend(ctx, visitor, Object{"limit": 2})
	if e != nil || next["items"].([]Object)[0]["id"] != post["postId"] {
		t.Fatalf("actual exposure repetition %s %v", jsonString(next), e)
	}
	other := UsageIdentity{VisitorID: uuid.NewString()}
	if _, e = runtime.RecordUsage(ctx, other, exposure, "SyntheticBrowser/1"); fault.Code(e) != "discovery_recommendation_reference_invalid" {
		t.Fatalf("foreign profile recommendation attributed %v", e)
	}
	negative := Object{"eventId": uuid.NewString(), "name": "not-interested", "pageKey": "home", "content": exposure["content"]}
	if _, e = runtime.RecordUsage(ctx, visitor, negative, "SyntheticBrowser/1"); e != nil {
		t.Fatal(e)
	}
	filtered, e := runtime.Recommend(ctx, visitor, Object{"limit": 2})
	if e != nil || len(filtered["items"].([]Object)) != 1 || filtered["items"].([]Object)[0]["id"] != post["postId"] {
		t.Fatalf("negative feedback not respected %s %v", jsonString(filtered), e)
	}
	themeInput["operationId"] = uuid.NewString()
	themeInput["themeId"] = theme["id"]
	themeInput["expectedVersion"] = 1
	themeInput["label"] = "更新后的主题"
	if _, e = service.SaveTheme(ctx, actor, themeInput); e != nil {
		t.Fatal(e)
	}
	policyInput["operationId"] = uuid.NewString()
	policyInput["expectedVersion"] = 1
	if _, e = service.SavePolicy(ctx, actor, policyInput, &ThemeExpectation{Key: str(theme, "key"), ExpectedVersion: 1, Enabled: true}); fault.Code(e) != "recommendation_theme_changed" {
		t.Fatalf("stale frozen mapping accepted %v", e)
	}
	// Actual authenticated native analytics routes retain their own account-scope
	// acknowledgement and native windows; they do not read/rebuild a local cohort.
	var nativeCalls atomic.Int32
	var dropScope atomic.Bool
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nativeCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("scope") == "accounts" && !dropScope.Load() {
			w.Header().Set("X-Galaxy-Analytics-Scope", "accounts")
			if id := r.URL.Query().Get("accountId"); id != "" {
				w.Header().Set("X-Galaxy-Analytics-Account-Id", id)
			}
			w.Header().Set("X-Galaxy-Analytics-Timezone", "Asia/Shanghai")
		}
		switch {
		case r.URL.Path == "/export/charts":
			var definitions []Object
			_ = json.Unmarshal([]byte(r.URL.Query().Get("series")), &definitions)
			series := []Object{}
			for i, d := range definitions {
				series = append(series, Object{"event": Object{"name": d["name"]}, "metrics": Object{"sum": i}})
			}
			_, _ = w.Write([]byte(jsonString(Object{"series": series})))
		case strings.HasSuffix(r.URL.Path, "/retention/cohort"):
			_, _ = w.Write([]byte(`[{"week":"2026-01-01","native":true}]`))
		case strings.HasSuffix(r.URL.Path, "/user_flow"):
			_, _ = w.Write([]byte(`{"nodes":[],"links":[],"native":true}`))
		case strings.HasSuffix(r.URL.Path, "/metrics"):
			_, _ = w.Write([]byte(`{"native":"profile-metrics"}`))
		default:
			_, _ = w.Write([]byte(`{"timezone":"Asia/Shanghai","native":"overview"}`))
		}
	}))
	defer panel.Close()
	panelConfig := OpenPanelConfiguration{URL: panel.URL, ClientID: uuid.NewString(), ReadClientID: uuid.NewString(), ProjectID: uuid.NewString(), ClientSecret: strings.Repeat("writer-", 7), ReadClientSecret: strings.Repeat("reader-", 7)}
	openpanel, e := NewOpenPanel(panelConfig, ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	runtime.OpenPanel = openpanel
	analyticsInputs := []Object{{"kind": "overview"}, {"kind": "business", "days": 7}, {"kind": "retention"}, {"kind": "retention", "scope": "accounts"}, {"kind": "paths"}, {"kind": "paths", "scope": "accounts", "accountId": accounts[0]}, {"kind": "account", "accountId": accounts[0]}}
	goAnalytics := []Object{}
	for _, input := range analyticsInputs {
		result, e := runtime.Analytics(ctx, actor, input)
		if e != nil {
			t.Fatal(e)
		}
		goAnalytics = append(goAnalytics, result)
	}
	if len(goAnalytics) != len(analyticsInputs) {
		t.Fatal("missing analytics responses", goAnalytics)
	}
	dropScope.Store(true)
	if _, e = runtime.Analytics(ctx, actor, Object{"kind": "retention", "scope": "accounts"}); fault.Code(e) != "discovery_analysis_scope_unavailable" {
		t.Fatalf("scope ignored result labelled account analysis %v", e)
	}
	authority.denied.Store(true)
	beforeCalls := nativeCalls.Load()
	if _, e = runtime.Analytics(ctx, actor, Object{"kind": "overview"}); fault.Code(e) != "operations_permission_denied" || nativeCalls.Load() != beforeCalls {
		t.Fatalf("revoked analytics accessed engine %v", e)
	}
	if _, e = service.SavePolicy(ctx, actor, policyInput, nil); fault.Code(e) != "operations_permission_denied" {
		t.Fatalf("revoked policy write accepted %v", e)
	}
}
