package feedback

import (
	"bytes"
	"context"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/feedbackfixture"
	"github.com/google/uuid"
)

type memoryAttachmentStore struct {
	mu       sync.Mutex
	bytes    map[string][]byte
	failPut  bool
	afterGet func()
}

func (m *memoryAttachmentStore) KeyID() string { return "fixture-key" }
func (m *memoryAttachmentStore) Put(_ context.Context, key string, b []byte, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.bytes[key] = append([]byte(nil), b...)
	if m.failPut {
		return fault.New("attachment_storage_unavailable", 503)
	}
	return nil
}
func (m *memoryAttachmentStore) Get(_ context.Context, key, _ string, _ int64) ([]byte, error) {
	m.mu.Lock()
	b := append([]byte(nil), m.bytes[key]...)
	m.mu.Unlock()
	if m.afterGet != nil {
		m.afterGet()
	}
	return b, nil
}

type fixtureScanner struct{ fail bool }

func (f *fixtureScanner) Scan(context.Context, []byte) (map[string]any, error) {
	if f.fail {
		return nil, fault.New("attachment_scanner_unavailable", 503)
	}
	return map[string]any{"state": "clean", "engine": "controlled-fixture", "guaranteedSafe": false}, nil
}

func TestFeedbackAttachmentOriginalLedgerLifecycle(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	fixture := feedbackfixture.Create(t, pool)
	now := time.Unix(2000000000, 0)
	store := &memoryAttachmentStore{bytes: map[string][]byte{}}
	scanner := &fixtureScanner{}
	repo := &AttachmentRepository{Endpoint: fixture.Endpoint, Store: store, Scanner: scanner, Now: func() time.Time { return now }}
	s := &Service{Pool: pool, Endpoint: fixture.Endpoint, Authority: &fixtureAuthority{}, Attachments: repo, Now: func() time.Time { return now }}
	handler := Handler{Service: s, Identity: fixtureHTTPIdentity{s.Authority.(*fixtureAuthority), fixture.Accounts[0]}}
	httpCall := func(method, path, body, csrf string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", "account=owner; operator=go-admin")
		request.Header.Set("Origin", "https://web.example.invalid")
		request.Header.Set("X-CSRF", csrf)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	if response := httpCall("POST", "/v1/account/feedback/attachments/config", "{}", ""); response.Code != 403 {
		t.Fatalf("config CSRF %d", response.Code)
	}
	if response := httpCall("POST", "/v1/account/feedback/attachments/config", "{}", "fixture-choice"); response.Code != 200 {
		t.Fatalf("config %d %s", response.Code, response.Body)
	}
	account := fixture.Accounts[0]
	operation, id := uuid.NewString(), uuid.NewString()
	b := []byte(`{"feedback":"private"}`)
	hash := attachments.Digest(b)
	request := Object{"attachmentId": id, "operationId": operation, "name": "  私有资料.json  ", "mediaType": "application/json", "size": len(b), "sha256": hash}
	prepared, e := s.AttachmentPrepare(ctx, account, encoded(t, request))
	if e != nil || prepared["state"] != "prepared" || prepared["name"] != "私有资料.json" {
		t.Fatalf("prepare %v %v", prepared, e)
	}
	replay, e := s.AttachmentPrepare(ctx, account, encoded(t, request))
	if e != nil || !bytes.Equal(encoded(t, prepared), encoded(t, replay)) {
		t.Fatalf("prepare replay %v %v", replay, e)
	}
	target := encoded(t, Object{"attachmentId": id, "operationId": operation})
	_, e = s.AttachmentTarget(ctx, fixture.Accounts[1], target, false)
	code(t, e, "feedback_attachment_unavailable")
	request["name"] = "other.json"
	_, e = s.AttachmentPrepare(ctx, account, encoded(t, request))
	code(t, e, "attachment_operation_conflict")
	// A store may have committed before its response is lost. Keep uploading,
	// retain original first-start expiry and release only the original lease.
	store.failPut = true
	_, e = s.AttachmentUpload(ctx, account, id, io.NopCloser(bytes.NewReader(b)), int64(len(b)), "application/octet-stream")
	code(t, e, "attachment_storage_unavailable")
	unknown, e := s.AttachmentTarget(ctx, account, target, false)
	if e != nil || unknown["state"] != "uploading" || unknown["uploadRetryable"] != true {
		t.Fatalf("unknown result %v %v", unknown, e)
	}
	store.failPut = false
	now = now.Add(time.Minute)
	uploaded, e := s.AttachmentUpload(ctx, account, id, io.NopCloser(bytes.NewReader(b)), int64(len(b)), "application/octet-stream")
	if e != nil || uploaded["state"] != "scan-pending" || uploaded["expiresAt"] != unknown["expiresAt"] {
		t.Fatalf("upload %v %v", uploaded, e)
	}
	// Scanner failure defers the original row, and cannot make it bindable.
	scanner.fail = true
	scans, e := repo.ScanPending(ctx, pool, 1, nil)
	if e != nil || scans["scanned"] != 0 {
		t.Fatalf("defer %v %v", scans, e)
	}
	submission := Object{"operationId": operation, "body": "附件反馈", "attachments": []Reference{{id, hash}}}
	_, e = s.Submit(ctx, account, encoded(t, submission))
	code(t, e, "feedback_attachment_not_ready")
	scanner.fail = false
	now = now.Add(time.Minute)
	scans, e = repo.ScanPending(ctx, pool, 1, nil)
	if e != nil || scans["scanned"] != 1 {
		t.Fatalf("scan %v %v", scans, e)
	}
	submitted, e := s.Submit(ctx, account, encoded(t, submission))
	if e != nil {
		t.Fatal(e)
	}
	feedback := submitted["feedbackId"].(string)
	_, e = s.AttachmentTarget(ctx, account, target, false)
	code(t, e, "feedback_attachment_unavailable")
	_, e = s.AttachmentTarget(ctx, account, target, true)
	code(t, e, "feedback_attachment_draft_closed")
	content, e := s.AttachmentContent(ctx, "go-admin", feedback, id, nil)
	if e != nil || !bytes.Equal(content.Bytes, b) || content.Name != "私有资料.json" {
		t.Fatalf("content %v %v", content, e)
	}
	path := "/v1/operations/feedback/" + feedback + "/attachments/" + id + "/content"
	if response := httpCall("POST", path, "{}", ""); response.Code != 403 {
		t.Fatalf("download CSRF %d", response.Code)
	}
	if response := httpCall("POST", path, "{}", "fixture-choice"); response.Code != 200 || !bytes.Equal(response.Body.Bytes(), b) || response.Header().Get("X-Galaxy-Content-Sha256") != hash {
		t.Fatalf("binary content %d %s", response.Code, response.Body)
	}
	// Corrupt object never leaves the application, even after a clean scan.
	store.bytes["feedback-attachments/"+id] = []byte("corrupt")
	_, e = s.AttachmentContent(ctx, "go-admin", feedback, id, nil)
	code(t, e, "attachment_storage_integrity_failed")
	store.bytes["feedback-attachments/"+id] = b
	checks := 0
	_, e = s.AttachmentContent(ctx, "go-admin", feedback, id, func() error {
		checks++
		if checks > 1 {
			return fault.New("business_admin_denied", 403)
		}
		return nil
	})
	code(t, e, "business_admin_denied")
	if checks != 2 {
		t.Fatalf("expected authorization on both sides of storage, got %d", checks)
	}
	// Expiry is tied to first upload start, not feedback submission or retries.
	now = time.Unix(2000000000, 0).Add(30 * 24 * time.Hour)
	_, e = s.AttachmentContent(ctx, "go-admin", feedback, id, nil)
	code(t, e, "feedback_attachment_content_unavailable")
	// A live upload lease cannot be stolen; revocation stops it without any
	// implicit object erase. Shared usage counts purged_at, not logical expiry.
	operation2, id2 := uuid.NewString(), uuid.NewString()
	request2 := Object{"attachmentId": id2, "operationId": operation2, "name": "draft.json", "mediaType": "application/json", "size": len(b), "sha256": hash}
	if _, e = s.AttachmentPrepare(ctx, account, encoded(t, request2)); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, "UPDATE feedback_attachments_v1 SET state='uploading',lease_id=$2,lease_until=$3 WHERE id=$1", id2, uuid.NewString(), now.Add(time.Minute)); e != nil {
		t.Fatal(e)
	}
	_, e = s.AttachmentUpload(ctx, account, id2, io.NopCloser(bytes.NewReader(b)), int64(len(b)), "application/octet-stream")
	code(t, e, "attachment_upload_in_progress")
	revoked, e := s.AttachmentTarget(ctx, account, encoded(t, Object{"attachmentId": id2, "operationId": operation2}), true)
	if e != nil || revoked["state"] != "revoked" {
		t.Fatalf("revoke %v %v", revoked, e)
	}
	if !bytes.Equal(store.bytes["feedback-attachments/"+id], b) {
		t.Fatal("logical revocation erased bytes")
	}
	repo.Policy = attachments.Policy{Version: 1, MaxFileBytes: 100, MaxSubjectBytes: 100, MaxGlobalBytes: 100, MaxFilesPerMessage: 4}
	request2["attachmentId"] = uuid.NewString()
	request2["operationId"] = uuid.NewString()
	request2["size"] = 90
	_, e = s.AttachmentPrepare(ctx, account, encoded(t, request2))
	code(t, e, "attachment_storage_quota_exceeded")
}

func TestAttachmentPrepareNumberAndStrictSchema(t *testing.T) {
	raw := `{"operationId":"11111111-1111-4111-8111-111111111111","attachmentId":"22222222-2222-4222-8222-222222222222","name":"a.txt","mediaType":"text/plain","size":1e0,"sha256":"` + strings.Repeat("a", 64) + `"}`
	if x, e := parseAttachmentPrepare([]byte(raw)); e != nil || x.Size != 1 {
		t.Fatalf("integral exponent %v %v", x, e)
	}
	for _, value := range []string{`"1"`, `null`, `1.5`} {
		_, e := parseAttachmentPrepare([]byte(strings.Replace(raw, "1e0", value, 1)))
		code(t, e, "invalid_feedback_attachment_request")
	}
	_, e := parseAttachmentPrepare([]byte(strings.Replace(raw, `"name":"a.txt"`, `"name":"../a.txt"`, 1)))
	code(t, e, "invalid_feedback_attachment_request")
}
