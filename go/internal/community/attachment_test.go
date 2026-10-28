package community

import (
	"bytes"
	"context"
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type forumFixtureFiles struct {
	dir     string
	losePut bool
}

func (f *forumFixtureFiles) KeyID() string { return "isolated-forum-key" }
func (f *forumFixtureFiles) name(key string) string {
	return filepath.Join(f.dir, base64.RawURLEncoding.EncodeToString([]byte(key)))
}
func (f *forumFixtureFiles) Put(_ context.Context, key string, b []byte, hash string) error {
	if attachments.Digest(b) != hash {
		return fail("attachment_digest_mismatch", 400)
	}
	if e := os.WriteFile(f.name(key), b, 0600); e != nil {
		return e
	}
	if f.losePut {
		f.losePut = false
		return fail("attachment_storage_unavailable", 503)
	}
	return nil
}
func (f *forumFixtureFiles) Get(_ context.Context, key, kid string, size int64) ([]byte, error) {
	return os.ReadFile(f.name(key))
}
func (f *forumFixtureFiles) Erase(_ context.Context, key string) error {
	e := os.Remove(f.name(key))
	if os.IsNotExist(e) {
		return nil
	}
	return e
}
func (f *forumFixtureFiles) Head(_ context.Context, key, kid string) (*attachments.Head, error) {
	b, e := os.ReadFile(f.name(key))
	if os.IsNotExist(e) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	hash := attachments.Digest(b)
	return &attachments.Head{Size: int64(len(b)), SHA256: &hash}, nil
}

type forumFixtureScanner struct{ now func() time.Time }

func (f forumFixtureScanner) Scan(_ context.Context, _ []byte) (Object, error) {
	return Object{"state": "clean", "checkedAt": f.now().Unix()}, nil
}
func forumBinary(t *testing.T, origin, path, method, token string, raw []byte) (int, []byte) {
	t.Helper()
	req, e := http.NewRequest(method, origin+path, bytes.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	if method == "PUT" {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	res, e := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	body, e := io.ReadAll(res.Body)
	if e != nil {
		t.Fatal(e)
	}
	return res.StatusCode, body
}
func TestForumAttachmentsOriginalNativePublishedSourceAndCleanup(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	store := &forumFixtureFiles{dir: t.TempDir()}
	f := identityFixture(t, dsn, store.dir)
	ctx := context.Background()
	if _, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return nil, objectremoval.MigrateWithin(ctx, tx) }); e != nil {
		t.Fatal(e)
	}
	now := time.Unix(num(f, "now"), 0)
	clock := func() time.Time { return now }
	s := &Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: clock, DeviceAuth: &deviceauth.Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: clock}}
	s.AccountLinks = &accountlinks.Service{Pool: pool, Endpoint: s.Endpoint, Devices: s.DeviceAuth, Providers: []accountlinks.Provider{{Issuer: str(f, "issuer"), ClientID: "galaxy-fixture"}}, Now: clock}
	files := &AttachmentService{Forum: s, Store: store, Scanner: forumFixtureScanner{clock}, Policy: attachments.DefaultPolicy()}
	server := httptest.NewServer(AttachmentHandler{Service: files, Next: Handler{Service: s}})
	defer server.Close()
	origin, token := str(f, "origin"), str(obj(f, "owner"), "token")
	file := obj(f, "file")
	id := str(file, "id")
	payload := []byte(str(file, "text"))
	input := Object{"attachmentId": id, "name": "原/论坛 '🚀.txt", "mediaType": "text/plain", "size": len(payload), "sha256": file["hash"]}
	status, receipt := requestJSON(t, server.URL, "/v2/community/attachments/prepare", token, input)
	if status != 200 {
		t.Fatal(receipt)
	}
	status, original := requestJSON(t, origin, "/v2/community/attachments/read", token, Object{"attachmentId": id})
	if status != 200 {
		t.Fatal(original)
	}
	equal(t, receipt, original)
	store.losePut = true
	status, raw := forumBinary(t, server.URL, "/v2/community/attachments/"+id+"/upload", "PUT", token, payload)
	if status != 503 {
		t.Fatalf("unknown put: %d %s", status, raw)
	}
	status, receipt = requestJSON(t, server.URL, "/v2/community/attachments/read", token, Object{"attachmentId": id})
	if status != 200 || str(receipt, "state") != "uploading" {
		t.Fatal(receipt)
	}
	expires := receipt["expiresAt"]
	status, raw = forumBinary(t, server.URL, "/v2/community/attachments/"+id+"/upload", "PUT", token, payload)
	if status != 200 {
		t.Fatalf("same upload retry: %d %s", status, raw)
	}
	scanned, e := files.ScanPending(ctx, 1)
	if e != nil || num(scanned, "scanned") != 1 {
		t.Fatal(scanned, e)
	}
	_, receipt = requestJSON(t, server.URL, "/v2/community/attachments/read", token, Object{"attachmentId": id})
	_, original = requestJSON(t, origin, "/v2/community/attachments/read", token, Object{"attachmentId": id})
	equal(t, receipt, original)
	if receipt["expiresAt"] != expires {
		t.Fatal("retry reset original expiry")
	}
	post := obj(file, "post")
	status, result := requestJSON(t, server.URL, "/v2/community/posts", token, Object{"payloadJson": post["payloadJson"], "signedIntent": post["signedIntent"]})
	if status != 200 {
		t.Fatal("publish actual attachment", result)
	}
	source := Object{"source": Object{"postId": obj(post, "payload")["postId"], "versionId": obj(post, "payload")["versionId"]}}
	status, raw = forumBinary(t, server.URL, "/v2/community/attachments/"+id+"/content", "POST", "", encode(source))
	if status != 200 || !bytes.Equal(raw, payload) {
		t.Fatalf("anonymous exact published source: %d %s", status, raw)
	}
	status, raw = forumBinary(t, origin, "/v2/community/attachments/"+id+"/content", "POST", "", encode(source))
	if status != 200 || !bytes.Equal(raw, payload) {
		t.Fatalf("original source bytes: %d %s", status, raw)
	}
	second := uuid.NewString()
	input["attachmentId"] = second
	status, result = requestJSON(t, origin, "/v2/community/attachments/prepare", token, input)
	if status != 200 {
		t.Fatal("original prepare", result)
	}
	status, raw = forumBinary(t, origin, "/v2/community/attachments/"+second+"/upload", "PUT", token, payload)
	if status != 200 {
		t.Fatalf("original upload: %d %s", status, raw)
	}
	if _, e = files.ScanPending(ctx, 1); e != nil {
		t.Fatal(e)
	}
	_, receipt = requestJSON(t, server.URL, "/v2/community/attachments/read", token, Object{"attachmentId": second})
	_, original = requestJSON(t, origin, "/v2/community/attachments/read", token, Object{"attachmentId": second})
	equal(t, receipt, original)
	now = now.Add(8 * 24 * time.Hour)
	cleanup, e := files.PurgeExpired(ctx, 20)
	if e != nil || num(cleanup, "objectRemoved") != 0 {
		t.Fatal("clean expired files require operational approval", cleanup, e)
	}
	now = time.Unix(num(f, "now"), 0)
	withdraw := obj(file, "withdraw")
	status, result = requestJSON(t, server.URL, "/v2/community/posts/withdraw", token, Object{"payloadJson": withdraw["payloadJson"], "signedIntent": withdraw["signedIntent"]})
	if status != 200 {
		t.Fatal(result)
	}
	status, _ = forumBinary(t, server.URL, "/v2/community/attachments/"+id+"/content", "POST", "", encode(source))
	if status != 404 {
		t.Fatal("withdrawn source still grants bytes", status)
	}
	cleanup, e = files.PurgeExpired(ctx, 20)
	if e != nil || num(cleanup, "objectRemoved") != 1 {
		t.Fatal("explicit withdrawal cleanup", cleanup, e)
	}
	status, result = requestJSON(t, server.URL, "/v2/community/attachments/revoke", token, Object{"attachmentId": second})
	if status != 200 {
		t.Fatal(result)
	}
	cleanup, e = files.PurgeExpired(ctx, 20)
	if e != nil || num(cleanup, "objectRemoved") != 1 {
		t.Fatal("owner revoke cleanup", cleanup, e)
	}
}
