package operationsrules

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
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
func TestRulesOriginalPublicationSamplesAndAdoptionPG(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	management := operationsfixture.NewEndpoint(t, admin, "https://strategies.example.invalid")
	base := Object{"endpoint": management.Endpoint, "issuer": management.Issuer, "operatorId": management.Root.ID}
	reference := &Service{Pool: management.Pool, Endpoint: management.Endpoint, Authority: management.Gateway, Now: management.Now}
	referenceAuthorize := func() (Actor, error) { return management.Root, nil }
	read := func(value Object, err error) Object {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
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
	now := func() time.Time { return time.Unix(2000000000, 0) }
	g.Now = now
	s := &Service{Pool: pool, Endpoint: str(base["endpoint"]), Authority: g, Now: now}
	p := resourcebudget.DefaultPolicy()
	raw, _ := json.Marshal(p)
	var budget Object
	_ = json.Unmarshal(raw, &budget)
	forum, _ := community.LoadForumPolicy("")
	if e = s.Bootstrap(ctx, map[string]Object{"resource-budget": budget, "community-quota": publicwrites.DefaultPolicy(), "forum-quota": forum}); e != nil {
		t.Fatal(e)
	}
	if e = s.Initialize(ctx); e != nil {
		t.Fatal(e)
	}
	func() {
		if e := reference.Initialize(ctx); e != nil {
			t.Fatal(e)
		}
	}()
	h := Handler{Service: s}
	call := func(method, path string, x Object, auth bool) (int, Object) {
		t.Helper()
		b, _ := json.Marshal(x)
		r := httptest.NewRequest(method, "http://api.invalid/v1/operations/rules"+path, strings.NewReader(string(b)))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://admin.example.invalid")
		r.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		if auth {
			r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var o Object
		_ = json.Unmarshal(w.Body.Bytes(), &o)
		return w.Code, o
	}
	if code, _ := call("GET", "/overview", nil, false); code != 401 {
		t.Fatalf("no session %d", code)
	}
	if code, _ := call("POST", "/resource-budget", budget, true); code != 409 {
		t.Fatalf("legacy direct write %d", code)
	}
	code, goView := call("GET", "/overview", nil, true)
	if code != 200 || !same(goView, read(reference.Overview(ctx, management.Root))) {
		t.Fatalf("baseline overview %d %#v", code, goView)
	}
	controls := EmptyControls()
	ruleID, listID, exceptionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	accountID := uuid.NewString()
	controls["lists"] = []any{Object{"id": listID, "name": "禁止词名单", "kind": "keyword", "enabled": true, "entries": []any{"ＡＢＣ", "😀"}}}
	controls["rules"] = []any{Object{"id": ruleID, "name": "当前正文规则", "enabled": true, "targets": []any{"forum-post"}, "conditions": Object{"combinator": "or", "rules": []any{Object{"field": "keywordList", "operator": "matches", "value": listID}, Object{"field": "textLength", "operator": "gt", "value": 100}}}, "action": "reject", "exceptions": []any{}}}
	// A real missing account is rejected before any durable command is recorded.
	bad := clone(controls)
	bad["rules"] = []any{clone(obj(list(controls["rules"])[0]))}
	obj(list(bad["rules"])[0])["exceptions"] = []any{Object{"id": exceptionID, "name": "未存在账户", "enabled": true, "accountIds": []any{accountID}}}
	invalidDraft := Object{"operationId": uuid.NewString(), "expectedRevision": 0, "reason": "原名单账户边界", "policy": bad}
	if code, o := call("POST", "/business-controls/draft", invalidDraft, true); code != 409 || o["error"] != "operations_rule_exception_account_unavailable" {
		t.Fatalf("invalid account %d %#v", code, o)
	}
	draft := Object{"operationId": uuid.NewString(), "expectedRevision": 0, "reason": "人工保存规则😀", "policy": controls}
	code, saved := call("POST", "/business-controls/draft", draft, true)
	if code != 200 {
		t.Fatalf("draft %d %#v", code, saved)
	}
	if read(reference.SaveDraft(ctx, management.Root, "business-controls", draft, referenceAuthorize))["replayed"] != true {
		t.Fatal("original cannot replay Go draft")
	}
	code, detail := call("GET", "/business-controls/detail", nil, true)
	if code != 200 || !same(detail, read(reference.Get(ctx, management.Root, "business-controls"))) {
		t.Fatalf("detail mismatch %#v", detail)
	}
	changed := clone(draft)
	changed["reason"] = "different"
	if code, _ := call("POST", "/business-controls/draft", changed, true); code != 409 {
		t.Fatalf("immutable command %d", code)
	}
	for _, sample := range []Object{{"target": "forum-post", "text": "xx abc yy", "links": []any{}}, {"target": "forum-post", "links": []any{}}, {"target": "forum-upload", "fileBytes": 16}} {
		input := Object{"versionId": saved["versionId"], "sample": sample}
		code, o := call("POST", "/business-controls/sample", input, true)
		source := read(reference.Sample(ctx, management.Root, "business-controls", input))
		if code != 200 || !same(o, source) {
			a, _ := json.Marshal(o)
			b, _ := json.Marshal(source)
			t.Fatalf("sample mismatch %d\nGo%s\nReference%s", code, a, b)
		}
	}
	publish := Object{"operationId": uuid.NewString(), "expectedRevision": 1, "reason": "人工发布", "versionId": saved["versionId"]}
	source := read(reference.Publish(ctx, management.Root, "business-controls", publish, referenceAuthorize))
	code, published := call("POST", "/business-controls/publish", publish, true)
	if code != 200 || published["replayed"] != true || !same(published["publishedVersion"], source["publishedVersion"]) {
		t.Fatalf("HTTP replay current domain publish %d %#v", code, published)
	}
	code, versions := call("GET", "/business-controls/versions?limit=2", nil, true)
	if code != 200 || !same(versions, read(reference.Versions(ctx, management.Root, "business-controls", Object{"limit": 2}))) {
		t.Fatalf("versions mismatch %#v", versions)
	}
	if code, _ := call("GET", "/business-controls/versions?after=2147483648", nil, true); code != 400 {
		t.Fatalf("page bound %d", code)
	}
	restore := Object{"operationId": uuid.NewString(), "expectedRevision": 2, "reason": "恢复原已发布版本", "versionId": obj(versions["baseline"])["id"]}
	code, restored := call("POST", "/business-controls/restore", restore, true)
	if code != 200 || num(restored["publishedVersion"]) != 3 {
		t.Fatalf("restore %d %#v", code, restored)
	}
	if !same(read(reference.Operation(ctx, management.Root, str(restore["operationId"]))), func() Object { _, o := call("GET", "/operations/"+str(restore["operationId"]), nil, true); return o }()) {
		t.Fatal("operation projection")
	}
	// Publishing is ordered behind the original live business shared lock.
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))`, s.Endpoint+":operations-rule:business-controls"); e != nil {
		t.Fatal(e)
	}
	blocked := make(chan struct{})
	draft2 := Object{"operationId": uuid.NewString(), "expectedRevision": 3, "reason": "再次草稿", "policy": controls}
	code, saved2 := call("POST", "/business-controls/draft", draft2, true)
	if code != 200 {
		t.Fatalf("draft2 %d %#v", code, saved2)
	}
	go func() {
		defer close(blocked)
		code, o := call("POST", "/business-controls/publish", Object{"operationId": uuid.NewString(), "expectedRevision": 4, "reason": "等待当前事务", "versionId": saved2["versionId"]}, true)
		if code != 200 {
			t.Errorf("publish after lock %d %#v", code, o)
		}
	}()
	select {
	case <-blocked:
		t.Fatal("publication bypassed live write lock")
	case <-time.After(80 * time.Millisecond):
	}
	_ = tx.Rollback(ctx)
	<-blocked
	manager, _ := resourcebudget.New(&p, nil)
	var applyCount atomic.Int64
	reject := atomic.Bool{}
	runtime, e := NewPolicyRuntime(s, "api", uuid.NewString(), []PolicyConsumer{{Key: "resource-budget", Apply: func(ctx context.Context, o Object, v int64) error {
		applyCount.Add(1)
		if reject.Load() {
			return fault.New("actual_consumer_unavailable", 503)
		}
		p, e := resourcebudget.ParsePolicy(o)
		if e != nil {
			return e
		}
		return manager.AdoptPolicy(p)
	}}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = runtime.Refresh(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = runtime.Refresh(ctx); e != nil || applyCount.Load() != 1 {
		t.Fatal("unchanged policy reapplied")
	}
	budget2 := clone(budget)
	budget2["maxActiveJobsGlobal"] = 2
	code, bd := call("POST", "/resource-budget/draft", Object{"operationId": uuid.NewString(), "expectedRevision": 0, "reason": "额度草稿", "policy": budget2}, true)
	if code != 200 {
		t.Fatalf("budget draft %d %#v", code, bd)
	}
	code, bp := call("POST", "/resource-budget/publish", Object{"operationId": uuid.NewString(), "expectedRevision": 1, "reason": "额度发布", "versionId": bd["versionId"]}, true)
	if code != 200 {
		t.Fatalf("budget publish %d %#v", code, bp)
	}
	reject.Store(true)
	out, e := runtime.Refresh(ctx)
	if e != nil || num(obj(list(out["items"])[0])["adoptedVersion"]) != 1 || obj(list(out["items"])[0])["errorCode"] == nil {
		t.Fatalf("false adoption %#v %v", out, e)
	}
	reject.Store(false)
	out, e = runtime.Refresh(ctx)
	if e != nil || num(obj(list(out["items"])[0])["adoptedVersion"]) != 2 || manager.SnapshotPolicy().MaxActiveJobsGlobal != 2 {
		t.Fatalf("actual adoption %#v %v", out, e)
	}
	var audits int
	if e = admin.QueryRow(ctx, `SELECT count(*) FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='rule-save'`, s.Endpoint).Scan(&audits); e != nil {
		t.Fatal(e)
	}
	if audits != 7 {
		t.Fatalf("expected exactly seven original audit records, got %d", audits)
	}
	enabled.Store(false)
	if code, _ := call("POST", "/resource-budget/draft", Object{"operationId": uuid.NewString(), "expectedRevision": 2, "reason": "资格已撤销", "policy": budget}, true); code != 403 {
		t.Fatalf("fresh directory withdrawal %d", code)
	}
}
