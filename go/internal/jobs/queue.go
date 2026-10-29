// Package jobs supplies River transport for explicitly registered Galaxy
// consumers. Domain plans, operations, leases and external effects stay in the
// domain ledger; a queue retry never creates a replacement business operation.
package jobs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
)

const Schema = "galaxy_river"
const FeedbackScan = "feedback-scan"
const FeedbackOwnerDeletion = "feedback-owner-deletion"
const ContentPublication = "content-publication"
const AccountNotice = "account-notice"
const MessagingRun = "messaging-run"
const MessagingDelivery = "messaging-delivery"
const EvidenceVerifyGithub = "verify-github"
const EvidenceVerifyGithubV2 = "verify-github-v2"
const AutonomyTask = "autonomy-task"
const AutonomyTick = "autonomy-tick"
const SearchRecovery = "search-recovery"
const InformationWatch = "information-watch"
const RetentionCleanup = "retention-cleanup"

type Task struct {
	ID              string         `json:"id"`
	Endpoint        string         `json:"endpoint"`
	Action          string         `json:"action"`
	SourceID        string         `json:"sourceId"`
	OperationID     string         `json:"operationId,omitempty"`
	PlanVersion     int64          `json:"planVersion,omitempty"`
	Payload         map[string]any `json:"payload,omitempty"`
	Generation      int64          `json:"generation,omitempty"`
	RecoveryAttempt int            `json:"recoveryAttempt,omitempty"`
}

func (Task) Kind() string { return "galaxy_feedback_source_v1" }
func (t Task) valid() bool {
	_, e := uuid.Parse(t.ID)
	_, source := uuid.Parse(t.SourceID)
	_, operation := uuid.Parse(t.OperationID)
	if e != nil || source != nil || operation != nil || t.Endpoint == "" || !knownAction(t.Action) {
		return false
	}
	if t.Action == SearchRecovery {
		return t.Generation >= 1 && t.Generation <= 2147483647 && t.RecoveryAttempt >= 1 && t.RecoveryAttempt <= 3 && t.PlanVersion == 0 && len(t.Payload) == 0
	}
	if t.Generation != 0 || t.RecoveryAttempt != 0 {
		return false
	}
	if t.Action == InformationWatch {
		return t.PlanVersion == 0 && len(t.Payload) == 4 && t.Payload["watchId"] == t.SourceID && watchSubject.MatchString(watchString(t.Payload["subjectId"])) && watchInteger(t.Payload["revision"], 1) && watchInteger(t.Payload["checkRevision"], 0)
	}
	if t.Action == MessagingRun {
		return t.PlanVersion >= 1 && t.PlanVersion <= 2147483646 && len(t.Payload) == 0
	}
	if t.Action == AutonomyTask {
		return t.PlanVersion == 0 && validAutonomyPayload(t.Payload, t.SourceID)
	}
	if t.Action == AutonomyTick {
		return len(t.Payload) == 0 && t.PlanVersion == 0 && t.SourceID == t.ID
	}
	if t.Action == RetentionCleanup {
		return t.SourceID == t.OperationID && t.PlanVersion == 0 && len(t.Payload) == 0
	}
	return t.PlanVersion == 0 && len(t.Payload) == 0
}

func knownAction(action string) bool {
	switch action {
	case FeedbackScan, FeedbackOwnerDeletion, ContentPublication, AccountNotice, MessagingRun, MessagingDelivery, EvidenceVerifyGithub, EvidenceVerifyGithubV2, AutonomyTask, AutonomyTick, SearchRecovery, InformationWatch, RetentionCleanup:
		return true
	}
	return false
}

var watchSubject = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)

func watchString(v any) string { s, _ := v.(string); return s }
func watchInteger(v any, min int64) bool {
	switch n := v.(type) {
	case int:
		return int64(n) >= min && n <= 2147483647
	case int64:
		return n >= min && n <= 2147483647
	case float64:
		return n >= float64(min) && n <= 2147483647 && math.Trunc(n) == n
	case json.Number:
		f, e := n.Float64()
		return e == nil && f >= float64(min) && f <= 2147483647 && math.Trunc(f) == f
	}
	return false
}

type Outcome struct {
	Result  map[string]any
	RetryAt time.Time
}
type Execute func(context.Context, Task) (Outcome, error)
type Queue struct {
	pool    *pgxpool.Pool
	client  *river.Client[pgx.Tx]
	execute Execute
}
type Worker struct {
	river.WorkerDefaults[Task]
	queue *Queue
}

func New(pool *pgxpool.Pool, execute Execute, logger ...*slog.Logger) (*Queue, error) {
	return NewWithQueues(pool, execute, map[string]int{FeedbackScan: 1, FeedbackOwnerDeletion: 1}, logger...)
}

// NewWithQueues keeps each process on its own registered consumers. Adding a
// publisher does not make the evidence worker claim publication jobs.
func NewWithQueues(pool *pgxpool.Pool, execute Execute, queues map[string]int, logger ...*slog.Logger) (*Queue, error) {
	q := &Queue{pool: pool, execute: execute}
	log := slog.Default()
	if len(logger) > 0 && logger[0] != nil {
		log = logger[0]
	}
	config := &river.Config{Schema: Schema, Logger: log}
	if execute != nil {
		workers := river.NewWorkers()
		river.AddWorker(workers, &Worker{queue: q})
		config.Workers = workers
		config.Queues = map[string]river.QueueConfig{}
		for action, workers := range queues {
			if workers < 1 || workers > 100 || !knownAction(action) {
				return nil, fault.New("operations_job_consumer_invalid", 400)
			}
			config.Queues[action] = river.QueueConfig{MaxWorkers: workers}
		}
		if len(config.Queues) == 0 {
			return nil, fault.New("operations_job_consumer_unavailable", 503)
		}
		config.JobTimeout = 120 * time.Second
		config.RescueStuckJobsAfter = 125 * time.Second
	}
	client, e := river.NewClient(riverpgxv5.New(pool), config)
	if e != nil {
		return nil, e
	}
	q.client = client
	return q, nil
}

// Start is explicit. A missing/disabled administrative cutover gate prevents
// all domain effects even if a caller starts this transport prematurely.
func (q *Queue) Start(ctx context.Context) error {
	if q.execute == nil {
		return fault.New("operations_job_consumer_unavailable", 503)
	}
	return q.client.Start(ctx)
}
func (q *Queue) Stop(ctx context.Context) error { return q.client.Stop(ctx) }
func (q *Queue) EnqueueWithin(ctx context.Context, tx pgx.Tx, t Task, available time.Time) (string, error) {
	if !t.valid() {
		return "", fault.New("operations_job_payload_invalid", 400)
	}
	raw, e := json.Marshal(t)
	if e != nil {
		return "", e
	}
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))", t.Endpoint+":"+t.ID); e != nil {
		return "", e
	}
	var old, oldHash string
	e = tx.QueryRow(ctx, "SELECT id::text,request_hash FROM galaxy_go_jobs.executions_v1 WHERE id=$1", t.ID).Scan(&old, &oldHash)
	if e == nil {
		if hash != oldHash {
			return "", fault.New("operations_job_operation_conflict", 409)
		}
		return old, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return "", e
	}
	// Four retries transport the exact same source identity. Source leases and
	// owner deletion attempt caps remain authoritative for external effects.
	inserted, e := q.client.InsertTx(ctx, tx, t, &river.InsertOpts{Queue: t.Action, ScheduledAt: available, MaxAttempts: 5})
	if e != nil {
		return "", e
	}
	var operation any
	if t.OperationID != "" {
		operation = t.OperationID
	}
	_, e = tx.Exec(ctx, `INSERT INTO galaxy_go_jobs.executions_v1(id,endpoint,action,source_id,operation_id,request_hash,river_id) VALUES($1,$2,$3,$4,$5,$6,$7)`, t.ID, t.Endpoint, t.Action, t.SourceID, operation, hash, inserted.Job.ID)
	return t.ID, e
}

type View struct {
	ID, Endpoint, Action, SourceID string
	OperationID                    *string
	State                          string
	Result                         map[string]any
	ErrorCode                      *string
	CreatedAt, UpdatedAt           time.Time
}

func (q *Queue) Get(ctx context.Context, endpoint, id string) (View, error) {
	return q.get(ctx, q.pool, endpoint, id)
}
func (q *Queue) GetWithin(ctx context.Context, tx pgx.Tx, endpoint, id string) (View, error) {
	return q.get(ctx, tx, endpoint, id)
}
func (q *Queue) GetTransportWithin(ctx context.Context, tx pgx.Tx, endpoint, id string) (*rivertype.JobRow, error) {
	var riverID int64
	if e := tx.QueryRow(ctx, "SELECT river_id FROM galaxy_go_jobs.executions_v1 WHERE endpoint=$1 AND id=$2", endpoint, id).Scan(&riverID); e != nil {
		return nil, e
	}
	return q.client.JobGetTx(ctx, tx, riverID)
}
func (q *Queue) get(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, endpoint, id string) (View, error) {
	var r View
	e := db.QueryRow(ctx, `SELECT id::text,endpoint,action,source_id::text,operation_id::text,state,result,error_code,created_at,updated_at FROM galaxy_go_jobs.executions_v1 WHERE endpoint=$1 AND id=$2`, endpoint, id).Scan(&r.ID, &r.Endpoint, &r.Action, &r.SourceID, &r.OperationID, &r.State, &r.Result, &r.ErrorCode, &r.CreatedAt, &r.UpdatedAt)
	return r, e
}

// The caller must cancel its domain ledger in this same transaction. River
// cancellation alone cannot undo an external action or establish its outcome.
func (q *Queue) CancelWithin(ctx context.Context, tx pgx.Tx, endpoint, id string) error {
	var riverID int64
	var state string
	if e := tx.QueryRow(ctx, "SELECT river_id,state FROM galaxy_go_jobs.executions_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE", endpoint, id).Scan(&riverID, &state); e != nil {
		return e
	}
	if state == "succeeded" {
		return fault.New("operations_job_already_completed", 409)
	}
	if state == "cancelled" {
		return nil
	}
	if _, e := q.client.JobCancelTx(ctx, tx, riverID); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, "UPDATE galaxy_go_jobs.executions_v1 SET state='cancelled',updated_at=now() WHERE id=$1", id)
	return e
}

// ResumeWithin preserves both UUID and River row. A caller must separately own
// the domain's retry authority; this is not a public unauthenticated endpoint.
func (q *Queue) ResumeWithin(ctx context.Context, tx pgx.Tx, endpoint, id string) error {
	var riverID int64
	var state string
	e := tx.QueryRow(ctx, "SELECT river_id,state FROM galaxy_go_jobs.executions_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE", endpoint, id).Scan(&riverID, &state)
	if e != nil {
		return e
	}
	if state == "succeeded" || state == "cancelled" {
		return fault.New("operations_job_not_failed", 409)
	}
	// Domain result persistence precedes River's own ACK. Serialize with that
	// ACK; retrying a still-running row is a River no-op and would lose the
	// caller's resume when the original ACK later writes its deferred time.
	var transportState string
	if e = tx.QueryRow(ctx, "SELECT state::text FROM galaxy_river.river_job WHERE id=$1 FOR UPDATE", riverID).Scan(&transportState); e != nil {
		return e
	}
	if transportState == "running" {
		return fault.New("operations_job_in_progress", 409)
	}
	if _, e = q.client.JobRetryTx(ctx, tx, riverID); e != nil {
		return e
	}
	_, e = tx.Exec(ctx, "UPDATE galaxy_go_jobs.executions_v1 SET state='queued',error_code=NULL,updated_at=now() WHERE id=$1", id)
	return e
}
func (w *Worker) Work(ctx context.Context, job *river.Job[Task]) error {
	q := w.queue
	t := job.Args
	if !t.valid() {
		return w.cancelSource(ctx, job.ID, "operations_job_payload_invalid")
	}
	raw, e := json.Marshal(t)
	if e != nil {
		return e
	}
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	var backend string
	e = q.pool.QueryRow(ctx, "SELECT backend FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1", t.Endpoint).Scan(&backend)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && backend != "river" {
		return river.JobSnooze(time.Second)
	}
	if e != nil {
		return e
	}
	tag, e := q.pool.Exec(ctx, "UPDATE galaxy_go_jobs.executions_v1 SET state='running',updated_at=now() WHERE id=$1 AND endpoint=$2 AND river_id=$3 AND request_hash=$4 AND state NOT IN ('succeeded','cancelled')", t.ID, t.Endpoint, job.ID, hash)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		var state string
		e = q.pool.QueryRow(ctx, "SELECT state FROM galaxy_go_jobs.executions_v1 WHERE id=$1 AND endpoint=$2 AND river_id=$3 AND request_hash=$4", t.ID, t.Endpoint, job.ID, hash).Scan(&state)
		if e == nil && state == "succeeded" {
			return nil
		}
		if e == nil && state == "cancelled" {
			return river.JobCancel(fault.New("operations_job_cancelled", 409))
		}
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		return w.cancelSource(ctx, job.ID, "operations_job_source_changed")
	}
	outcome, e := q.execute(ctx, t)
	if e != nil {
		code := fault.Code(e)
		if code == "internal_error" {
			code = "operations_job_failed"
		}
		recovery, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		_, _ = q.pool.Exec(recovery, "UPDATE galaxy_go_jobs.executions_v1 SET state='failed',error_code=$2,updated_at=now() WHERE id=$1 AND state<>'cancelled'", t.ID, code)
		cancel()
		return fault.New(code, 503)
	}
	result, e := json.Marshal(outcome.Result)
	if e != nil {
		return e
	}
	state := "succeeded"
	if !outcome.RetryAt.IsZero() {
		state = "deferred"
	}
	_, e = q.pool.Exec(ctx, "UPDATE galaxy_go_jobs.executions_v1 SET state=$2,result=$3,error_code=NULL,updated_at=now() WHERE id=$1 AND state<>'cancelled'", t.ID, state, result)
	if e != nil {
		return e
	}
	if state == "deferred" {
		delay := time.Until(outcome.RetryAt)
		if delay < time.Millisecond {
			delay = time.Millisecond
		}
		return river.JobSnooze(delay)
	}
	return nil
}

func (w *Worker) cancelSource(ctx context.Context, riverID int64, code string) error {
	_, e := w.queue.pool.Exec(ctx, "UPDATE galaxy_go_jobs.executions_v1 SET state='failed',error_code=$2,updated_at=now() WHERE river_id=$1 AND state<>'cancelled'", riverID, code)
	if e != nil {
		return e
	}
	return river.JobCancel(fault.New(code, 409))
}
