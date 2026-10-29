package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"net/http/httptest"
	"testing"
	"time"
)

const forumRetentionSnapshot = `SELECT jsonb_build_object('events',(SELECT jsonb_agg(jsonb_build_object('id',id,'subject',subject_id,'account',account_id,'payload',payload_text,'erased',extract(epoch from erased_at)::bigint) ORDER BY id) FROM forum_events_v1),'posts',(SELECT jsonb_agg(jsonb_build_object('id',id,'subject',subject_id,'account',account_id,'state',state,'current',current_version_id) ORDER BY id) FROM forum_posts_v1),'replies',(SELECT jsonb_agg(jsonb_build_object('id',id,'subject',subject_id,'account',account_id,'state',state) ORDER BY id) FROM forum_replies_v1),'erasures',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'key',object_key,'subject',subject_id,'account',account_id,'hash',original_payload_hash,'reason',reason,'policy',policy_version,'at',extract(epoch from erased_at)::bigint,'until',extract(epoch from retained_until)::bigint) ORDER BY table_name,object_key) FROM lifecycle_erasure_records))`

func TestForumOriginalBoundedWorkerRetentionAndDeletionDomainSeams(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	f := syntheticIdentityFixture(t, pool)
	ctx := context.Background()
	at := num(f, "now")
	s := &Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: func() time.Time { return time.Unix(at, 0) }, DeviceAuth: &deviceauth.Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: func() time.Time { return time.Unix(at, 0) }}}
	s.AccountLinks = &accountlinks.Service{Pool: pool, Endpoint: s.Endpoint, Devices: s.DeviceAuth, Providers: []accountlinks.Provider{{Issuer: str(f, "issuer"), ClientID: "galaxy-fixture"}}, Now: s.Now}
	server := httptest.NewServer(Handler{Service: s})
	defer server.Close()
	for _, input := range []struct{ key, path, who string }{{"post", "posts", "owner"}, {"reply", "replies", "reporter"}} {
		envelope := obj(f, input.key)
		status, result := requestJSON(t, server.URL, "/v2/community/"+input.path, str(obj(f, input.who), "token"), Object{"payloadJson": envelope["payloadJson"], "signedIntent": envelope["signedIntent"]})
		if status != 200 {
			t.Fatalf("original retained source %s: %d %v", input.key, status, result)
		}
	}
	for _, kind := range []string{"prepare", "minimize", "cleanup"} {
		checked := at
		if kind == "cleanup" {
			checked += 7200
		}
		input := Object{"kind": kind, "subjectId": str(obj(f, "owner"), "subjectId"), "at": checked, "retainedUntil": checked + 180*86400}
		tx, e := pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if kind == "cleanup" {
			if _, e = tx.Exec(ctx, "SET LOCAL ROLE galaxy_evidence_worker"); e != nil {
				tx.Rollback(ctx)
				t.Fatal(e)
			}
		}
		info := DeletionInfo{SubjectID: str(input, "subjectId"), At: checked, RetainedUntil: num(input, "retainedUntil")}
		var result Object
		switch kind {
		case "prepare":
			result, e = s.PrepareDeletionWithin(ctx, tx, info)
		case "minimize":
			result, e = s.MinimizeDeletionWithin(ctx, tx, info)
		case "cleanup":
			result, e = s.CleanupRetentionWithin(ctx, tx, checked)
		}
		if e != nil {
			tx.Rollback(ctx)
			t.Fatalf("%s original domain seam: %v", kind, e)
		}
		if result == nil {
			tx.Rollback(ctx)
			t.Fatal("retention result missing")
		}
		if kind == "prepare" && num(result, "forum_events_v1") != 1 {
			tx.Rollback(ctx)
			t.Fatal("owned signed source was not erased", result)
		}
		if kind == "minimize" && result["forumRetainedSourcesMinimized"] != true {
			tx.Rollback(ctx)
			t.Fatal("retained source not minimized", result)
		}
		var snapshot Object
		if e = tx.QueryRow(ctx, forumRetentionSnapshot).Scan(&snapshot); e != nil {
			tx.Rollback(ctx)
			t.Fatal(e)
		}
		if snapshot == nil {
			tx.Rollback(ctx)
			t.Fatal("retention source snapshot missing")
		}
		if kind == "minimize" {
			var survivor string
			if e = tx.QueryRow(ctx, "SELECT subject_id FROM forum_replies_v1 WHERE id=$1", obj(obj(f, "reply"), "payload")["replyId"]).Scan(&survivor); e != nil || survivor != str(obj(f, "reporter"), "subjectId") {
				tx.Rollback(ctx)
				t.Fatal("independent reply author was minimized", survivor, e)
			}
		}
		tx.Rollback(ctx)
	}
}
