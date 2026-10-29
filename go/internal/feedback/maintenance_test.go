package feedback

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/feedbackfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The real producer inserts first; the injected failure then proves the source
// transaction rolls back the job and its mapping, rather than skipping enqueue.
type failAfterTaskProducer struct {
	inner       TaskProducer
	scan, owner bool
}

func (p failAfterTaskProducer) AttachmentScanWithin(ctx context.Context, tx pgx.Tx, endpoint, id, operation string) error {
	if e := p.inner.AttachmentScanWithin(ctx, tx, endpoint, id, operation); e != nil {
		return e
	}
	if p.scan {
		return fault.New("controlled_producer_failure", 503)
	}
	return nil
}
func (p failAfterTaskProducer) OwnerDeletionWithin(ctx context.Context, tx pgx.Tx, endpoint, operation, id string) error {
	if e := p.inner.OwnerDeletionWithin(ctx, tx, endpoint, operation, id); e != nil {
		return e
	}
	if p.owner {
		return fault.New("controlled_producer_failure", 503)
	}
	return nil
}

func TestFeedbackRealTransactionTaskProduction(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	fixture := feedbackfixture.Create(t, pool, "api", "worker")
	var e error
	api := ownerRolePool(t, dsn, "galaxy_api")
	worker := ownerRolePool(t, dsn, "galaxy_evidence_worker")
	store := &ownerStore{memoryAttachmentStore: memoryAttachmentStore{bytes: map[string][]byte{}}}
	repo := &AttachmentRepository{Endpoint: fixture.Endpoint, Store: store, Scanner: &fixtureScanner{}}
	service := &Service{Pool: api, Endpoint: fixture.Endpoint, Authority: &fixtureAuthority{}, Attachments: repo}
	owner := fixture.Accounts[0]
	payload := []byte("producer transaction bytes")
	hash := attachments.Digest(payload)
	prepare := func(id, operation string) {
		t.Helper()
		if _, e := service.AttachmentPrepare(ctx, owner, encoded(t, Object{"operationId": operation, "attachmentId": id, "name": "producer.txt", "mediaType": "text/plain", "size": len(payload), "sha256": hash})); e != nil {
			t.Fatal(e)
		}
	}
	upload := func(id string) (Object, error) {
		return service.AttachmentUpload(ctx, owner, id, io.NopCloser(bytes.NewReader(payload)), int64(len(payload)), "application/octet-stream")
	}
	// Legacy/non-River operation has no dependency on River schemas at all.
	orphan, orphanOperation := uuid.NewString(), uuid.NewString()
	prepare(orphan, orphanOperation)
	if _, e = upload(orphan); e != nil {
		t.Fatal(e)
	}
	if _, e = service.AttachmentTarget(ctx, owner, encoded(t, Object{"operationId": orphanOperation, "attachmentId": orphan}), true); e != nil {
		t.Fatal(e)
	}
	var riverMissing bool
	if e = pool.QueryRow(ctx, "SELECT to_regclass('galaxy_river.river_job') IS NULL").Scan(&riverMissing); e != nil || !riverMissing {
		t.Fatalf("nil task port touched River %v %v", riverMissing, e)
	}
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
	workerService := *service
	workerService.Pool = worker
	consumers := &WorkerConsumers{Service: &workerService, CanScan: func(context.Context) (bool, error) { return true, nil }}
	queue, e := jobs.New(worker, consumers.Execute)
	if e != nil {
		t.Fatal(e)
	}
	producer := &RiverTaskProducer{Queue: queue}
	service.Tasks = failAfterTaskProducer{inner: producer, scan: true}
	id, submission := uuid.NewString(), uuid.NewString()
	prepare(id, submission)
	_, e = upload(id)
	code(t, e, "controlled_producer_failure")
	var mappings, native int
	_ = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1").Scan(&mappings)
	_ = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_river.river_job").Scan(&native)
	if mappings != 0 || native != 0 {
		t.Fatalf("producer rollback left tasks mapping=%d native=%d", mappings, native)
	}
	receipt, e := service.AttachmentTarget(ctx, owner, encoded(t, Object{"attachmentId": id, "operationId": submission}), false)
	if e != nil || receipt["state"] != "uploading" || receipt["uploadRetryable"] != true {
		t.Fatalf("stored bytes with rolled-back completion must remain unknown %v %v", receipt, e)
	}
	service.Tasks = producer
	if _, e = upload(id); e != nil {
		t.Fatal(e)
	}
	scanTask := sourceTask(service.Endpoint, jobs.FeedbackScan, id, submission)
	if view, e := queue.Get(ctx, service.Endpoint, scanTask.ID); e != nil || view.State != "queued" {
		t.Fatalf("real upload producer missing %v %v", view, e)
	}
	if _, e = pool.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", service.Endpoint); e != nil {
		t.Fatal(e)
	}
	if e = queue.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer queue.Stop(context.Background())
	waitFeedbackWorker(t, func() bool {
		view, e := queue.Get(ctx, service.Endpoint, scanTask.ID)
		return e == nil && view.State == "succeeded"
	})
	feedback, e := service.Submit(ctx, owner, encoded(t, Object{"operationId": submission, "body": "feedback produced scan work", "attachments": []Reference{{id, hash}}}))
	if e != nil {
		t.Fatal(e)
	}
	feedbackID := feedback["feedbackId"].(string)
	deletion := uuid.NewString()
	service.Tasks = failAfterTaskProducer{inner: producer, owner: true}
	_, e = service.OwnerDataBegin(ctx, owner, encoded(t, Object{"operationId": deletion}), "delete")
	code(t, e, "controlled_producer_failure")
	operation, e := service.OwnerDataOperation(ctx, owner, deletion)
	if e != nil || operation["state"] != "not-recorded" {
		t.Fatalf("producer failure recorded deletion %v %v", operation, e)
	}
	var title *string
	var deleted *time.Time
	if e = pool.QueryRow(ctx, "SELECT title,owner_deleted_at FROM operations_feedback_v1 WHERE id=$1", feedbackID).Scan(&title, &deleted); e != nil || title == nil || deleted != nil {
		t.Fatalf("producer failure committed metadata erasure %v %v", title, e)
	}
	var deleteJobs int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1 WHERE action=$1", jobs.FeedbackOwnerDeletion).Scan(&deleteJobs); e != nil || deleteJobs != 0 || store.eraseCalls != 0 {
		t.Fatalf("producer failure escaped source transaction jobs=%d erases=%d %v", deleteJobs, store.eraseCalls, e)
	}
	// The real owner-intent transaction now commits the stable source job. No
	// test-side/manual enqueue is involved in either scan or owner deletion.
	service.Tasks = producer
	store.loseAck = true
	if _, e = service.OwnerDataBegin(ctx, owner, encoded(t, Object{"operationId": deletion}), "delete"); e != nil {
		t.Fatal(e)
	}
	deleteTask := sourceTask(service.Endpoint, jobs.FeedbackOwnerDeletion, id, deletion)
	waitFeedbackWorker(t, func() bool {
		view, e := queue.Get(ctx, service.Endpoint, deleteTask.ID)
		return e == nil && view.State == "deferred" && view.Result["state"] == "result-unknown"
	})
	if store.eraseCalls != 1 {
		t.Fatalf("real produced deletion calls %d", store.eraseCalls)
	}
	var originalRiverID int64
	if e = pool.QueryRow(ctx, "SELECT river_id FROM galaxy_go_jobs.executions_v1 WHERE id=$1", deleteTask.ID).Scan(&originalRiverID); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, "UPDATE account_feedback_data_items_v1 SET next_attempt_at=now()-interval '1 second' WHERE operation_id=$1", deletion); e != nil {
		t.Fatal(e)
	}
	waitFeedbackWorker(t, func() bool {
		tx, e := worker.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		e = queue.ResumeWithin(ctx, tx, service.Endpoint, deleteTask.ID)
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
	waitFeedbackWorker(t, func() bool {
		view, e := queue.Get(ctx, service.Endpoint, deleteTask.ID)
		return e == nil && view.State == "succeeded"
	})
	replay, e := service.OwnerDataBegin(ctx, owner, encoded(t, Object{"operationId": deletion}), "delete")
	if e != nil || replay["replayed"] != true || replay["phase"] != "completed" || store.eraseCalls != 1 {
		t.Fatalf("same original produced operation recovery %v %v", replay, e)
	}
	var afterRiverID int64
	if e = pool.QueryRow(ctx, "SELECT river_id FROM galaxy_go_jobs.executions_v1 WHERE id=$1", deleteTask.ID).Scan(&afterRiverID); e != nil || afterRiverID != originalRiverID {
		t.Fatalf("recovery replaced transport identity %d %d %v", originalRiverID, afterRiverID, e)
	}
	if _, ok := store.bytes["feedback-attachments/"+orphan]; !ok {
		t.Fatal("owner operation erased another revoked/unbound source")
	}
	var purged *time.Time
	if e = pool.QueryRow(ctx, "SELECT purged_at FROM feedback_attachments_v1 WHERE id=$1", orphan).Scan(&purged); e != nil || purged != nil {
		t.Fatalf("revocation introduced automatic physical cleanup %v %v", purged, e)
	}
}
