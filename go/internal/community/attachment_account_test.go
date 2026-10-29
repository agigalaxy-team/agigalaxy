package community

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

// Official accounts need no local identity or device binding to use forum
// attachments. Portal credential validation is covered by the portal/HTTP
// tests; this regression exercises the resulting account authority against
// the current Go services and real, isolated PostgreSQL ledgers.
func TestForumAccountAttachmentAudienceAndAtomicPublication(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	f := seedCommunity(t, pool)
	ctx := context.Background()
	ids := f["accounts"].([]any)
	owner, reader := asString(ids[0]), asString(ids[1])
	auth := &fixtureAuth{}
	now := time.Unix(2000000000, 0)
	s := &Service{Pool: pool, Endpoint: str(f, "endpoint"), Authority: auth, Now: func() time.Time { return now }}
	store := &forumFixtureFiles{dir: t.TempDir()}
	files := &AttachmentService{Forum: s, Store: store, Scanner: forumFixtureScanner{s.Now}, Policy: attachments.DefaultPolicy()}
	a := AttachmentActor{AccountID: owner, Authority: auth}
	r := AttachmentActor{AccountID: reader, Authority: auth}
	data := []byte("A current account's forum attachment.\n")
	fileID := uuid.NewString()
	input := Object{"attachmentId": fileID, "name": "讨论资料.txt", "mediaType": "text/plain", "size": len(data), "sha256": attachments.Digest(data)}
	if _, e := files.Prepare(ctx, a, encode(input)); e != nil {
		t.Fatal(e)
	}
	conflict := clone(input)
	conflict["name"] = "another request.txt"
	_, e := files.Prepare(ctx, a, encode(conflict))
	expect(t, e, "attachment_operation_conflict")
	_, e = files.Get(ctx, r, encode(Object{"attachmentId": fileID}))
	expect(t, e, "attachment_unavailable")
	store.losePut = true
	_, e = files.Upload(ctx, a, fileID, io.NopCloser(bytes.NewReader(data)), int64(len(data)), "application/octet-stream", nil)
	expect(t, e, "attachment_storage_unavailable")
	interrupted, e := files.Get(ctx, a, encode(Object{"attachmentId": fileID}))
	if e != nil || !truth(interrupted, "uploadRetryable") {
		t.Fatal(interrupted, e)
	}
	if _, e = files.Upload(ctx, a, fileID, io.NopCloser(bytes.NewReader(data)), int64(len(data)), "application/octet-stream", nil); e != nil {
		t.Fatal(e)
	}
	post := clone(obj(f, "payload"))
	post["attachments"] = []any{Object{"id": fileID, "sha256": input["sha256"]}}
	post["audience"] = Object{"read": Object{"kind": "selected-accounts", "accountIds": []any{reader}}, "participate": Object{"kind": "selected-accounts", "accountIds": []any{reader}}}
	BindCreatePostIDs(owner, post)
	raw := string(encode(post))
	_, e = s.Publish(ctx, owner, raw)
	expect(t, e, "attachment_reference_unavailable")
	var count int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM forum_attachment_links_v1 WHERE attachment_id=$1", fileID).Scan(&count); e != nil || count != 0 {
		t.Fatal("partial publication", count, e)
	}
	if e = pool.QueryRow(ctx, "SELECT COALESCE((SELECT used FROM forum_daily_usage_v1 WHERE account_id=$1 AND category='post'),0)", owner).Scan(&count); e != nil || count != 0 {
		t.Fatal("failed publication spent quota", count, e)
	}
	if result, e := files.ScanPending(ctx, 1); e != nil || num(result, "scanned") != 1 {
		t.Fatal(result, e)
	}
	current, e := files.Get(ctx, a, encode(Object{"attachmentId": fileID}))
	if e != nil || current["expiresAt"] != interrupted["expiresAt"] {
		t.Fatal("retry renewed retention", current, e)
	}
	if _, e = s.Publish(ctx, owner, raw); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Publish(ctx, owner, raw); e != nil {
		t.Fatal("same publication replay", e)
	}
	if e = pool.QueryRow(ctx, "SELECT used FROM forum_daily_usage_v1 WHERE account_id=$1 AND category='post'", owner).Scan(&count); e != nil || count != 1 {
		t.Fatal("replay spent quota", count, e)
	}
	source := Object{"attachmentId": fileID, "source": Object{"postId": post["postId"], "versionId": post["versionId"]}}
	if content, e := files.Content(ctx, r, encode(source)); e != nil || !bytes.Equal(content.Bytes, data) {
		t.Fatal("selected reader", e)
	}
	if _, e = files.Content(ctx, AttachmentActor{}, encode(source)); e == nil {
		t.Fatal("anonymous read of restricted attachment")
	}
	wrong := clone(source)
	wrong["source"] = Object{"postId": uuid.NewString(), "versionId": post["versionId"]}
	if _, e = files.Content(ctx, r, encode(wrong)); e == nil {
		t.Fatal("unrelated source grants content")
	}
	newVersion := clone(post)
	newVersion["operationId"], newVersion["versionId"], newVersion["expectedHeadVersion"] = uuid.NewString(), uuid.NewString(), 1
	newVersion["attachments"] = []any{}
	newVersion["audience"] = Object{"read": Object{"kind": "everyone"}, "participate": Object{"kind": "accounts"}}
	BindForumIDs("publish-version", owner, newVersion)
	if _, e = s.Publish(ctx, owner, string(encode(newVersion))); e != nil {
		t.Fatal("new public version", e)
	}
	if _, e = files.Content(ctx, AttachmentActor{}, encode(source)); e == nil {
		t.Fatal("new public version widened old restricted bytes")
	}
	if _, e = files.Content(ctx, r, encode(source)); e != nil {
		t.Fatal("original selected source lost", e)
	}
	wrong["source"] = Object{"postId": post["postId"], "versionId": newVersion["versionId"]}
	if _, e = files.Content(ctx, AttachmentActor{}, encode(wrong)); e == nil {
		t.Fatal("new version without attachment grants bytes")
	}
	var subject *string
	if e = pool.QueryRow(ctx, "SELECT subject_id FROM forum_attachments_v1 WHERE id=$1", fileID).Scan(&subject); e != nil || subject != nil {
		t.Fatal("account upload created a local identity", subject, e)
	}
	if _, e = files.Revoke(ctx, a, encode(Object{"attachmentId": fileID})); e != nil {
		t.Fatal(e)
	}
	if _, e = files.Content(ctx, r, encode(source)); e == nil {
		t.Fatal("revoked attachment remains readable")
	}
	if result, e := files.PurgeExpired(ctx, 20); e != nil || num(result, "objectRemoved") != 1 {
		t.Fatal(result, e)
	}
	retained, e := files.Prepare(ctx, a, encode(input))
	if e != nil || str(retained, "state") != "erased" {
		t.Fatal("same ID resurrected deleted attachment", retained, e)
	}
	// The API cannot rewrite scan evidence or delete source links. The worker
	// cannot rewrite ownership or fabricate a published link.
	for _, item := range []struct{ role, sql string }{
		{"galaxy_api", "UPDATE forum_attachments_v1 SET sha256=sha256"},
		{"galaxy_api", "UPDATE forum_attachments_v1 SET scan_result=NULL"},
		{"galaxy_api", "DELETE FROM forum_attachment_links_v1"},
		{"galaxy_evidence_worker", "UPDATE forum_attachments_v1 SET account_id=account_id"},
		{"galaxy_evidence_worker", "INSERT INTO forum_attachment_links_v1 SELECT * FROM forum_attachment_links_v1 WHERE false"},
	} {
		tx, e := pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(ctx, "SET LOCAL ROLE "+item.role); e == nil {
			_, e = tx.Exec(ctx, item.sql)
		}
		tx.Rollback(ctx)
		if e == nil {
			t.Fatal("role permitted forbidden mutation", item)
		}
	}
}
