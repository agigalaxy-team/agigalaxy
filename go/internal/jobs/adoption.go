package jobs

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"sort"
	"time"
)

// AdoptPendingWithin is an explicit administrative handoff of selected old
// unclaimed rows. Call only after stopping the old producers/consumers. The old
// Node processes do not read the Go gate; this function cannot attest they stop.
// Caller owns commit/rollback and the maintenance-role connection. It neither
// enables the gate, starts River, migrates schema nor clears any old queue.
func (q *Queue) AdoptPendingWithin(ctx context.Context, tx pgx.Tx, endpoint string, ids []string, verify AdoptionSourceVerifier) (map[string]any, error) {
	if q == nil || endpoint == "" || verify == nil || len(ids) < 1 || len(ids) > 100 {
		return nil, adoptionInvalid()
	}
	selected := make([]string, len(ids))
	for i, id := range ids {
		parsed, e := uuid.Parse(id)
		if e != nil {
			return nil, adoptionInvalid()
		}
		selected[i] = parsed.String()
	}
	sort.Strings(selected)
	for i, id := range selected {
		if i > 0 && id == selected[i-1] {
			return nil, adoptionInvalid()
		}
	}
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))", endpoint+":legacy-adoption"); e != nil {
		return nil, e
	}
	var backend string
	e := tx.QueryRow(ctx, "SELECT backend FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 FOR UPDATE", endpoint).Scan(&backend)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	if e == nil && backend != "disabled" {
		return nil, fault.New("operations_job_adoption_requires_disabled_backend", 409)
	}
	items := []any{}
	for _, id := range selected {
		var raw []byte
		if e = tx.QueryRow(ctx, "SELECT to_jsonb(j) FROM galaxy_jobs.job j WHERE id=$1 FOR UPDATE", id).Scan(&raw); errors.Is(e, pgx.ErrNoRows) {
			return nil, fault.New("operations_job_not_found", 404)
		} else if e != nil {
			return nil, e
		}
		var row map[string]any
		if e = protocol.Decode(raw, &row); e != nil {
			return nil, e
		}
		data, _ := row["data"].(map[string]any)
		legacy := LegacyPendingJob{ID: id, Queue: adoptionText(row["name"]), SingletonKey: adoptionText(row["singleton_key"]), Data: data}
		task, key, e := ParseLegacyPendingTask(endpoint, legacy)
		if e != nil {
			return nil, e
		}
		existing, lookup := q.GetWithin(ctx, tx, endpoint, id)
		if lookup == nil {
			if existing.Action != task.Action || existing.SourceID != task.SourceID || existing.OperationID == nil || *existing.OperationID != task.OperationID || row["state"] != "cancelled" {
				return nil, fault.New("operations_job_adoption_conflict", 409)
			}
			if _, e = q.EnqueueWithin(ctx, tx, task, time.Time{}); e != nil {
				return nil, e
			}
			items = append(items, map[string]any{"id": id, "queue": task.Action, "sourceId": task.SourceID, "replayed": true})
			continue
		}
		if !errors.Is(lookup, pgx.ErrNoRows) {
			return nil, lookup
		}
		retry, hasRetry := row["retry_count"]
		if row["state"] != "created" || !hasRetry || !watchInteger(retry, 0) || adoptionInteger(retry) != 0 || row["started_on"] != nil || row["completed_on"] != nil || row["output"] != nil {
			return nil, fault.New("operations_job_adoption_not_unclaimed", 409)
		}
		created, e := time.Parse(time.RFC3339Nano, adoptionText(row["created_on"]))
		if e != nil {
			return nil, adoptionInvalid()
		}
		available, e := time.Parse(time.RFC3339Nano, adoptionText(row["start_after"]))
		if e != nil {
			return nil, adoptionInvalid()
		}
		retries, ok := row["retry_limit"]
		if !ok || !watchInteger(retries, 0) || adoptionInteger(retries) > 32766 {
			return nil, adoptionInvalid()
		}
		if e = verify(ctx, tx, endpoint, legacy, task); e != nil {
			return nil, e
		}
		if key != "" {
			if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))", endpoint+":"+task.Action+":"+key); e != nil {
				return nil, e
			}
			var prior string
			e = tx.QueryRow(ctx, "SELECT execution_id::text FROM galaxy_go_jobs.singleton_slots_v1 WHERE endpoint=$1 AND action=$2 AND slot_key=$3 FOR UPDATE", endpoint, task.Action, key).Scan(&prior)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return nil, e
			}
			if e == nil && prior != id {
				return nil, fault.New("operations_job_adoption_conflict", 409)
			}
		}
		if _, e = q.EnqueueWithin(ctx, tx, task, available); e != nil {
			return nil, e
		}
		// Preserve original directory chronology and retry allowance. River's row ID
		// remains private and all domain leases/counters remain untouched.
		if _, e = tx.Exec(ctx, `UPDATE galaxy_river.river_job SET created_at=$3,max_attempts=$4 WHERE id=(SELECT river_id FROM galaxy_go_jobs.executions_v1 WHERE endpoint=$1 AND id=$2)`, endpoint, id, created, int(adoptionInteger(retries))+1); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE galaxy_go_jobs.executions_v1 SET created_at=$3 WHERE endpoint=$1 AND id=$2", endpoint, id, created); e != nil {
			return nil, e
		}
		if key != "" {
			if _, e = tx.Exec(ctx, `INSERT INTO galaxy_go_jobs.singleton_slots_v1(endpoint,action,slot_key,execution_id) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint,action,slot_key) DO NOTHING`, endpoint, task.Action, key, id); e != nil {
				return nil, e
			}
		}
		tag, e := tx.Exec(ctx, "UPDATE galaxy_jobs.job SET state='cancelled',completed_on=now() WHERE id=$1 AND state='created' AND retry_count=0 AND started_on IS NULL", id)
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() != 1 {
			return nil, fault.New("operations_job_adoption_conflict", 409)
		}
		items = append(items, map[string]any{"id": id, "queue": task.Action, "sourceId": task.SourceID, "replayed": false})
	}
	return map[string]any{"items": items, "gateChanged": false, "oldConsumersStoppedVerified": false, "externalEffectsDispatched": false}, nil
}
