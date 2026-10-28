package feedback

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ownerStore struct {
	memoryAttachmentStore
	muDelete             sync.Mutex
	eraseCalls           int
	loseAck, refuseErase bool
}

func (m *ownerStore) Head(_ context.Context, key, keyID string) (*attachments.Head, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if keyID != m.KeyID() {
		return nil, fault.New("attachment_encryption_key_unavailable", 503)
	}
	b, ok := m.bytes[key]
	if !ok {
		return nil, nil
	}
	hash := attachments.Digest(b)
	return &attachments.Head{Size: int64(len(b)), SHA256: &hash}, nil
}
func (m *ownerStore) Erase(_ context.Context, key string) error {
	m.muDelete.Lock()
	defer m.muDelete.Unlock()
	m.eraseCalls++
	if m.refuseErase {
		return fault.New("attachment_storage_unavailable", 503)
	}
	m.mu.Lock()
	delete(m.bytes, key)
	m.mu.Unlock()
	if m.loseAck {
		m.loseAck = false
		return fault.New("attachment_storage_unavailable", 503)
	}
	return nil
}
func ownerRolePool(t *testing.T, dsn, role string) *pgxpool.Pool {
	t.Helper()
	config, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error { _, e := conn.Exec(ctx, "SET ROLE "+role); return e }
	pool, e := pgxpool.NewWithConfig(context.Background(), config)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(pool.Close)
	return pool
}
func ownerNodeProjection(t *testing.T, dsn, account, operation string, now time.Time) Object {
	t.Helper()
	root, e := filepath.Abs(filepath.Join("..", "..", ".."))
	if e != nil {
		t.Fatal(e)
	}
	script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import {AccountFeedbackDataService} from './packages/galaxy-official/src/operations/feedback/owner-data.mjs';import {FeedbackAttachmentsV1Service} from './packages/galaxy-official/src/community/feedback-attachments-v1.mjs';const url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/galaxy_go_test_'))throw Error('isolated db required');const db=new pg.Pool({connectionString:url.href});const endpoint='https://go-feedback.example.invalid',accountId=process.argv[1],operation=process.argv[2],now=()=>Number(process.argv[3]);const accounts={runAuthorized:(_a,_p,fn)=>fn(db,null,{accountId}),resolveWithin:async()=>({id:accountId})};const files=new FeedbackAttachmentsV1Service({db,endpoint,accounts,store:{},scanner:{},now});const service=new AccountFeedbackDataService({db,endpoint,accounts,feedbackAttachments:files,now});const actor={kind:'official-account',endpoint,accountId};try{console.log(JSON.stringify({operation:await service.operation(actor,operation),page:await service.exportPage(actor,operation,{limit:1})}))}finally{await db.end()}`
	cmd := exec.Command("node", "--input-type=module", "-e", script, account, operation, strconvUnix(now))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original owner projection %v %s", e, out)
	}
	var result Object
	if e = json.Unmarshal(out, &result); e != nil {
		t.Fatal(e)
	}
	return result
}
func strconvUnix(now time.Time) string { return strconv.FormatInt(now.Unix(), 10) }

func TestOwnerFeedbackDataOriginalRolesAndRecovery(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	var fixture struct {
		Accounts []string
		Endpoint string
	}
	if e := json.Unmarshal(nodeFixture(t, dsn, "setup"), &fixture); e != nil {
		t.Fatal(e)
	}
	// Execute the unchanged official role scripts in this disposable cluster.
	root, e := filepath.Abs(filepath.Join("..", "..", ".."))
	if e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"api-role.sql", "worker-role.sql"} {
		sql, e := os.ReadFile(filepath.Join(root, "packages", "galaxy-official", "src", "infrastructure", name))
		if e != nil {
			t.Fatal(e)
		}
		if _, e = pool.Exec(ctx, string(sql)); e != nil {
			t.Fatalf("original role %s: %v", name, e)
		}
	}
	api := ownerRolePool(t, dsn, "galaxy_api")
	worker := ownerRolePool(t, dsn, "galaxy_evidence_worker")
	now := time.Unix(2000000000, 0)
	auth := &fixtureAuthority{}
	store := &ownerStore{memoryAttachmentStore: memoryAttachmentStore{bytes: map[string][]byte{}}}
	repo := &AttachmentRepository{Endpoint: fixture.Endpoint, Store: store, Scanner: &fixtureScanner{}, Now: func() time.Time { return now }}
	s := &Service{Pool: api, Endpoint: fixture.Endpoint, Authority: auth, Attachments: repo, Now: func() time.Time { return now }}
	w := *s
	w.Pool = worker
	owner, other := fixture.Accounts[0], fixture.Accounts[1]
	// Prepare bytes as API, scan as worker, and bind through the real submission.
	attachment, submission := uuid.NewString(), uuid.NewString()
	b := []byte("OWN_FEEDBACK_BYTES")
	hash := attachments.Digest(b)
	prepare := Object{"attachmentId": attachment, "operationId": submission, "name": "本人材料.txt", "mediaType": "text/plain", "size": len(b), "sha256": hash}
	if _, e = s.AttachmentPrepare(ctx, owner, encoded(t, prepare)); e != nil {
		t.Fatal(e)
	}
	if _, e = s.AttachmentUpload(ctx, owner, attachment, io.NopCloser(bytes.NewReader(b)), int64(len(b)), "application/octet-stream"); e != nil {
		t.Fatal(e)
	}
	if _, e = repo.ScanPending(ctx, worker, 1, nil); e != nil {
		t.Fatal(e)
	}
	firstInput := Object{"operationId": submission, "body": "OWN_FEEDBACK_TEXT", "category": "problem", "module": "account", "attachments": []Reference{{attachment, hash}}}
	first, e := s.Submit(ctx, owner, encoded(t, firstInput))
	if e != nil {
		t.Fatal(e)
	}
	firstID := first["feedbackId"].(string)
	if _, e = s.Update(ctx, "go-admin", firstID, encoded(t, Object{"operationId": uuid.NewString(), "expectedRevision": 1, "state": "processing", "note": "PRIVATE_OPERATOR_NOTE"})); e != nil {
		t.Fatal(e)
	}
	foreignOperation := uuid.NewString()
	foreign, e := s.Submit(ctx, other, encoded(t, Object{"operationId": foreignOperation, "body": "FOREIGN_FEEDBACK_TEXT"}))
	if e != nil {
		t.Fatal(e)
	}
	now = now.Add(61 * time.Second)
	if _, e = s.Submit(ctx, owner, encoded(t, Object{"operationId": uuid.NewString(), "body": "SECOND_OWN_FEEDBACK"})); e != nil {
		t.Fatal(e)
	}
	export := uuid.NewString()
	intent, e := s.OwnerDataBegin(ctx, owner, encoded(t, Object{"operationId": export}), "export")
	if e != nil || intent["feedbackCount"] != 2 || intent["attachmentCount"] != 1 {
		t.Fatalf("export intent %v %v", intent, e)
	}
	page, e := s.OwnerDataExportPage(ctx, owner, export, "0", 1)
	if e != nil {
		t.Fatal(e)
	}
	operation, e := s.OwnerDataOperation(ctx, owner, export)
	if e != nil {
		t.Fatal(e)
	}
	original := ownerNodeProjection(t, dsn, owner, export, now)
	if !reflect.DeepEqual(normalized(t, Object{"operation": operation, "page": page}), original) {
		t.Fatalf("Node owner projection differs\nGo=%s\nNode=%s", encoded(t, Object{"operation": operation, "page": page}), encoded(t, original))
	}
	serialized := string(encoded(t, page))
	for _, hidden := range []string{"PRIVATE_OPERATOR_NOTE", "FOREIGN_FEEDBACK_TEXT", "processing", "storage_key", "encryption_key_id"} {
		if strings.Contains(serialized, hidden) {
			t.Fatalf("owner export exposed %s", hidden)
		}
	}
	if page["nextAfter"] == nil {
		t.Fatal("expected pagination cursor")
	}
	next, e := s.OwnerDataExportPage(ctx, owner, export, page["nextAfter"].(string), 1)
	if e != nil || len(next["items"].([]Object)) != 1 || next["nextAfter"] != nil {
		t.Fatalf("next page %v %v", next, e)
	}
	receipt, e := s.OwnerDataOperation(ctx, other, export)
	if e != nil || receipt["state"] != "not-recorded" {
		t.Fatalf("foreign receipt %v %v", receipt, e)
	}
	_, e = s.OwnerDataExportPage(ctx, other, export, "0", 50)
	code(t, e, "not_found")
	content, e := s.OwnerDataContent(ctx, owner, export, attachment, func() (string, Authorization, error) { return owner, auth, nil })
	if e != nil || !bytes.Equal(content.Bytes, b) {
		t.Fatalf("owner content %v", e)
	}
	checks := 0
	_, e = s.OwnerDataContent(ctx, owner, export, attachment, func() (string, Authorization, error) {
		checks++
		if checks > 1 {
			return other, auth, nil
		}
		return owner, auth, nil
	})
	code(t, e, "official_account_changed")
	// Original HTTP paths retain CSRF and reject supplied account fields/tokens.
	handler := Handler{Service: s, Identity: fixtureHTTPIdentity{auth, owner}}
	call := func(method, path, raw, csrf string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Cookie", "account=owner")
		r.Header.Set("Origin", "https://web.example.invalid")
		r.Header.Set("X-CSRF", csrf)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		return response
	}
	if response := call("POST", "/v1/account/data/feedback/export", `{"operationId":"`+uuid.NewString()+`"}`, ""); response.Code != 403 {
		t.Fatalf("owner CSRF %d", response.Code)
	}
	if response := call("GET", "/v1/account/data/feedback/exports/"+export+"?limit=1&limit=2", "", ""); response.Code != 400 {
		t.Fatalf("duplicate query %d", response.Code)
	}
	if response := call("POST", "/v1/account/data/feedback/export", string(encoded(t, Object{"operationId": export})), "fixture-choice"); response.Code != 200 {
		t.Fatalf("original intent replay HTTP %d %s", response.Code, response.Body)
	}
	if response := call("GET", "/v1/account/data/feedback/exports/"+export+"?limit=1", "", ""); response.Code != 200 {
		t.Fatalf("owner export page HTTP %d %s", response.Code, response.Body)
	}
	if response := call("POST", "/v1/account/data/feedback/exports/"+export+"/attachments/"+attachment+"/content", "{}", "fixture-choice"); response.Code != 200 || !bytes.Equal(response.Body.Bytes(), b) {
		t.Fatalf("owner export binary HTTP %d %s", response.Code, response.Body)
	}
	_, e = s.OwnerDataBegin(ctx, owner, encoded(t, Object{"operationId": export}), "delete")
	code(t, e, "account_feedback_operation_conflict")
	now = now.Add(61 * time.Second)
	if _, e = s.Submit(ctx, owner, encoded(t, Object{"operationId": uuid.NewString(), "body": "AFTER_EXPORT_SELECTION"})); e != nil {
		t.Fatal(e)
	}
	fixed, e := s.OwnerDataExportPage(ctx, owner, export, "0", 50)
	if e != nil || len(fixed["items"].([]Object)) != 2 {
		t.Fatalf("export selection changed %v %v", fixed, e)
	}
	deletion := uuid.NewString()
	deleteResponse := call("POST", "/v1/account/data/feedback/delete", string(encoded(t, Object{"operationId": deletion})), "fixture-choice")
	var deleted Object
	if e = json.Unmarshal(deleteResponse.Body.Bytes(), &deleted); e != nil || deleteResponse.Code != 201 || deleted["metadataDeleted"] != true || deleted["phase"] != "pending" || store.eraseCalls != 0 {
		t.Fatalf("delete intent HTTP %d %v %v", deleteResponse.Code, deleted, e)
	}
	// API cannot rewrite tombstone text; worker cannot create owner deletion.
	if _, e = api.Exec(ctx, "UPDATE operations_feedback_v1 SET body='recreate' WHERE id=$1", firstID); e == nil {
		t.Fatal("API rewrote owner-erased feedback")
	}
	if _, e = worker.Exec(ctx, "SELECT public.galaxy_account_erase_feedback_data($1,$2,$3)", s.Endpoint, owner, deletion); e == nil {
		t.Fatal("worker could invoke owner erasure intent")
	}
	if _, e = worker.Exec(ctx, "UPDATE account_feedback_data_operations_v1 SET account_id=$2 WHERE operation_id=$1", deletion, other); e == nil {
		t.Fatal("worker changed owner")
	}
	afterDelete, e := s.OwnerDataExportPage(ctx, owner, export, "0", 50)
	if e != nil {
		t.Fatal(e)
	}
	for _, item := range afterDelete["items"].([]Object) {
		if item["state"] != "deleted" || item["body"] != nil || len(item["attachments"].([]Object)) != 0 {
			t.Fatalf("tombstone leak %v", item)
		}
	}
	replay, e := s.Submit(ctx, owner, encoded(t, firstInput))
	if e != nil || replay["deleted"] != true || replay["replayed"] != true {
		t.Fatalf("deleted original replay %v %v", replay, e)
	}
	_, e = s.OwnerDataContent(ctx, owner, export, attachment, func() (string, Authorization, error) { return owner, auth, nil })
	code(t, e, "feedback_attachment_unavailable")
	// A lost DELETE acknowledgement is unknown, then reconciled using HEAD;
	// absence never sends a second DELETE or creates another business operation.
	store.loseAck = true
	if _, e = w.ProcessOwnerDeletions(ctx, 1, nil); e != nil {
		t.Fatal(e)
	}
	unknown, e := s.OwnerDataOperation(ctx, owner, deletion)
	if e != nil || unknown["attachments"].(Object)["resultUnknown"] != 1 || unknown["phase"] != "pending" {
		t.Fatalf("unknown delete %v %v", unknown, e)
	}
	if store.eraseCalls != 1 {
		t.Fatal("unexpected erase attempts")
	}
	now = now.Add(31 * time.Second)
	if _, e = w.ProcessOwnerDeletions(ctx, 1, nil); e != nil {
		t.Fatal(e)
	}
	done, e := s.OwnerDataOperation(ctx, owner, deletion)
	if e != nil || done["phase"] != "completed" || done["attachments"].(Object)["objectRemoved"] != true || store.eraseCalls != 1 {
		t.Fatalf("HEAD reconcile %v %v erase=%d", done, e, store.eraseCalls)
	}
	var note string
	if e = pool.QueryRow(ctx, "SELECT note FROM operations_feedback_events_v1 WHERE feedback_id=$1 AND note IS NOT NULL", firstID).Scan(&note); e != nil || note != "PRIVATE_OPERATOR_NOTE" {
		t.Fatalf("internal note changed %q %v", note, e)
	}
	now = now.Add(31 * time.Second)
	later, e := s.Submit(ctx, owner, encoded(t, Object{"operationId": uuid.NewString(), "body": "LATER_FEEDBACK_KEPT"}))
	if e != nil {
		t.Fatal(e)
	}
	replayed, e := s.OwnerDataBegin(ctx, owner, encoded(t, Object{"operationId": deletion}), "delete")
	if e != nil || replayed["replayed"] != true {
		t.Fatalf("delete replay %v %v", replayed, e)
	}
	if _, e = s.Get(ctx, "go-reader", later["feedbackId"].(string), ""); e != nil {
		t.Fatal("delete replay widened selection", e)
	}
	// Changed linkage must never turn an owner's recorded item into authority
	// over another account's file. The original attempt cap includes failures.
	now = now.Add(61 * time.Second)
	id2, operation2 := uuid.NewString(), uuid.NewString()
	prepare["attachmentId"] = id2
	prepare["operationId"] = operation2
	if _, e = s.AttachmentPrepare(ctx, owner, encoded(t, prepare)); e != nil {
		t.Fatal(e)
	}
	if _, e = s.AttachmentUpload(ctx, owner, id2, io.NopCloser(bytes.NewReader(b)), int64(len(b)), "application/octet-stream"); e != nil {
		t.Fatal(e)
	}
	if _, e = repo.ScanPending(ctx, worker, 1, nil); e != nil {
		t.Fatal(e)
	}
	final, e := s.Submit(ctx, owner, encoded(t, Object{"operationId": operation2, "body": "FINAL_OWN_FEEDBACK", "attachments": []Reference{{id2, hash}}}))
	if e != nil {
		t.Fatal(e)
	}
	deletion2 := uuid.NewString()
	if _, e = s.OwnerDataBegin(ctx, owner, encoded(t, Object{"operationId": deletion2}), "delete"); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, "UPDATE feedback_attachments_v1 SET feedback_id=$2,submission_operation_id=$3,account_id=$4 WHERE id=$1", id2, foreign["feedbackId"], foreignOperation, other); e != nil {
		t.Fatal(e)
	}
	beforeErase := store.eraseCalls
	if _, e = w.ProcessOwnerDeletions(ctx, 1, nil); e != nil {
		t.Fatal(e)
	}
	if store.eraseCalls != beforeErase {
		t.Fatal("changed foreign source was erased")
	}
	if _, e = pool.Exec(ctx, "UPDATE feedback_attachments_v1 SET feedback_id=$2,submission_operation_id=$3,account_id=$4 WHERE id=$1", id2, final["feedbackId"], operation2, owner); e != nil {
		t.Fatal(e)
	}
	store.refuseErase = true
	for i := 0; i < 2; i++ {
		now = now.Add(31 * time.Second)
		if _, e = w.ProcessOwnerDeletions(ctx, 1, nil); e != nil {
			t.Fatal(e)
		}
	}
	attention, e := s.OwnerDataOperation(ctx, owner, deletion2)
	if e != nil || attention["phase"] != "attention" || attention["attachments"].(Object)["objectRemoved"] != nil {
		t.Fatalf("unconfirmed attention %v %v", attention, e)
	}
	beforeErase = store.eraseCalls
	now = now.Add(31 * time.Second)
	if _, e = w.ProcessOwnerDeletions(ctx, 1, nil); e != nil {
		t.Fatal(e)
	}
	if store.eraseCalls != beforeErase {
		t.Fatal("exhausted attempt cap issued another DELETE")
	}
	var attempts int
	if e = pool.QueryRow(ctx, "SELECT attempt_count FROM account_feedback_data_items_v1 WHERE operation_id=$1", deletion2).Scan(&attempts); e != nil || attempts != 3 {
		t.Fatalf("attempt cap %d %v", attempts, e)
	}
	// Later absence may confirm the same intent even after DELETE attempts are
	// exhausted. This observation performs no further object write.
	store.mu.Lock()
	delete(store.bytes, "feedback-attachments/"+id2)
	store.mu.Unlock()
	now = now.Add(301 * time.Second)
	if _, e = w.ProcessOwnerDeletions(ctx, 1, nil); e != nil {
		t.Fatal(e)
	}
	confirmed, e := s.OwnerDataOperation(ctx, owner, deletion2)
	if e != nil || confirmed["phase"] != "completed" || store.eraseCalls != beforeErase {
		t.Fatalf("verification-only reconciliation %v %v", confirmed, e)
	}
}
