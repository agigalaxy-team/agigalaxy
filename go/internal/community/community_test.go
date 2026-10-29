package community

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type fixtureAuth struct{ revoked bool }
type fixtureHTTP struct {
	account string
	auth    *fixtureAuth
}

func (f fixtureHTTP) Account(_ *http.Request, _ bool) (string, Authorization, error) {
	return f.account, f.auth, nil
}

func (a *fixtureAuth) Account(ctx context.Context, tx pgx.Tx, endpoint, id string) error {
	if a.revoked {
		return fail("official_account_login_required", 401)
	}
	var ok bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE endpoint=$1 AND id=$2)", endpoint, id).Scan(&ok)
	if e != nil {
		return e
	}
	if !ok {
		return fail("official_account_login_required", 401)
	}
	return nil
}
func object(t *testing.T, b []byte) Object {
	t.Helper()
	var o Object
	if e := protocol.Decode(b, &o); e != nil {
		t.Fatal(e)
	}
	return o
}
func equal(t *testing.T, a, b any) {
	t.Helper()
	var x, y any
	_ = json.Unmarshal(encode(a), &x)
	_ = json.Unmarshal(encode(b), &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("projection differs\nGo: %s\nJS: %s", encode(x), encode(y))
	}
}
func expect(t *testing.T, e error, c string) {
	t.Helper()
	if fault.Code(e) != c {
		t.Fatalf("want %s, got %v", c, e)
	}
}
func bind(t *testing.T, dsn, kind, account string, p Object) Object {
	t.Helper()
	if !BindForumIDs(kind, account, p) {
		t.Fatalf("unsupported forum operation %s", kind)
	}
	return p
}
func TestOriginalForumLedgersAndProjections(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	fixture := seedCommunity(t, pool)
	ids := fixture["accounts"].([]any)
	account, other := asString(ids[0]), asString(ids[1])
	auth := &fixtureAuth{}
	s := &Service{Pool: pool, Endpoint: str(fixture, "endpoint"), Authority: auth, Now: func() time.Time { return time.Unix(2000000000, 0) }}
	ctx := context.Background()
	post := obj(fixture, "payload")
	raw := string(encode(post))
	first, e := s.Publish(ctx, account, raw)
	if e != nil {
		t.Fatal(e)
	}
	if num(first, "headVersion") != 1 || num(obj(first, "quota"), "used") != 1 {
		t.Fatal(first)
	}
	replay, e := s.Publish(ctx, account, raw)
	if e != nil {
		t.Fatal(e)
	}
	if replay["quota"] != nil {
		t.Fatal("original replay must return stored result without spending quota")
	}
	equal(t, replay, objMust(first))
	var spent int
	if e = pool.QueryRow(ctx, "SELECT used FROM forum_daily_usage_v1 WHERE account_id=$1 AND category='post'", account).Scan(&spent); e != nil || spent != 1 {
		t.Fatalf("quota %d %v", spent, e)
	}
	var ruleReceipts int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM operations_p14_rule_decisions_v1 WHERE endpoint=$1 AND operation_ref=$2 AND stage='write'", s.Endpoint, post["operationId"]).Scan(&ruleReceipts); e != nil || ruleReceipts != 1 {
		t.Fatalf("shared P14 write ledger %d %v", ruleReceipts, e)
	}
	changed := clone(post)
	changed["body"] = "另一个请求"
	_, e = s.Publish(ctx, account, string(encode(changed)))
	expect(t, e, "forum_operation_conflict")
	auth.revoked = true
	_, e = s.Publish(ctx, account, raw)
	expect(t, e, "official_account_login_required")
	auth.revoked = false
	reply := bind(t, dsn, "create-reply", other, Object{"schemaVersion": 1, "operationId": uuid.NewString(), "accountId": other, "replyId": uuid.NewString(), "postId": post["postId"], "postVersionId": post["versionId"], "expectedRevision": 0, "body": "回复承接原帖子。", "publishedUntil": 2000001800, "replyTo": nil})
	replyRaw := string(encode(reply))
	if _, e = s.CreateReply(ctx, other, replyRaw); e != nil {
		t.Fatal(e)
	}
	section := bind(t, dsn, "create-section", account, Object{"schemaVersion": 1, "operationId": uuid.NewString(), "accountId": account, "sectionId": uuid.NewString(), "expectedVersion": 0, "title": "原社区分区", "theme": "技术交流", "description": "原分区范围", "audience": legacyAudience()})
	sectionResult, e := s.SaveSection(ctx, account, string(encode(section)))
	if e != nil {
		t.Fatal(e)
	}
	if num(sectionResult, "version") != 1 {
		t.Fatal(sectionResult)
	}
	within, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	versionWithin, err := s.ReadVersionWithin(ctx, within, account, auth, nil, str(post, "postId"), str(post, "versionId"))
	if err != nil {
		within.Rollback(ctx)
		t.Fatal(err)
	}
	if str(versionWithin, "availability") != "available" {
		t.Fatal("current version unavailable", versionWithin)
	}
	replyWithin, err := s.ReadReplyWithin(ctx, within, account, auth, nil, str(reply, "replyId"))
	if err != nil {
		within.Rollback(ctx)
		t.Fatal(err)
	}
	if str(replyWithin, "availability") != "available" {
		t.Fatal("current reply unavailable", replyWithin)
	}
	var permissionID, payloadHash string
	if err = within.QueryRow(ctx, "SELECT permission_id::text,payload_hash FROM forum_versions_v1 WHERE id=$1", post["versionId"]).Scan(&permissionID, &payloadHash); err != nil {
		within.Rollback(ctx)
		t.Fatal(err)
	}
	allowed, err := s.LifecyclePermissionAllowedWithin(ctx, within, permissionID, "", payloadHash, "")
	if err != nil {
		within.Rollback(ctx)
		t.Fatal(err)
	}
	within.Rollback(ctx)
	if !allowed {
		t.Fatal("current public permission unavailable")
	}
	for index, source := range []Object{{"postId": post["postId"], "versionId": post["versionId"]}, {"endpoint": "https://other.example.invalid", "postId": post["postId"], "versionId": post["versionId"]}, {"postId": post["postId"], "versionId": post["versionId"], "payloadHash": strings.Repeat("0", 64)}} {
		within, err = pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		state, err := s.TaskMaterialSourceWithin(ctx, within, source, "", true)
		within.Rollback(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if (state["available"] == true) != (index == 0) {
			t.Fatalf("task source qualification %d: %v", index, state)
		}
	}
	within, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	allowed, err = s.LifecyclePermissionAllowedWithin(ctx, within, permissionID, "", strings.Repeat("0", 64), "")
	within.Rollback(ctx)
	if err != nil || allowed {
		t.Fatalf("lifecycle selector accepted wrong hash: %v %v", allowed, err)
	}
	for key, call := range map[string]func() (Object, error){"post": func() (Object, error) { return s.GetPost(ctx, account, str(post, "postId")) }, "version": func() (Object, error) { return s.GetVersion(ctx, account, str(post, "postId"), str(post, "versionId")) }, "reply": func() (Object, error) { return s.GetReply(ctx, account, str(reply, "replyId")) }, "query": func() (Object, error) { return s.Query(ctx, account, []byte(`{}`)) }, "replies": func() (Object, error) {
		return s.Replies(ctx, account, encode(Object{"postId": post["postId"], "postVersionId": post["versionId"]}))
	}, "owned": func() (Object, error) { return s.OwnedPost(ctx, account, str(post, "postId")) }, "ownedList": func() (Object, error) { return s.Owned(ctx, account, []byte(`{}`)) }, "publicAccount": func() (Object, error) {
		tx, e := pool.Begin(ctx)
		if e != nil {
			return nil, e
		}
		defer tx.Rollback(ctx)
		return s.PublicForAccountWithin(ctx, tx, account, []byte(`{}`))
	}, "quotas": func() (Object, error) { return s.Quotas(ctx, account, []byte(`{}`)) }, "notifications": func() (Object, error) { return s.Notifications(ctx, account, []byte(`{}`)) }, "sections": func() (Object, error) { return s.Sections(ctx, account, []byte(`{}`)) }, "topics": func() (Object, error) { return s.Topics(), nil }, "accessOptions": func() (Object, error) { return s.AccessOptions(), nil }} {
		got, e := call()
		if e != nil {
			t.Fatalf("%s: %v", key, e)
		}
		if got == nil {
			t.Fatalf("%s returned no current data", key)
		}
	}
	if _, e = s.MarkNotificationRead(ctx, other, encode(Object{"replyId": reply["replyId"]})); fault.Code(e) != "not_found" {
		t.Fatal("author must not read own notification", e)
	}
	if _, e = s.MarkNotificationRead(ctx, account, encode(Object{"replyId": reply["replyId"]})); e != nil {
		t.Fatal(e)
	}
	unread, e := s.Notifications(ctx, account, []byte(`{"unreadOnly":true}`))
	if e != nil || len(unread["items"].([]Object)) != 0 {
		t.Fatal(unread, e)
	}
	update := clone(section)
	update["operationId"] = uuid.NewString()
	update["expectedVersion"] = 1
	update["state"] = "archived"
	if _, e = s.SaveSection(ctx, other, string(encode(update))); fault.Code(e) != "official_account_changed" {
		t.Fatal(e)
	}
	if _, e = s.SaveSection(ctx, account, string(encode(update))); e != nil {
		t.Fatal(e)
	}
	sectionView, e := s.GetSection(ctx, account, str(section, "sectionId"))
	if e != nil || truth(sectionView, "canParticipate") || !truth(sectionView, "canMaintain") {
		t.Fatal(sectionView, e)
	}
	accountReport := bind(t, dsn, "create-report", account, Object{"schemaVersion": 1, "operationId": uuid.NewString(), "reportId": uuid.NewString(), "target": Object{"kind": "post-version", "postId": post["postId"], "versionId": post["versionId"]}, "category": "privacy", "summary": "账户原私有举报。"})
	if _, e = s.Report(ctx, account, string(encode(accountReport))); e != nil {
		t.Fatal(e)
	}
	for key, fn := range map[string]func() (Object, error){"detail": func() (Object, error) { return s.GetReport(ctx, account, str(accountReport, "reportId")) }, "query": func() (Object, error) { return s.Reports(ctx, account, []byte(`{}`), false) }, "affected": func() (Object, error) { return s.Reports(ctx, account, []byte(`{}`), true) }, "config": func() (Object, error) { return s.ReportConfig(ctx, account, []byte(`{}`)) }} {
		got, e := fn()
		if e != nil {
			t.Fatal(e)
		}
		if got == nil {
			t.Fatalf("report %s returned no data", key)
		}
	}
	accountSupplement := bind(t, dsn, "supplement", account, Object{"schemaVersion": 1, "operationId": uuid.NewString(), "governanceEventId": uuid.NewString(), "reportId": accountReport["reportId"], "expectedReportVersion": 1, "kind": "supplement", "summary": "账户补充原问题。"})
	if _, e = s.ReportEvent(ctx, account, str(accountReport, "reportId"), string(encode(accountSupplement))); e != nil {
		t.Fatal(e)
	}
	accountWithdraw := bind(t, dsn, "withdraw-report", account, Object{"schemaVersion": 1, "operationId": uuid.NewString(), "governanceEventId": uuid.NewString(), "reportId": accountReport["reportId"], "expectedReportVersion": 2, "kind": "withdraw"})
	if _, e = s.ReportEvent(ctx, account, str(accountReport, "reportId"), string(encode(accountWithdraw))); e != nil {
		t.Fatal(e)
	}
	// Default runtime reads the published policy and rolls a rejected operation
	// back before it can leave a post, receipt, quota, or rule decision.
	policy := controls()
	obj(policy, "features")["forumPost"] = false
	if _, e = pool.Exec(ctx, "INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',2,$2,'business-operator',$3)", s.Endpoint, encode(policy), s.now()); e != nil {
		t.Fatal(e)
	}
	blocked := clone(post)
	blocked["operationId"] = uuid.NewString()
	blocked["postId"] = uuid.NewString()
	blocked["versionId"] = uuid.NewString()
	blocked = bind(t, dsn, "create-post", account, blocked)
	_, e = s.Publish(ctx, account, string(encode(blocked)))
	expect(t, e, "operations_feature_disabled")
	var residue bool
	if e = pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM forum_posts_v1 WHERE id=$1)", blocked["postId"]).Scan(&residue); e != nil || residue {
		t.Fatal(residue, e)
	}
	obj(policy, "features")["forumPost"] = true
	if _, e = pool.Exec(ctx, "INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',3,$2,'business-operator',$3)", s.Endpoint, encode(policy), s.now()); e != nil {
		t.Fatal(e)
	}
	receipt, e := s.Receipt(ctx, account, encode(Object{"operationId": post["operationId"], "payloadHash": identity.Digest([]byte(raw))}))
	if e != nil || str(receipt, "status") != "acknowledged" {
		t.Fatalf("receipt %v %v", receipt, e)
	}
	// A new version retains its post ID and inherits the original audience.
	version := clone(post)
	version["operationId"] = uuid.NewString()
	version["versionId"] = uuid.NewString()
	version["expectedHeadVersion"] = 1
	version["title"] = "第二版"
	version = bind(t, dsn, "publish-version", account, version)
	if _, e = s.Publish(ctx, account, string(encode(version))); e != nil {
		t.Fatal(e)
	}
	// Concurrent equal operations serialize and consume just one quota unit.
	concurrent := clone(reply)
	concurrent["operationId"] = uuid.NewString()
	concurrent["replyId"] = uuid.NewString()
	concurrent["body"] = "并发同一原操作"
	concurrent = bind(t, dsn, "create-reply", other, concurrent)
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.CreateReply(ctx, other, string(encode(concurrent)))
			errors <- err
		}()
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	withdrawReply := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "replyId": reply["replyId"], "expectedRevision": 1}
	if _, e = s.Withdraw(ctx, account, "withdraw-reply", string(encode(withdrawReply))); fault.Code(e) != "not_found" {
		t.Fatal(e)
	}
	if _, e = s.Withdraw(ctx, other, "withdraw-reply", string(encode(withdrawReply))); e != nil {
		t.Fatal(e)
	}
	r, e := s.GetReply(ctx, "", str(reply, "replyId"))
	if e != nil || str(r, "availability") != "withdrawn" {
		t.Fatal(r, e)
	}
	// Creator-selected account audiences keep anonymous readers out, while the
	// exact selected account can read through the same current permission path.
	private := clone(post)
	private["operationId"] = uuid.NewString()
	private["postId"] = uuid.NewString()
	private["versionId"] = uuid.NewString()
	private["audience"] = Object{"read": Object{"kind": "selected-accounts", "accountIds": []string{other}}, "participate": Object{"kind": "accounts"}}
	private = bind(t, dsn, "create-post", account, private)
	if _, e = s.Publish(ctx, account, string(encode(private))); e != nil {
		t.Fatal(e)
	}
	anonymous, e := s.GetPost(ctx, "", str(private, "postId"))
	if e != nil || str(anonymous, "availability") != "unavailable" {
		t.Fatal(anonymous, e)
	}
	selected, e := s.GetPost(ctx, other, str(private, "postId"))
	if e != nil || str(selected, "availability") != "available" {
		t.Fatal(selected, e)
	}
	// Failing after a head insert must roll back every source and receipt.
	expired := clone(post)
	expired["operationId"] = uuid.NewString()
	expired["postId"] = uuid.NewString()
	expired["versionId"] = uuid.NewString()
	expired["publishedUntil"] = 2000000000
	expired = bind(t, dsn, "create-post", account, expired)
	_, e = s.Publish(ctx, account, string(encode(expired)))
	expect(t, e, "forum_permission_expiry")
	var exists bool
	if e = pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM forum_posts_v1 WHERE id=$1)", expired["postId"]).Scan(&exists); e != nil || exists {
		t.Fatalf("failed transaction left head: %v %v", exists, e)
	}
	// HTTP writes use the authenticated account and the transaction authority;
	// signed-envelope fields are rejected for account statements.
	h := Handler{Service: s, Identity: fixtureHTTP{account, auth}}
	req := httptest.NewRequest("POST", "/v2/community/posts", strings.NewReader(string(encode(Object{"payloadJson": raw}))))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	httpResult := object(t, w.Body.Bytes())
	equal(t, httpResult, objMust(first))
	req = httptest.NewRequest("POST", "/v2/community/posts", strings.NewReader(string(encode(Object{"payloadJson": raw, "signedIntent": nil}))))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	// Withdraw controls stay available to a restricted owner, as in Node.
	if _, e = pool.Exec(ctx, "UPDATE community_accounts SET restricted_until=$2 WHERE id=$1", account, s.now().Add(time.Hour)); e != nil {
		t.Fatal(e)
	}
	withdrawVersion := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "postId": post["postId"], "versionId": version["versionId"], "expectedHeadVersion": 2}
	if _, e = s.Withdraw(ctx, account, "withdraw-version", string(encode(withdrawVersion))); e != nil {
		t.Fatal(e)
	}
	withdrawPost := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "postId": post["postId"], "expectedHeadVersion": 3}
	if _, e = s.Withdraw(ctx, account, "withdraw-post", string(encode(withdrawPost))); e != nil {
		t.Fatal(e)
	}
	p, e := s.GetPost(ctx, "", str(post, "postId"))
	if e != nil || str(p, "availability") != "withdrawn" {
		t.Fatal(p, e)
	}
	if _, e = s.Publish(ctx, account, raw); e != nil {
		t.Fatal("accepted operation receipt must survive withdrawal", e)
	}
}
func objMust(v Object) Object { o := clone(v); delete(o, "quota"); return o }
func TestPayloadRetainsOriginalUnicodeAndStrictBounds(t *testing.T) {
	s := &Service{}
	for _, raw := range []string{`"\ud800"`, `"\udc00"`, `"\ud800a"`} {
		if validTextBytes([]byte(raw)) {
			t.Fatalf("accepted lone surrogate %s", raw)
		}
	}
	for _, raw := range []string{`"\ud83d\ude80"`, `"\\ud800"`, `"银河🚀"`} {
		if !validTextBytes([]byte(raw)) {
			t.Fatalf("rejected valid string %s", raw)
		}
	}
	_, e := s.parse("withdraw-reply", `{"schemaVersion":1,"operationId":"11111111-1111-4111-8111-111111111111","replyId":"22222222-2222-4222-8222-222222222222","expectedRevision":1,"unexpected":true}`)
	expect(t, e, "invalid_forum_payload")
}
