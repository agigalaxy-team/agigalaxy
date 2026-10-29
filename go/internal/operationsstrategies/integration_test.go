package operationsstrategies

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"

	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type currentDirectory struct{ enabled *atomic.Bool }

func (d currentDirectory) Roles(ctx context.Context, i, s string) ([]string, error) {
	return d.RolesFresh(ctx, i, s)
}
func (d currentDirectory) RolesFresh(context.Context, string, string) ([]string, error) {
	if d.enabled.Load() {
		return []string{"admit-admin"}, nil
	}
	return []string{}, nil
}

type maintenanceTransport struct{ handle http.Handler }

func (t maintenanceTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	w := httptest.NewRecorder()
	r.RemoteAddr = "127.0.0.1:30123"
	t.handle.ServeHTTP(w, r)
	return w.Result(), nil
}
func TestStrategiesOriginalVersionsRehearsalAndOrdinaryPG(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	currentFixture := operationsfixture.New(t, admin)
	base := Object{"endpoint": currentFixture.Endpoint, "issuer": currentFixture.Issuer, "operatorId": currentFixture.Root.ID}
	reference := &Service{Pool: currentFixture.Pool, Endpoint: currentFixture.Endpoint, Authority: currentFixture.Gateway, Now: currentFixture.Now}
	referenceAuthorize := func() (Actor, error) { return currentFixture.Root, nil }
	now := func() time.Time { return time.Unix(2000000000, 0) }
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	var enabled atomic.Bool
	enabled.Store(true)
	g, e := access.New(pool, access.Config{Endpoint: str(base["endpoint"]), WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", OperatorIssuer: str(base["issuer"]), AccountIssuer: "https://website.example.invalid/realms/website", AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{Issuer: str(base["issuer"]), Subject: "root", OperatorID: str(base["operatorId"])}}, currentDirectory{&enabled})
	if e != nil {
		t.Fatal(e)
	}
	g.Now = now
	service := &Service{Pool: pool, Endpoint: str(base["endpoint"]), Authority: g, Now: now}
	handler := Handler{Service: service}
	request := func(method, path string, input Object, auth bool) *http.Request {
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest(method, "http://api.invalid/v1/operations/strategies"+path, strings.NewReader(string(raw)))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://admin.example.invalid")
		r.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		if auth {
			r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
		}
		return r
	}
	call := func(method, path string, input Object, auth bool) (int, Object) {
		t.Helper()
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, request(method, path, input, auth))
		var o Object
		_ = json.Unmarshal(w.Body.Bytes(), &o)
		return w.Code, o
	}
	if code, _ := call("GET", "/overview", nil, false); code != 401 {
		t.Fatalf("unauth strategies %d", code)
	}
	config := sampleConfig()
	draft := Object{"operationId": uuid.NewString(), "expectedRevision": 0, "configuration": config, "reason": "原人工策略目标"}
	code, saved := call("POST", "/draft", draft, true)
	if code != 200 || saved["state"] != "saved" {
		t.Fatalf("draft %d %#v", code, saved)
	}
	source, e := reference.SaveDraft(ctx, currentFixture.Root, draft, referenceAuthorize)
	if e != nil {
		t.Fatal(e)
	}
	if source["replayed"] != true {
		t.Fatal("JS cannot replay Go command")
	}
	code, overview := call("GET", "/overview", nil, true)
	source, e = reference.Get(ctx, currentFixture.Root)
	if e != nil {
		t.Fatal(e)
	}
	if code != 200 || !same(overview, source) {
		a, _ := json.Marshal(overview)
		b, _ := json.Marshal(source)
		t.Fatalf("overview mismatch %d\nGo%s\nReference%s", code, a, b)
	}
	publish := Object{"operationId": uuid.NewString(), "expectedRevision": 1, "versionId": saved["versionId"], "rehearsalId": uuid.NewString(), "reason": "人工发布"}
	if code, _ := call("POST", "/publish", publish, true); code != 409 {
		t.Fatalf("published without rehearsal %d", code)
	}
	rehearsalInput := Object{"operationId": uuid.NewString(), "versionId": saved["versionId"], "executionIds": []any{}}
	code, rehearsal := call("POST", "/rehearsal", rehearsalInput, true)
	if code != 200 || rehearsal["valid"] != true || rehearsal["sideEffects"] != false {
		t.Fatalf("rehearsal %d %#v", code, rehearsal)
	}
	source, e = reference.Rehearsal(ctx, currentFixture.Root, rehearsalInput)
	if e != nil {
		t.Fatal(e)
	}
	if source["replayed"] != true {
		t.Fatal("source rehearsal replay unavailable")
	}
	publish["operationId"] = uuid.NewString()
	publish["rehearsalId"] = rehearsal["rehearsalId"]
	code, published := call("POST", "/publish", publish, true)
	if code != 200 || published["state"] != "active-for-new-matters" {
		t.Fatalf("publish %d %#v", code, published)
	}
	req := request("POST", "/draft", nil, true)
	actor, e := g.AuthorizeOperations(req, true, "")
	if e != nil {
		t.Fatal(e)
	}
	strategyID := "11111111-1111-4111-8111-111111111111"
	ordinary := Object{"operationId": uuid.NewString(), "expectedRevision": 2, "strategyId": strategyID, "parameterEdits": []any{Object{"path": []int{0}, "value": 15}}, "enabled": false}
	savedOrdinary, e := service.CommandOrdinary(ctx, actor, "draft", ordinary)
	if e != nil {
		t.Fatalf("ordinary draft %v", e)
	}
	read, e := service.ReadOrdinary(ctx, actor, strategyID)
	if e != nil {
		t.Fatal(e)
	}
	source, e = reference.ReadOrdinary(ctx, currentFixture.Root, strategyID)
	if e != nil {
		t.Fatal(e)
	}
	if !same(read, source) {
		a, _ := json.Marshal(read)
		b, _ := json.Marshal(source)
		t.Fatalf("ordinary read mismatch\nGo%s\nReference%s", a, b)
	}
	ordinaryPublish := Object{"operationId": uuid.NewString(), "expectedRevision": 3, "strategyId": strategyID, "versionId": savedOrdinary["versionId"]}
	out, e := service.CommandOrdinary(ctx, actor, "publish", ordinaryPublish)
	if e != nil || out["newMattersOnly"] != true {
		t.Fatalf("ordinary publish %v %#v", e, out)
	}
	source, e = reference.CommandOrdinary(ctx, currentFixture.Root, "publish", ordinaryPublish)
	if e != nil {
		t.Fatal(e)
	}
	if source["replayed"] != true {
		t.Fatal("original ordinary immutable receipt differs")
	}
	for _, path := range []string{"versions", "records"} {
		code, goView := call("GET", "/"+path, nil, true)
		source, e = map[string]func(context.Context, Actor, Object) (Object, error){"versions": reference.Versions, "records": reference.Records}[path](ctx, currentFixture.Root, Object{})
		if e != nil {
			t.Fatal(e)
		}
		if code != 200 || !same(goView, source) {
			a, _ := json.Marshal(goView)
			b, _ := json.Marshal(source)
			t.Fatalf("%s mismatch %d\nGo%s\nReference%s", path, code, a, b)
		}
	}
	ordinary["operationId"] = uuid.NewString()
	ordinary["expectedRevision"] = 4
	savedOrdinary, e = service.CommandOrdinary(ctx, actor, "draft", ordinary)
	if e != nil {
		t.Fatal(e)
	}
	_, e = admin.Exec(ctx, `UPDATE operations_p13_strategy_versions_v1 SET configuration=jsonb_set(configuration,'{common,objective}','"tampered goal"') WHERE id=$1`, savedOrdinary["versionId"])
	if e != nil {
		t.Fatal(e)
	}
	ordinaryPublish["operationId"], ordinaryPublish["expectedRevision"], ordinaryPublish["versionId"] = uuid.NewString(), 5, savedOrdinary["versionId"]
	if _, e = service.CommandOrdinary(ctx, actor, "publish", ordinaryPublish); e == nil {
		t.Fatal("ordinary publish trusted changed full configuration")
	}
	code, out = call("POST", "/control", Object{"operationId": uuid.NewString(), "expectedRevision": 5, "kind": "pause", "reason": "人工暂停"}, true)
	if code != 200 || out["state"] != "paused" {
		t.Fatalf("pause %d %#v", code, out)
	}
	ordinary["operationId"], ordinary["expectedRevision"] = uuid.NewString(), 6
	if _, e = service.CommandOrdinary(ctx, actor, "draft", ordinary); e == nil {
		t.Fatal("ordinary write while paused")
	}
	code, out = call("POST", "/control", Object{"operationId": uuid.NewString(), "expectedRevision": 6, "kind": "resume", "reason": "人工恢复"}, true)
	if code != 200 || out["state"] != "active-for-new-matters" {
		t.Fatalf("resume %d %#v", code, out)
	}
	enabled.Store(false)
	if code, _ = call("POST", "/draft", Object{"operationId": uuid.NewString(), "expectedRevision": 7, "configuration": config, "reason": "当前撤权"}, true); code != 403 {
		t.Fatalf("current permission withdrawal %d", code)
	}
}
