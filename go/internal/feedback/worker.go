package feedback

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// WorkerConsumers has no timer or startup side effect. CanScan must supply the
// existing retirement/incident evidence gate; missing knowledge pauses scans.
// Original owner-deletion recovery continues during an evidence pause.
type WorkerConsumers struct {
	Service    *Service
	CanScan    func(context.Context) (bool, error)
	Diagnostic func(string, string, string)
}

func sourceTask(endpoint, action, id, operation string) jobs.Task {
	return jobs.Task{ID: uuid.NewSHA1(uuid.NameSpaceURL, []byte(endpoint+":"+action+":"+id+":"+operation)).String(), Endpoint: endpoint, Action: action, SourceID: id, OperationID: operation}
}

// EnqueuePendingWithin is an explicit bounded adaptation of the original
// polling selection. It does not import pg-boss rows or invent a durable plan.
func (w *WorkerConsumers) EnqueuePendingWithin(ctx context.Context, tx pgx.Tx, q *jobs.Queue, limit int) ([]string, error) {
	if limit < 1 || limit > 4 {
		return nil, fault.New("invalid_attachment_scan_limit", 400)
	}
	s := w.Service
	if s == nil {
		return nil, fault.New("feedback_service_unavailable", 503)
	}
	tasks := []jobs.Task{}
	rows, e := tx.Query(ctx, `SELECT id::text,submission_operation_id::text FROM feedback_attachments_v1 WHERE endpoint=$1 AND state IN('scan-pending','scanning') AND revoked_at IS NULL AND NOT purge_pending AND expires_at>$2 AND (lease_until IS NULL OR lease_until<=$2) ORDER BY uploaded_at,id LIMIT $3`, s.Endpoint, s.now(), limit)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id, operation string
		if e = rows.Scan(&id, &operation); e != nil {
			rows.Close()
			return nil, e
		}
		tasks = append(tasks, sourceTask(s.Endpoint, jobs.FeedbackScan, id, operation))
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return nil, e
	}
	rows, e = tx.Query(ctx, `SELECT i.attachment_id::text,i.operation_id::text FROM account_feedback_data_items_v1 i JOIN account_feedback_data_operations_v1 o ON o.operation_id=i.operation_id WHERE o.endpoint=$1 AND o.kind='delete' AND o.metadata_deleted AND o.state IN('pending','attention') AND (i.state='pending' OR i.state IN('removing','result-unknown') AND i.next_attempt_at<=$2) ORDER BY o.created_at,i.attachment_id LIMIT $3`, s.Endpoint, s.now(), limit)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id, operation string
		if e = rows.Scan(&id, &operation); e != nil {
			rows.Close()
			return nil, e
		}
		tasks = append(tasks, sourceTask(s.Endpoint, jobs.FeedbackOwnerDeletion, id, operation))
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return nil, e
	}
	out := []string{}
	for _, task := range tasks {
		id, e := q.EnqueueWithin(ctx, tx, task, time.Time{})
		if e != nil {
			return nil, e
		}
		out = append(out, id)
	}
	return out, nil
}
func (w *WorkerConsumers) Execute(ctx context.Context, t jobs.Task) (jobs.Outcome, error) {
	if w.Service == nil || t.Endpoint != w.Service.Endpoint {
		return jobs.Outcome{}, fault.New("operations_job_source_changed", 409)
	}
	if t.Action == jobs.FeedbackScan {
		return w.scan(ctx, t)
	}
	if t.Action == jobs.FeedbackOwnerDeletion {
		return w.ownerDelete(ctx, t)
	}
	return jobs.Outcome{}, fault.New("operations_queue_unknown", 400)
}
func deferred(at time.Time, state string) jobs.Outcome {
	return jobs.Outcome{Result: map[string]any{"state": state}, RetryAt: at}
}
func (w *WorkerConsumers) report(stage, id, code string) {
	if w.Diagnostic != nil {
		func() { defer func() { _ = recover() }(); w.Diagnostic(stage, id, code) }()
	}
}
func (w *WorkerConsumers) scan(ctx context.Context, t jobs.Task) (jobs.Outcome, error) {
	s := w.Service
	if w.CanScan == nil {
		return deferred(s.now().Add(time.Second), "paused"), nil
	}
	allowed, e := w.CanScan(ctx)
	if e != nil {
		code := fault.Code(e)
		if code == "internal_error" {
			code = "attachment_processing_failed"
		}
		w.report("feedback-attachment-scan", t.SourceID, code)
		return deferred(s.now().Add(time.Second), "pause-unavailable"), nil
	}
	if !allowed {
		return deferred(s.now().Add(time.Second), "paused"), nil
	}
	r, e := s.attachmentRepo()
	if e != nil {
		return jobs.Outcome{}, e
	}
	if e = r.configured(); e != nil {
		return deferred(s.now().Add(time.Second), "not-configured"), nil
	}
	lease := uuid.NewString()
	claimed := false
	var retry time.Time
	a, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (attachmentRow, error) {
		a, e := r.row(ctx, tx, t.SourceID, "UPDATE")
		if e != nil {
			return a, e
		}
		if a.operation != t.OperationID {
			return a, fault.New("operations_job_source_changed", 409)
		}
		if a.revoked != nil || a.purge || !a.expiry().After(s.now()) || a.state != "scan-pending" && a.state != "scanning" {
			return a, nil
		}
		if a.leaseUntil != nil && a.leaseUntil.After(s.now()) {
			retry = *a.leaseUntil
			return a, nil
		}
		claimed = true
		return attachmentScan(tx.QueryRow(ctx, "UPDATE feedback_attachments_v1 SET state='scanning',lease_id=$2,lease_until=$3,scan_attempts=scan_attempts+1 WHERE id=$1 RETURNING "+attachmentColumns, a.id, lease, s.now().Add(120*time.Second)))
	})
	if errors.Is(e, pgx.ErrNoRows) {
		return jobs.Outcome{Result: map[string]any{"state": "source-unavailable"}}, nil
	}
	if e != nil {
		return jobs.Outcome{}, e
	}
	if !retry.IsZero() {
		return deferred(retry, "leased"), nil
	}
	if !claimed {
		return jobs.Outcome{Result: map[string]any{"state": a.status(s.now())}}, nil
	}
	b, e := r.Store.Get(ctx, a.storageKey, a.keyID, a.size)
	if e == nil {
		e = attachments.Integrity(b, a.size, a.hash)
	}
	var scan map[string]any
	if e == nil {
		scan, e = r.Scanner.Scan(ctx, b)
	}
	if e == nil && scan["state"] != "clean" && scan["state"] != "blocked" {
		e = fault.New("attachment_scan_incomplete", 503)
	}
	if e == nil {
		var applied bool
		applied, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
			current, e := r.row(ctx, tx, a.id, "UPDATE")
			if errors.Is(e, pgx.ErrNoRows) || e == nil && (current.lease == nil || *current.lease != lease) {
				return false, nil
			}
			if e != nil {
				return false, e
			}
			blocked := current.revoked != nil || current.purge || !current.expiry().After(s.now()) || scan["state"] == "blocked"
			state := "available"
			if blocked {
				state = "blocked"
			}
			raw, e := json.Marshal(scan)
			if e != nil {
				return false, e
			}
			_, e = tx.Exec(ctx, "UPDATE feedback_attachments_v1 SET state=$2,scan_result=$3,lease_id=NULL,lease_until=NULL,last_error=NULL,purge_pending=$4 WHERE id=$1", a.id, state, raw, blocked)
			return true, e
		})
		if e == nil {
			if !applied {
				return deferred(s.now().Add(time.Second), "lease-changed"), nil
			}
			return jobs.Outcome{Result: map[string]any{"state": "scanned", "attachmentId": a.id}}, nil
		}
	}
	code := fault.Code(e)
	if code == "internal_error" {
		code = "attachment_scan_failed"
	}
	w.report("feedback-attachment-scan", a.id, code)
	recovery, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	retry = s.now().Add(60 * time.Second)
	_, e = s.Pool.Exec(recovery, "UPDATE feedback_attachments_v1 SET state='scan-pending',lease_id=NULL,lease_until=$3,last_error=$4 WHERE id=$1 AND lease_id=$2", a.id, lease, retry, code)
	if e != nil {
		return jobs.Outcome{}, e
	}
	return deferred(retry, "scan-pending"), nil
}
