package chat

import (
	"bytes"
	"context"
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
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
	"strconv"
	"testing"
	"time"
)

type fixtureFiles struct {
	dir         string
	failPutOnce bool
	afterGet    func()
}

func (f *fixtureFiles) KeyID() string { return "isolated-attachment-key" }
func (f *fixtureFiles) name(key string) string {
	return filepath.Join(f.dir, base64.RawURLEncoding.EncodeToString([]byte(key)))
}
func (f *fixtureFiles) Put(_ context.Context, key string, bytes []byte, hash string) error {
	if attachments.Digest(bytes) != hash {
		return fail("attachment_digest_mismatch", 400)
	}
	if e := os.WriteFile(f.name(key), bytes, 0600); e != nil {
		return e
	}
	if f.failPutOnce {
		f.failPutOnce = false
		return fail("attachment_storage_unavailable", 503)
	}
	return nil
}
func (f *fixtureFiles) Get(_ context.Context, key, keyID string, size int64) ([]byte, error) {
	bytes, e := os.ReadFile(f.name(key))
	if e == nil && f.afterGet != nil {
		hook := f.afterGet
		f.afterGet = nil
		hook()
	}
	return bytes, e
}
func (f *fixtureFiles) Erase(_ context.Context, key string) error {
	e := os.Remove(f.name(key))
	if os.IsNotExist(e) {
		return nil
	}
	return e
}
func (f *fixtureFiles) Head(_ context.Context, key, kid string) (*attachments.Head, error) {
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

type fixtureScanner struct{ now func() time.Time }

func (f fixtureScanner) Scan(_ context.Context, _ []byte) (map[string]any, error) {
	return Object{"state": "clean", "checkedAt": f.now().Unix()}, nil
}
func attachmentHTTP(t *testing.T, origin, path, method, token string, payload []byte) (int, []byte, http.Header) {
	t.Helper()
	req, e := http.NewRequest(method, origin+path, bytes.NewReader(payload))
	if e != nil {
		t.Fatal(e)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if method == "PUT" {
		req.Header.Set("Content-Type", "application/octet-stream")
		req.Header.Set("Content-Length", strconv.Itoa(len(payload)))
	} else {
		req.Header.Set("Content-Type", "application/json")
	}
	res, e := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	raw, e := io.ReadAll(res.Body)
	if e != nil {
		t.Fatal(e)
	}
	return res.StatusCode, raw, res.Header
}
func TestAttachmentsOriginalNativeHTTPAndCurrentSources(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	archive := fakeArchive(t)
	url := "xmpp://" + archive.Listener.Addr().String()
	store := &fixtureFiles{dir: t.TempDir()}
	f := chatGoIdentityFixture(t, pool)
	now := time.Unix(num(f, "now"), 0)
	clock := func() time.Time { return now }
	ctx := context.Background()
	if _, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return nil, objectremoval.MigrateWithin(ctx, tx) }); e != nil {
		t.Fatal(e)
	}
	devices := &deviceauth.Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: clock}
	owner, e := devices.Authenticate(ctx, str(obj(f, "owner"), "token"), "binding")
	if e != nil {
		t.Fatal(e)
	}
	peer, e := devices.Authenticate(ctx, str(obj(f, "peer"), "token"), "binding")
	if e != nil {
		t.Fatal(e)
	}
	transport, e := NewComponentTransport(url, "gateway.example.invalid", "rooms.example.invalid", testSecret, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	if e = transport.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer transport.Stop()
	s := &Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Links: &accountlinks.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Providers: []accountlinks.Provider{{Issuer: str(f, "issuer"), ClientID: "galaxy-fixture"}}, Now: clock}, Transport: transport, Rules: &businessrules.Service{Endpoint: str(f, "endpoint"), Now: clock}, Now: clock}
	files := &AttachmentService{Chat: s, Store: store, Scanner: fixtureScanner{clock}, Policy: attachments.DefaultPolicy()}
	s.Attachments = files
	a, b := Actor{Device: &owner}, Actor{Device: &peer}
	room := uuid.NewString()
	created, e := s.Create(ctx, a, encode(Object{"roomId": room, "operationId": uuid.NewString(), "title": "原附件讨论"}))
	if e != nil {
		t.Fatal(e)
	}
	decision := uuid.NewString()
	if _, e = s.Propose(ctx, a, room, encode(Object{"decisionId": decision, "expectedRevision": created["revision"], "action": "invite", "targetSubjectId": peer.SubjectID})); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Accept(ctx, b, room, encode(Object{"decisionId": decision})); e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(AttachmentHandler{Service: files, Next: Handler{Service: s}})
	defer server.Close()
	payload := []byte("原附件内容\n")
	id := uuid.NewString()
	input := Object{"attachmentId": id, "roomId": room, "name": "原附件 <'🚀>.txt", "mediaType": "text/plain", "size": int64(len(payload)), "sha256": attachments.Digest(payload), "purpose": "temporary-room-attachment", "confirmed": true}
	token := str(obj(f, "owner"), "token")
	status, goReceipt := chatRequest(t, server.URL, "/v2/chat/attachments/prepare", token, input)
	if status != 200 {
		t.Fatal(goReceipt)
	}
	if str(goReceipt, "attachmentId") != id {
		t.Fatal("prepared attachment changed", goReceipt)
	}
	store.failPutOnce = true
	status, raw, _ := attachmentHTTP(t, server.URL, "/v2/chat/attachments/"+id+"/upload", "PUT", token, payload)
	if status != 503 {
		t.Fatalf("unknown store put: %d %s", status, raw)
	}
	pending, e := files.Get(ctx, a, encode(Object{"attachmentId": id}))
	if e != nil || str(pending, "state") != "uploading" {
		t.Fatalf("put reservation: %v %v", pending, e)
	}
	firstExpiry := pending["expiresAt"]
	status, raw, _ = attachmentHTTP(t, server.URL, "/v2/chat/attachments/"+id+"/upload", "PUT", token, payload)
	if status != 200 {
		t.Fatalf("upload retry: %d %s", status, raw)
	}
	scan, e := files.ScanPending(ctx, 1)
	if e != nil || num(scan, "scanned") != 1 {
		t.Fatalf("scan: %v %v", scan, e)
	}
	receipt, e := files.Get(ctx, a, encode(Object{"attachmentId": id}))
	if e != nil || str(receipt, "state") != "available" || receipt["expiresAt"] != firstExpiry {
		t.Fatalf("receipt: %v %v", receipt, e)
	}
	message, e := s.Send(ctx, a, room, encode(Object{"clientMessageId": uuid.NewString(), "text": "", "attachments": []any{Object{"id": id, "sha256": input["sha256"]}}}))
	if e != nil {
		t.Fatal(e)
	}
	history, e := s.History(ctx, b, room, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	if len(history["messages"].([]Object)) != 1 {
		t.Fatal("attachment message history changed", history)
	}
	status, raw, headers := attachmentHTTP(t, server.URL, "/v2/chat/attachments/"+id+"/content", "POST", str(obj(f, "peer"), "token"), []byte(`{}`))
	if status != 200 || !bytes.Equal(raw, payload) || headers.Get("X-Galaxy-Content-Sha256") != input["sha256"] {
		t.Fatalf("download: %d %s", status, raw)
	}
	if headers.Get("Content-Disposition") == "" {
		t.Fatal("attachment disposition absent")
	}
	store.afterGet = func() {
		if _, e := s.Hide(ctx, b, room, str(message, "messageId"), true); e != nil {
			panic(e)
		}
	}
	if _, e = files.Content(ctx, b, encode(Object{"attachmentId": id}), false); fault.Code(e) != "attachment_message_unavailable" {
		t.Fatalf("late personal hide leaked bytes: %v", e)
	}
	if _, e = files.Content(ctx, a, encode(Object{"attachmentId": id}), true); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Retract(ctx, a, room, str(message, "messageId")); e != nil {
		t.Fatal(e)
	}
	cleanup, e := files.PurgeExpired(ctx, 20)
	if e != nil || num(cleanup, "objectRemoved") != 1 {
		t.Fatalf("withdrawn cleanup: %v %v", cleanup, e)
	}
	id2 := uuid.NewString()
	input["attachmentId"] = id2
	status, secondReceipt := chatRequest(t, server.URL, "/v2/chat/attachments/prepare", token, input)
	if status != 200 {
		t.Fatal(secondReceipt)
	}
	status, raw, _ = attachmentHTTP(t, server.URL, "/v2/chat/attachments/"+id2+"/upload", "PUT", token, payload)
	if status != 200 {
		t.Fatalf("second upload: %d %s", status, raw)
	}
	if _, e = files.ScanPending(ctx, 1); e != nil {
		t.Fatal(e)
	}
	content, e := files.Content(ctx, a, encode(Object{"attachmentId": id2}), false)
	if e != nil || !bytes.Equal(content.Bytes, payload) {
		t.Fatalf("Go reads second upload: %v", e)
	}
	saved := now
	now = now.Add(31 * 24 * time.Hour)
	cleanup, e = files.PurgeExpired(ctx, 20)
	if e != nil || num(cleanup, "objectRemoved") != 0 {
		t.Fatalf("elapsed clean file treated as delete approval: %v %v", cleanup, e)
	}
	if _, e = os.Stat(store.name("attachments/" + id2)); e != nil {
		t.Fatal("clean expired original file removed", e)
	}
	now = saved
	if _, e = files.Revoke(ctx, a, encode(Object{"attachmentId": id2})); e != nil {
		t.Fatal(e)
	}
	cleanup, e = files.PurgeExpired(ctx, 20)
	if e != nil || num(cleanup, "objectRemoved") != 1 {
		t.Fatalf("owner revoked cleanup: %v %v", cleanup, e)
	}
}
