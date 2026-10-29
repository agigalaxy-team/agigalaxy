package feedback

import (
	"bytes"
	"context"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/feedbackfixture"
	"github.com/google/uuid"
)

type riverScannerFixture struct {
	calls atomic.Int32
	fail  atomic.Bool
}

func (s *riverScannerFixture) Scan(context.Context, []byte) (map[string]any, error) {
	s.calls.Add(1)
	if s.fail.Load() {
		return nil, fault.New("attachment_scanner_unavailable", 503)
	}
	return map[string]any{"state": "clean", "engine": "controlled-river-fixture"}, nil
}
func waitFeedbackWorker(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("bounded feedback River wait expired")
}
func TestFeedbackRiverOriginalLeasesPauseAndOwnerHEADRecovery(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := feedbackfixture.Create(t, pool, "api", "worker")
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = jobs.MigrateWithin(ctx, pool, tx); e != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(e)
	}
	if e = jobs.ProvisionRolesWithin(ctx, tx); e != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	api := ownerRolePool(t, dsn, "galaxy_api")
	worker := ownerRolePool(t, dsn, "galaxy_evidence_worker")
	store := &ownerStore{memoryAttachmentStore: memoryAttachmentStore{bytes: map[string][]byte{}}}
	scanner := &riverScannerFixture{}
	scanner.fail.Store(true)
	repo := &AttachmentRepository{Endpoint: fixture.Endpoint, Store: store, Scanner: scanner}
	s := &Service{Pool: api, Endpoint: fixture.Endpoint, Authority: &fixtureAuthority{}, Attachments: repo}
	workerService := *s
	workerService.Pool = worker
	var paused atomic.Bool
	paused.Store(true)
	consumers := &WorkerConsumers{Service: &workerService, CanScan: func(context.Context) (bool, error) { return !paused.Load(), nil }}
	queue, e := jobs.New(worker, consumers.Execute)
	if e != nil {
		t.Fatal(e)
	}
	owner := fixture.Accounts[0]
	payload := []byte("controlled queued feedback bytes")
	hash := attachments.Digest(payload)
	firstID, firstOperation := uuid.NewString(), uuid.NewString()
	secondID, secondOperation := uuid.NewString(), uuid.NewString()
	for _, source := range []struct{ id, operation string }{{firstID, firstOperation}, {secondID, secondOperation}} {
		raw := encoded(t, Object{"operationId": source.operation, "attachmentId": source.id, "name": "queued.txt", "mediaType": "text/plain", "size": len(payload), "sha256": hash})
		if _, e = s.AttachmentPrepare(ctx, owner, raw); e != nil {
			t.Fatal(e)
		}
		if _, e = s.AttachmentUpload(ctx, owner, source.id, io.NopCloser(bytes.NewReader(payload)), int64(len(payload)), "application/octet-stream"); e != nil {
			t.Fatal(e)
		}
	}
	if _, e = pool.Exec(ctx, "UPDATE feedback_attachments_v1 SET uploaded_at=CASE WHEN id=$1 THEN now()-interval '2 seconds' ELSE now()-interval '1 second' END WHERE id IN($1,$2)", firstID, secondID); e != nil {
		t.Fatal(e)
	}
	tx, _ = api.Begin(ctx)
	ids, e := consumers.EnqueuePendingWithin(ctx, tx, queue, 1)
	if e != nil {
		t.Fatal(e)
	}
	_ = tx.Rollback(ctx)
	var count int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_river.river_job").Scan(&count); e != nil || count != 0 {
		t.Fatalf("feedback source transaction rollback %d %v", count, e)
	}
	tx, _ = api.Begin(ctx)
	ids, e = consumers.EnqueuePendingWithin(ctx, tx, queue, 1)
	if e != nil || len(ids) != 1 {
		t.Fatalf("enqueue first source %v %v", ids, e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	scanTask := sourceTask(s.Endpoint, jobs.FeedbackScan, firstID, firstOperation)
	if ids[0] != scanTask.ID {
		t.Fatalf("source selection changed %v", ids)
	}
	// Existing roles can enqueue/work, but neither can activate the cutover.
	if _, e = worker.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", s.Endpoint); e == nil {
		t.Fatal("worker activated cutover")
	}
	if _, e = api.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", s.Endpoint); e == nil {
		t.Fatal("API activated cutover")
	}
	if _, e = pool.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", s.Endpoint); e != nil {
		t.Fatal(e)
	}
	if e = queue.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer queue.Stop(context.Background())
	waitFeedbackWorker(t, func() bool {
		view, e := queue.Get(ctx, s.Endpoint, scanTask.ID)
		return e == nil && view.State == "deferred" && view.Result["state"] == "paused"
	})
	if scanner.calls.Load() != 0 {
		t.Fatal("evidence pause ran a scan")
	}
	resume := func(id string) {
		t.Helper()
		waitFeedbackWorker(t, func() bool {
			tx, e := worker.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			e = queue.ResumeWithin(ctx, tx, s.Endpoint, id)
			if fault.Code(e) == "operations_job_in_progress" {
				_ = tx.Rollback(ctx)
				return false
			}
			if e != nil {
				_ = tx.Rollback(ctx)
				t.Fatal(e)
			}
			if e = tx.Commit(ctx); e != nil {
				t.Fatal(e)
			}
			return true
		})
	}
	paused.Store(false)
	resume(scanTask.ID)
	waitFeedbackWorker(t, func() bool {
		view, e := queue.Get(ctx, s.Endpoint, scanTask.ID)
		return e == nil && view.State == "deferred" && view.Result["state"] == "scan-pending"
	})
	var firstAttempts, secondAttempts int
	_ = pool.QueryRow(ctx, "SELECT scan_attempts FROM feedback_attachments_v1 WHERE id=$1", firstID).Scan(&firstAttempts)
	_ = pool.QueryRow(ctx, "SELECT scan_attempts FROM feedback_attachments_v1 WHERE id=$1", secondID).Scan(&secondAttempts)
	if firstAttempts != 1 || secondAttempts != 0 {
		t.Fatalf("queue retry claimed another source %d %d", firstAttempts, secondAttempts)
	}
	scanner.fail.Store(false)
	if _, e = pool.Exec(ctx, "UPDATE feedback_attachments_v1 SET lease_until=now()-interval '1 second' WHERE id=$1", firstID); e != nil {
		t.Fatal(e)
	}
	resume(scanTask.ID)
	waitFeedbackWorker(t, func() bool {
		view, e := queue.Get(ctx, s.Endpoint, scanTask.ID)
		return e == nil && view.State == "succeeded"
	})
	if scanner.calls.Load() != 2 {
		t.Fatalf("scan source attempts %d", scanner.calls.Load())
	}
	submitted, e := s.Submit(ctx, owner, encoded(t, Object{"operationId": firstOperation, "body": "queue owner feedback", "attachments": []Reference{{firstID, hash}}}))
	if e != nil {
		t.Fatal(e)
	}
	_ = submitted
	deletion := uuid.NewString()
	if _, e = s.OwnerDataBegin(ctx, owner, encoded(t, Object{"operationId": deletion}), "delete"); e != nil {
		t.Fatal(e)
	}
	paused.Store(true)
	store.loseAck = true
	tx, _ = api.Begin(ctx)
	ids, e = consumers.EnqueuePendingWithin(ctx, tx, queue, 1)
	if e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	deleteTask := sourceTask(s.Endpoint, jobs.FeedbackOwnerDeletion, firstID, deletion)
	waitFeedbackWorker(t, func() bool {
		view, e := queue.Get(ctx, s.Endpoint, deleteTask.ID)
		return e == nil && view.State == "deferred" && view.Result["state"] == "result-unknown"
	})
	unknown, e := s.OwnerDataOperation(ctx, owner, deletion)
	if e != nil || unknown["attachments"].(Object)["resultUnknown"] != 1 {
		t.Fatalf("domain unknown result %v %v", unknown, e)
	}
	if store.eraseCalls != 1 {
		t.Fatalf("DELETE count %d", store.eraseCalls)
	}
	if _, e = pool.Exec(ctx, "UPDATE account_feedback_data_items_v1 SET next_attempt_at=now()-interval '1 second' WHERE operation_id=$1", deletion); e != nil {
		t.Fatal(e)
	}
	resume(deleteTask.ID)
	waitFeedbackWorker(t, func() bool {
		view, e := queue.Get(ctx, s.Endpoint, deleteTask.ID)
		return e == nil && view.State == "succeeded"
	})
	done, e := s.OwnerDataOperation(ctx, owner, deletion)
	if e != nil || done["phase"] != "completed" || store.eraseCalls != 1 {
		t.Fatalf("same operation HEAD reconcile %v %v delete=%d", done, e, store.eraseCalls)
	}
	if scanner.calls.Load() != 2 {
		t.Fatal("owner deletion bypassed the separate scan pause")
	}
	if _, ok := store.bytes["feedback-attachments/"+secondID]; !ok {
		t.Fatal("deletion touched another draft")
	}
	var jobCount int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1 WHERE action=$1 AND operation_id=$2", jobs.FeedbackOwnerDeletion, deletion).Scan(&jobCount); e != nil || jobCount != 1 {
		t.Fatalf("original deletion job mapping replaced %d %v", jobCount, e)
	}
}
