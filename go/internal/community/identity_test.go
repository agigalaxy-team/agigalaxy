package community

import (
	"bytes"
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func requestJSON(t *testing.T, origin, path, token string, input any) (int, Object) {
	t.Helper()
	var body io.Reader
	method := "GET"
	if input != nil {
		body = bytes.NewReader(encode(input))
		method = "POST"
	}
	req, e := http.NewRequest(method, origin+path, body)
	if e != nil {
		t.Fatal(e)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := http.Client{Timeout: 20 * time.Second}
	res, e := client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 3<<20))
	if e != nil {
		t.Fatal(e)
	}
	return res.StatusCode, object(t, b)
}
func TestSignedIdentityWritesAndPrivateGovernanceAgainstOriginal(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	var e error
	f := syntheticIdentityFixture(t, pool)
	now := time.Unix(num(f, "now"), 0)
	s := &Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: func() time.Time { return now }, DeviceAuth: &deviceauth.Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: func() time.Time { return now }}, ModeratorIDs: []string{str(obj(f, "moderator"), "subjectId")}, IdentityProviders: []IdentityProvider{{Issuer: str(f, "issuer"), ClientID: "galaxy-fixture"}}}
	s.AccountLinks = &accountlinks.Service{Pool: pool, Endpoint: s.Endpoint, Devices: s.DeviceAuth, Providers: []accountlinks.Provider{{Issuer: str(f, "issuer"), ClientID: "galaxy-fixture"}}, Now: s.Now}
	server := httptest.NewServer(Handler{Service: s})
	defer server.Close()
	tokens := map[string]string{}
	for _, kind := range []string{"owner", "reporter", "moderator"} {
		tokens[kind] = str(obj(f, kind), "token")
	}
	send := func(path, key, who string) Object {
		t.Helper()
		envelope := obj(f, key)
		status, result := requestJSON(t, server.URL, path, tokens[who], Object{"payloadJson": envelope["payloadJson"], "signedIntent": envelope["signedIntent"]})
		if status != 200 {
			t.Fatalf("%s: status %d error=%s", key, status, str(result, "error"))
		}
		return result
	}
	post := obj(obj(f, "post"), "payload")
	reply := obj(obj(f, "reply"), "payload")
	report := obj(obj(f, "report"), "payload")
	section := obj(obj(f, "section"), "payload")
	policy := resourcebudget.DefaultPolicy()
	policy.MaxPayloadBytesPerSubject = 0
	s.Resources, e = resourcebudget.New(&policy, s.Now)
	if e != nil {
		t.Fatal(e)
	}
	postEnvelope := obj(f, "post")
	attemptStatus, attemptResult := requestJSON(t, server.URL, "/v2/community/posts", tokens["owner"], Object{"payloadJson": postEnvelope["payloadJson"], "signedIntent": postEnvelope["signedIntent"]})
	if attemptStatus != 409 || str(attemptResult, "error") != "storage_quota_exceeded" {
		t.Fatal("resource gate failed to reject growth", attemptStatus, str(attemptResult, "error"))
	}
	var residue int
	if e = pool.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM forum_posts_v1 WHERE id=$1)+(SELECT count(*) FROM forum_events_v1 WHERE id=$2)+(SELECT count(*) FROM forum_write_receipts_v1 WHERE operation_id=$2)", post["postId"], post["operationId"]).Scan(&residue); e != nil || residue != 0 {
		t.Fatal("resource failure left forum state", residue, e)
	}
	policy = resourcebudget.DefaultPolicy()
	s.Resources, e = resourcebudget.New(&policy, s.Now)
	if e != nil {
		t.Fatal(e)
	}
	result := send("/v2/community/posts", "post", "owner")
	if result["subjectId"] != obj(f, "owner")["subjectId"] {
		t.Fatal("identity author lost")
	}
	send("/v2/community/replies", "reply", "reporter")
	compareDiscovery := func(label string, mutate string, available bool) {
		t.Helper()
		ctx := context.Background()
		tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if mutate != "" {
			if _, err = tx.Exec(ctx, mutate, post["versionId"], now); err != nil {
				t.Fatalf("%s fixture: %v", label, err)
			}
		}
		single, err := s.ReadPublicDiscoveryWithin(ctx, tx, "post", str(post, "postId"), true)
		if err != nil {
			t.Fatalf("%s single: %v", label, err)
		}
		batch, err := s.ReadPublicDiscoveryBatchWithin(ctx, tx, []DiscoveryReference{{Kind: "post", ID: str(post, "postId")}})
		if err != nil {
			t.Fatalf("%s batch: %v", label, err)
		}
		singleAvailable := str(single, "availability") == "available"
		if singleAvailable != available || (batch[0] != nil) != available {
			t.Fatalf("%s availability single=%s batch=%v", label, str(single, "availability"), batch[0] != nil)
		}
		if available {
			for _, key := range []string{"payload", "topic", "operatorCuration", "authorAccountId", "currentVersionId", "createdAt", "publishedUntil"} {
				if !reflect.DeepEqual(single[key], batch[0][key]) {
					t.Fatalf("%s field %s differs", label, key)
				}
			}
		}
	}
	compareDiscovery("signed consent", "", true)
	compareDiscovery("consent revoked", `UPDATE consents SET revoked_at=$2 WHERE id=(SELECT consent_id FROM forum_permissions_v1 WHERE object_id=$1)`, false)
	compareDiscovery("anonymous selected audience", `UPDATE forum_versions_v1 SET audience=jsonb_build_object('read',jsonb_build_object('kind','selected-accounts','accountIds','[]'::jsonb)) WHERE id=$1 AND $2::timestamptz IS NOT NULL`, false)
	send("/v2/community/sections", "section", "owner")
	send("/v2/community/sections/"+str(section, "sectionId")+"/classification", "classify", "moderator")
	for _, path := range []string{"/v2/community/posts/" + str(post, "postId"), "/v2/community/replies/" + str(reply, "replyId"), "/v2/community/sections/" + str(section, "sectionId"), "/v2/community/posts/" + str(post, "postId") + "/owned", "/v2/community/quotas", "/v2/community/permissions/" + str(result, "permissionId")} {
		a, x := requestJSON(t, server.URL, path, tokens["owner"], nil)
		if a != 200 || x == nil {
			t.Fatalf("current read %s status %d", path, a)
		}
	}
	device, e := s.DeviceAuth.Authenticate(context.Background(), tokens["owner"], "binding")
	if e != nil {
		t.Fatal(e)
	}
	principal := webevents.Principal{Kind: "device", Actor: device, SubjectID: device.SubjectID, Identity: device.SubjectID, Endpoint: s.Endpoint, Surface: "web"}
	consumers := s.EventConsumers()
	for _, consumer := range []webevents.PublicRead{consumers.ForumPost, consumers.ForumReply, consumers.ForumVersion} {
		if consumer == nil {
			t.Fatal("forum event source missing")
		}
	}
	eventView, e := consumers.ForumVersion(context.Background(), principal, str(post, "versionId"), str(post, "postId"))
	if e != nil || str(eventView, "availability") != "available" {
		t.Fatal("event source did not reuse current read", e)
	}
	if consumers.Chat != nil || consumers.Capsule != nil || consumers.Task != nil {
		t.Fatal("event adapter filled unmigrated domains")
	}
	foreign := principal
	foreign.Endpoint = "https://foreign.example.invalid"
	if _, e = consumers.ForumPost(context.Background(), foreign, str(post, "postId"), ""); faultCode(e) != "web_events_access_denied" {
		t.Fatal("foreign event principal", e)
	}
	for _, path := range []string{"/v2/community/posts/query", "/v2/community/posts/owned", "/v2/community/sections/query", "/v2/community/notifications/query"} {
		a, x := requestJSON(t, server.URL, path, tokens["owner"], Object{})
		if a != 200 || x == nil {
			t.Fatalf("signed query %s status %d %s", path, a, str(x, "error"))
		}
	}
	send("/v2/community/reports", "report", "reporter")
	reportPath := "/v2/community/reports/" + str(report, "reportId")
	compare := func() {
		t.Helper()
		for _, who := range []string{"owner", "reporter", "moderator"} {
			a, x := requestJSON(t, server.URL, reportPath, tokens[who], nil)
			if a != 200 || x == nil {
				t.Fatalf("report %s status %d %s", who, a, str(x, "error"))
			}
		}
	}
	compare()
	zero := policy
	zero.MaxPayloadBytesPerSubject = 0
	s.Resources, e = resourcebudget.New(&zero, s.Now)
	if e != nil {
		t.Fatal(e)
	}
	supplement := obj(f, "supplement")
	attemptStatus, attemptResult = requestJSON(t, server.URL, reportPath+"/events", tokens["reporter"], Object{"payloadJson": supplement["payloadJson"], "signedIntent": supplement["signedIntent"]})
	if attemptStatus != 409 || str(attemptResult, "error") != "storage_quota_exceeded" {
		t.Fatal("supplement resource growth", attemptStatus, str(attemptResult, "error"))
	}
	var reportVersion int
	if e = pool.QueryRow(context.Background(), "SELECT version FROM forum_reports_v1 WHERE id=$1", report["reportId"]).Scan(&reportVersion); e != nil || reportVersion != 1 {
		t.Fatal("resource failure advanced report", reportVersion, e)
	}
	s.Resources, e = resourcebudget.New(&policy, s.Now)
	if e != nil {
		t.Fatal(e)
	}
	send(reportPath+"/events", "supplement", "reporter")
	send(reportPath+"/events", "resolve", "moderator")
	compareDiscovery("governance hides post", "", false)
	compare()
	_, hidden := requestJSON(t, server.URL, "/v2/community/posts/"+str(post, "postId"), "", nil)
	if str(hidden, "availability") != "unavailable" {
		t.Fatal("decision did not stop content")
	}
	send(reportPath+"/appeal", "appeal", "owner")
	send(reportPath+"/events", "dismiss", "moderator")
	compare()
	send("/v2/community/reports/withdraw", "withdrawReport", "reporter")
	compare()
	// A receipt remains an accepted operation after current read permission was
	// changed; a forged payload cannot reuse that owner/operation locator.
	envelope := obj(f, "post")
	replay := send("/v2/community/posts", "post", "owner")
	if replay["quota"] != nil {
		t.Fatal("signed replay spent budget")
	}
	changed := strings.Replace(str(envelope, "payloadJson"), str(post, "title"), "篡改原签名字节", 1)
	status, out := requestJSON(t, server.URL, "/v2/community/posts", tokens["owner"], Object{"payloadJson": changed, "signedIntent": envelope["signedIntent"]})
	if status != 409 || str(out, "error") != "forum_operation_conflict" {
		t.Fatal(status, str(out, "error"))
	}
	fresh := clone(post)
	fresh["operationId"] = uuid.NewString()
	fresh["postId"] = deriveID("post", "create-post", str(obj(f, "owner"), "subjectId"), fresh, "postId", "versionId")
	fresh["versionId"] = deriveID("post-version", "create-post", str(obj(f, "owner"), "subjectId"), fresh, "versionId")
	status, out = requestJSON(t, server.URL, "/v2/community/posts", tokens["owner"], Object{"payloadJson": string(encode(fresh)), "signedIntent": envelope["signedIntent"]})
	if status != 403 || str(out, "error") != "consent_required" {
		t.Fatal("old signature authorized a new operation", status, str(out, "error"))
	}
	var stray bool
	if e := pool.QueryRow(context.Background(), "SELECT EXISTS(SELECT 1 FROM forum_posts_v1 WHERE id=$1)", fresh["postId"]).Scan(&stray); e != nil || stray {
		t.Fatal("failed signed operation left state", stray, e)
	}
	var count int
	if e := pool.QueryRow(context.Background(), "SELECT count(*) FROM audit_events WHERE actor=$1 AND action IN ('forum.post.publish','forum.section.write')", obj(f, "owner")["subjectId"]).Scan(&count); e != nil || count != 2 {
		t.Fatal("original signature audits", count, e)
	}
	send("/v2/community/posts", "version", "owner")
	s.Resources, e = resourcebudget.New(&zero, s.Now)
	if e != nil {
		t.Fatal(e)
	}
	attemptStatus, attemptResult = requestJSON(t, server.URL, "/v2/community/notifications/read", tokens["owner"], Object{"replyId": reply["replyId"]})
	if attemptStatus != 200 {
		t.Fatal("notification control rejected over quota", attemptStatus, str(attemptResult, "error"))
	}
	send("/v2/community/versions/withdraw", "withdrawVersion", "owner")
	send("/v2/community/replies/withdraw", "withdrawReply", "reporter")
	send("/v2/community/posts/withdraw", "withdrawPost", "owner")
	for _, path := range []string{"/v2/community/posts/" + str(post, "postId"), "/v2/community/posts/" + str(post, "postId") + "/owned", "/v2/community/replies/" + str(reply, "replyId")} {
		a, x := requestJSON(t, server.URL, path, tokens["owner"], nil)
		if a != 200 || x == nil {
			t.Fatalf("withdraw read status %d", a)
		}
	}
	if _, e := pool.Exec(context.Background(), "UPDATE bindings SET revoked_at=$2,revocation_kind='explicit-binding' WHERE subject_id=$1", obj(f, "owner")["subjectId"], now); e != nil {
		t.Fatal(e)
	}
	status, out = requestJSON(t, server.URL, "/v2/community/posts", tokens["owner"], Object{"payloadJson": envelope["payloadJson"], "signedIntent": envelope["signedIntent"]})
	if status != 401 || str(out, "error") != "access_denied" {
		t.Fatal("revoked signer replay", status, str(out, "error"))
	}
}
