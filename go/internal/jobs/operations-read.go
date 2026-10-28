package jobs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"slices"
	"time"
)

var operationsQueues = []string{InformationWatch, SearchRecovery, ContentPublication, AccountNotice, RetentionCleanup, MessagingRun, MessagingDelivery, AutonomyTask, AutonomyTick}

const operationColumns = `e.id::text,e.request_hash,e.error_code,e.state,j.args,j.state::text,j.created_at,j.attempted_at,j.finalized_at,j.scheduled_at,j.attempt,j.max_attempts`

type operationScanner interface{ Scan(...any) error }

func scanOperation(row operationScanner, endpoint, queue string) (map[string]any, Task, error) {
	var id, hash, state, mappingState string
	var code *string
	var raw []byte
	var created, scheduled time.Time
	var started, completed *time.Time
	var attempt, maximum int
	if err := row.Scan(&id, &hash, &code, &mappingState, &raw, &state, &created, &started, &completed, &scheduled, &attempt, &maximum); err != nil {
		return nil, Task{}, err
	}
	var task Task
	if json.Unmarshal(raw, &task) != nil || !task.valid() || task.ID != id || task.Endpoint != endpoint || task.Action != queue {
		return nil, Task{}, fault.New("operations_job_source_changed", 409)
	}
	encoded, err := json.Marshal(task)
	if err != nil {
		return nil, Task{}, err
	}
	digest := sha256.Sum256(encoded)
	if hex.EncodeToString(digest[:]) != hash {
		return nil, Task{}, fault.New("operations_job_source_changed", 409)
	}
	switch state {
	case "available", "pending", "scheduled":
		state = "created"
	case "retryable":
		state = "retry"
	case "running":
		state = "active"
	case "discarded":
		state = "failed"
	}
	if mappingState == "cancelled" {
		state = "cancelled"
	}
	stamp := func(at *time.Time) any {
		if at == nil {
			return nil
		}
		return at.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	var subject, resource any
	if v, ok := task.Payload["subjectId"].(string); ok {
		subject = v
	}
	switch queue {
	case InformationWatch, SearchRecovery, ContentPublication, AccountNotice, RetentionCleanup, MessagingRun:
		resource = task.SourceID
	}
	var failure any
	if code != nil {
		failure = *code
	}
	return map[string]any{"id": id, "queue": queue, "state": state, "createdAt": stamp(&created), "startedAt": stamp(started), "completedAt": stamp(completed), "availableAt": stamp(&scheduled), "retryCount": max(attempt-1, 0), "retryLimit": max(maximum-1, 0), "subjectId": subject, "resourceId": resource, "error": failure}, task, nil
}

func (q *Queue) operationsReady(ctx context.Context, tx pgx.Tx, endpoint, queue string) error {
	if q == nil || q.pool == nil {
		return fault.New("operations_job_backend_unavailable", 503)
	}
	if !slices.Contains(operationsQueues, queue) {
		return fault.New("operations_queue_unknown", 400)
	}
	var adopted bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 AND backend='river')`, endpoint).Scan(&adopted); err != nil {
		return err
	}
	if !adopted {
		return fault.New("operations_job_backend_not_adopted", 503)
	}
	return nil
}

// OperationWithin uses the original Galaxy UUID, not River's internal bigint.
// Locking includes the real transport row so its ACK and operator commands serialize.
func (q *Queue) OperationWithin(ctx context.Context, tx pgx.Tx, endpoint, queue, id string, lock bool) (map[string]any, Task, error) {
	if err := q.operationsReady(ctx, tx, endpoint, queue); err != nil {
		return nil, Task{}, err
	}
	if _, err := uuid.Parse(id); err != nil {
		return nil, Task{}, fault.New("operations_job_not_found", 404)
	}
	query := `SELECT ` + operationColumns + ` FROM galaxy_go_jobs.executions_v1 e JOIN galaxy_river.river_job j ON j.id=e.river_id WHERE e.endpoint=$1 AND e.action=$2 AND e.id=$3`
	if lock {
		query += ` FOR UPDATE OF e,j`
	}
	value, task, err := scanOperation(tx.QueryRow(ctx, query, endpoint, queue, id), endpoint, queue)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, Task{}, nil
	}
	return value, task, err
}

// ListOperations retains created-time/UUID ordering and the original after UUID.
// Data and diagnostic bodies are never projected into the operator directory.
func (q *Queue) ListOperations(ctx context.Context, endpoint, queue, after string, limit int) (map[string]any, error) {
	if q == nil || q.pool == nil {
		return nil, fault.New("operations_job_backend_unavailable", 503)
	}
	if limit < 1 || limit > 100 {
		return nil, fault.New("operations_page_invalid", 400)
	}
	tx, err := q.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.Background())
	if err = q.operationsReady(ctx, tx, endpoint, queue); err != nil {
		return nil, err
	}
	var anchor any
	var anchorID any
	if after != "" {
		if _, err = uuid.Parse(after); err != nil {
			return nil, fault.New("operations_page_invalid", 400)
		}
		var at time.Time
		if err = tx.QueryRow(ctx, `SELECT j.created_at FROM galaxy_go_jobs.executions_v1 e JOIN galaxy_river.river_job j ON j.id=e.river_id WHERE e.endpoint=$1 AND e.action=$2 AND e.id=$3`, endpoint, queue, after).Scan(&at); err != nil {
			return nil, err
		}
		anchor, anchorID = at, after
	}
	rows, err := tx.Query(ctx, `SELECT `+operationColumns+` FROM galaxy_go_jobs.executions_v1 e JOIN galaxy_river.river_job j ON j.id=e.river_id WHERE e.endpoint=$1 AND e.action=$2 AND ($3::timestamptz IS NULL OR (j.created_at,e.id)>($3,$4::uuid)) ORDER BY j.created_at,e.id LIMIT $5`, endpoint, queue, anchor, anchorID, limit+1)
	if err != nil {
		return nil, err
	}
	items := []any{}
	var next any
	for rows.Next() {
		value, _, err := scanOperation(rows, endpoint, queue)
		if err != nil {
			rows.Close()
			return nil, err
		}
		if len(items) == limit {
			next = items[limit-1].(map[string]any)["id"]
			break
		}
		items = append(items, value)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"items": items, "nextAfter": next}, nil
}
