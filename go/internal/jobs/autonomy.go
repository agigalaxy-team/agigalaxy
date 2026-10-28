package jobs

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Autonomy's existing singleton key deduplicates only active transport work.
// A terminal transport row may be followed by a new technical generation; its
// durable business task ID and original external operation never change.
func (q *Queue) EnqueueAutonomyWithin(ctx context.Context, tx pgx.Tx, endpoint, action string, payload map[string]any, key string, startAfter *time.Time) error {
	if endpoint == "" || key == "" || (action != AutonomyTask && action != AutonomyTick) {
		return fault.New("operations_job_payload_invalid", 400)
	}
	return q.enqueueActiveWithin(ctx, tx, endpoint, action, payload, key, startAfter)
}

func (q *Queue) enqueueActiveWithin(ctx context.Context, tx pgx.Tx, endpoint, action string, payload map[string]any, key string, startAfter *time.Time) error {
	if endpoint == "" || key == "" {
		return fault.New("operations_job_payload_invalid", 400)
	}
	var backend string
	err := tx.QueryRow(ctx, "SELECT backend FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 FOR SHARE", endpoint).Scan(&backend)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && backend != "river" {
		return fault.New("operations_jobs_not_adopted", 409)
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))", endpoint+":"+action+":"+key); err != nil {
		return err
	}
	var priorID string
	err = tx.QueryRow(ctx, "SELECT execution_id::text FROM galaxy_go_jobs.singleton_slots_v1 WHERE endpoint=$1 AND action=$2 AND slot_key=$3", endpoint, action, key).Scan(&priorID)
	active := false
	if err == nil {
		transport, err := q.GetTransportWithin(ctx, tx, endpoint, priorID)
		if err != nil {
			return err
		}
		switch string(transport.State) {
		case "completed", "cancelled", "discarded":
		default:
			active = true
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	id := priorID
	if !active {
		id = uuid.NewString()
	}
	sourceID := id
	if action == AutonomyTask {
		sourceID, _ = payload["taskId"].(string)
	}
	if action == InformationWatch {
		sourceID, _ = payload["watchId"].(string)
	}
	task := Task{ID: id, Endpoint: endpoint, Action: action, SourceID: sourceID, OperationID: id, Payload: payload}
	available := time.Time{}
	if startAfter != nil {
		available = *startAfter
	}
	if _, err = q.EnqueueWithin(ctx, tx, task, available); err != nil {
		return err
	}
	if active {
		return nil
	}
	_, err = tx.Exec(ctx, `INSERT INTO galaxy_go_jobs.singleton_slots_v1(endpoint,action,slot_key,execution_id,updated_at) VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(endpoint,action,slot_key) DO UPDATE SET execution_id=EXCLUDED.execution_id,updated_at=EXCLUDED.updated_at`, endpoint, action, key, id)
	return err
}
