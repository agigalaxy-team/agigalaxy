package evidence

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"time"
)

// RecoverExpired performs only the original two bounded maintenance updates.
// It issues no upstream request and enqueues no replacement business operation.
// A scheduler may call it explicitly after its separately coordinated takeover.
func (s *Service) RecoverExpired(ctx context.Context) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("evidence_service_unavailable", 503)
	}
	source, e := s.source()
	if e != nil {
		return nil, e
	}
	policy := s.budgetPolicy()
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		now := time.Unix(s.now(), 0)
		if p := policy; p != nil {
			if e = p.Validate(); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(734912310)`); e != nil {
				return nil, e
			}
			var active int64
			if e = tx.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE state='running' AND locked_until>$1`, now).Scan(&active); e != nil {
				return nil, e
			}
			if active >= p.MaxActiveJobsGlobal {
				return Object{"budgetLimited": true, "exhausted": 0, "unavailable": 0}, nil
			}
		}
		rows, e := tx.Query(ctx, `WITH candidates AS(SELECT id FROM jobs WHERE kind=$2 AND state='running' AND locked_until<=$1 AND attempts>=5 ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE jobs j SET state='failed',lease_id=NULL FROM candidates c WHERE j.id=c.id RETURNING j.id::text,j.payload`, now, source.JobKind())
		if e != nil {
			return nil, e
		}
		exhausted := []Object{}
		for rows.Next() {
			var id string
			var raw []byte
			if e = rows.Scan(&id, &raw); e != nil {
				rows.Close()
				return nil, e
			}
			var p Object
			if e = json.Unmarshal(raw, &p); e != nil {
				rows.Close()
				return nil, e
			}
			exhausted = append(exhausted, Object{"id": id, "evidenceId": p["evidenceId"]})
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		for _, j := range exhausted {
			if e = s.auditTransition(ctx, tx, str(j, "evidenceId"), str(j, "id"), source, "verification.exhausted"); e != nil {
				return nil, e
			}
		}
		rows, e = tx.Query(ctx, `WITH candidates AS(SELECT e.id FROM evidence_submissions e WHERE e.state='pending' AND EXISTS(SELECT 1 FROM jobs j WHERE j.kind=$1 AND j.state='failed' AND j.payload->>'evidenceId'=e.id::text) ORDER BY e.id LIMIT 100 FOR UPDATE OF e SKIP LOCKED) UPDATE evidence_submissions e SET state='unavailable' FROM candidates c WHERE e.id=c.id RETURNING e.id::text`, source.JobKind())
		if e != nil {
			return nil, e
		}
		unavailable := []string{}
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return nil, e
			}
			unavailable = append(unavailable, id)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		for _, id := range unavailable {
			if e = s.auditTransition(ctx, tx, id, "", source, "evidence.unavailable"); e != nil {
				return nil, e
			}
		}
		return Object{"exhausted": len(exhausted), "unavailable": len(unavailable)}, nil
	})
}
