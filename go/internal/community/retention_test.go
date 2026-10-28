package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"testing"
	"time"
)

const forumRetentionSnapshot = `SELECT jsonb_build_object('events',(SELECT jsonb_agg(jsonb_build_object('id',id,'subject',subject_id,'account',account_id,'payload',payload_text,'erased',extract(epoch from erased_at)::bigint) ORDER BY id) FROM forum_events_v1),'posts',(SELECT jsonb_agg(jsonb_build_object('id',id,'subject',subject_id,'account',account_id,'state',state,'current',current_version_id) ORDER BY id) FROM forum_posts_v1),'replies',(SELECT jsonb_agg(jsonb_build_object('id',id,'subject',subject_id,'account',account_id,'state',state) ORDER BY id) FROM forum_replies_v1),'erasures',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'key',object_key,'subject',subject_id,'account',account_id,'hash',original_payload_hash,'reason',reason,'policy',policy_version,'at',extract(epoch from erased_at)::bigint,'until',extract(epoch from retained_until)::bigint) ORDER BY table_name,object_key) FROM lifecycle_erasure_records))`

func TestForumOriginalBoundedWorkerRetentionAndDeletionDomainSeams(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	f := identityFixture(t, dsn)
	ctx := context.Background()
	at := num(f, "now")
	s := &Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: func() time.Time { return time.Unix(at, 0) }}
	for _, input := range []struct{ key, path, who string }{{"post", "posts", "owner"}, {"reply", "replies", "reporter"}} {
		envelope := obj(f, input.key)
		status, result := requestJSON(t, str(f, "origin"), "/v2/community/"+input.path, str(obj(f, input.who), "token"), Object{"payloadJson": envelope["payloadJson"], "signedIntent": envelope["signedIntent"]})
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
		expected := object(t, node(t, dsn, "retention", string(encode(input))))
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
		equal(t, result, expected["result"])
		var snapshot Object
		if e = tx.QueryRow(ctx, forumRetentionSnapshot).Scan(&snapshot); e != nil {
			tx.Rollback(ctx)
			t.Fatal(e)
		}
		equal(t, snapshot, expected["snapshot"])
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
