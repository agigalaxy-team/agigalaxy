package civ2

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

type jobRow struct {
	ID, State, Lease string
	Attempts         int64
	Payload          Object
	Available        time.Time
	Locked           *time.Time
}

func job(ctx context.Context, tx pgx.Tx, id string) (*jobRow, error) {
	var r jobRow
	var lease *string
	var raw []byte
	e := tx.QueryRow(ctx, `SELECT id::text,state,lease_id::text,attempts,payload,available_at,locked_until FROM jobs WHERE id=$1 AND kind=$2 FOR UPDATE`, id, JobKind).Scan(&r.ID, &r.State, &lease, &r.Attempts, &raw, &r.Available, &r.Locked)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if lease != nil {
		r.Lease = *lease
	}
	if e = json.Unmarshal(raw, &r.Payload); e != nil {
		return nil, e
	}
	return &r, nil
}

// ProcessJob reads only this original business job. River may schedule another
// transport wake-up; it cannot reset business attempts or create another ID.
func (s *Service) ProcessJob(ctx context.Context, id string, verify evidence.Verify) (evidence.JobOutcome, error) {
	if s.Pool == nil {
		return evidence.JobOutcome{}, fault.New("ci_service_unavailable", 503)
	}
	policy := s.budgetPolicy()
	var claimed *jobRow
	var due time.Time
	initial, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		at := time.Unix(s.now(), 0)
		if p := policy; p != nil {
			if e := p.Validate(); e != nil {
				return nil, e
			}
			if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(734912310)`); e != nil {
				return nil, e
			}
			var active int64
			if e := tx.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE state='running' AND locked_until>$1`, at).Scan(&active); e != nil {
				return nil, e
			}
			if active >= p.MaxActiveJobsGlobal {
				return Object{"processed": false, "budgetLimited": true}, nil
			}
		}
		j, e := job(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		if j == nil {
			return Object{"processed": false}, nil
		}
		expired := j.State == "running" && j.Locked != nil && !j.Locked.After(at)
		if j.Attempts >= 5 && (j.State == "pending" || expired) {
			if _, e = tx.Exec(ctx, `UPDATE jobs SET state='failed',lease_id=NULL,locked_until=NULL WHERE id=$1`, id); e != nil {
				return nil, e
			}
			j.State = "failed"
		}
		if j.State == "failed" {
			if _, e = tx.Exec(ctx, `UPDATE ci_requests_v2 SET state='unavailable' WHERE id=$1 AND state='pending'`, j.Payload["ciRequestId"]); e != nil {
				return nil, e
			}
			return Object{"processed": false}, nil
		}
		if j.Attempts >= 5 || !(j.State == "pending" && !j.Available.After(at) || expired) {
			if j.State == "pending" && j.Available.After(at) {
				due = j.Available
			}
			return Object{"processed": false}, nil
		}
		limit := int64(5)
		if policy != nil {
			limit = policy.MaxActiveJobsPerSubject
		}
		var active int64
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM jobs other LEFT JOIN ci_requests_v2 own ON own.id::text=other.payload->>'ciRequestId' LEFT JOIN evidence_submissions legacy ON legacy.id::text=other.payload->>'evidenceId' WHERE (own.subject_id=(SELECT subject_id FROM ci_requests_v2 WHERE id=$1) OR legacy.subject_id=(SELECT subject_id FROM ci_requests_v2 WHERE id=$1) OR other.kind='builder-probe' AND other.payload->>'subjectId'=(SELECT subject_id FROM ci_requests_v2 WHERE id=$1)) AND other.state='running' AND other.locked_until>$2`, j.Payload["ciRequestId"], at).Scan(&active); e != nil {
			return nil, e
		}
		if active >= limit {
			return Object{"processed": false, "budgetLimited": true}, nil
		}
		j.Lease = uuid.NewString()
		j.Attempts++
		if _, e = tx.Exec(ctx, `UPDATE jobs SET state='running',attempts=attempts+1,lease_id=$2,locked_until=$3 WHERE id=$1`, id, j.Lease, iso(s.now()+30)); e != nil {
			return nil, e
		}
		claimed = j
		return nil, nil
	})
	if e != nil {
		return evidence.JobOutcome{}, e
	}
	if claimed == nil {
		return evidence.JobOutcome{Result: initial, RetryAt: due}, nil
	}
	source := s.source()
	var observation Object
	context, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, e := s.requestWithin(ctx, tx, str(claimed.Payload, "ciRequestId"))
		if e != nil {
			return nil, e
		}
		return s.SourceWithin(ctx, tx, row)
	})
	if e != nil {
		var se *fault.Error
		if !errors.As(e, &se) {
			return evidence.JobOutcome{}, e
		}
		observation = Object{"status": "revoked", "collectedAt": s.now(), "capabilitiesVerified": false}
	} else {
		if verify == nil {
			verify = source.Verify
		}
		at := s.now()
		ref := obj(obj(context["data"])["source"])
		observation, e = verify(ctx, ref, at)
		if e == nil {
			observation, e = source.CheckObservation(observation, ref, at)
		}
		if e == nil && (observation == nil || observation["status"] != "observed" || observation["capabilitiesVerified"] != false || observation["verifier"] != source.Verifier() || num(observation, "collectedAt") != at || !safe(observation, "validUntil", 0, 9007199254740991) || num(observation, "validUntil") <= at || num(observation, "validUntil") > at+86400 || len(encode(observation)) > 16000) {
			e = fault.New("ci_observation_too_large", 409)
		}
		if e != nil {
			observation = Object{"status": "unavailable", "collectedAt": s.now(), "capabilitiesVerified": false, "reason": "source_unavailable_or_invalid"}
		}
	}
	var retryAt time.Time
	result, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, e := s.requestWithin(ctx, tx, str(claimed.Payload, "ciRequestId"))
		if e == nil {
			_, e = s.SourceWithin(ctx, tx, row)
		}
		if e != nil {
			var se *fault.Error
			if !errors.As(e, &se) {
				return nil, e
			}
			observation = Object{"status": "revoked", "collectedAt": s.now(), "capabilitiesVerified": false}
		}
		current, e := job(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		if current == nil || current.State != "running" || current.Lease != claimed.Lease {
			return Object{"processed": false, "leaseLost": true}, nil
		}
		row, e = request(ctx, tx, str(claimed.Payload, "ciRequestId"), "", "UPDATE")
		if e != nil {
			return nil, e
		}
		if row == nil {
			return Object{"processed": false, "sourceDeleted": true}, nil
		}
		if row.State == "revoked" {
			observation = Object{"status": "revoked", "collectedAt": s.now(), "capabilitiesVerified": false}
		}
		if _, e = tx.Exec(ctx, `INSERT INTO ci_observations_v2(id,request_id,job_id,attempt,observation) VALUES($1,$2,$3,$4,$5::jsonb)`, uuid.NewString(), row.ID, id, claimed.Attempts, string(encode(observation))); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE ci_requests_v2 SET state=$2 WHERE id=$1`, row.ID, observation["status"]); e != nil {
			return nil, e
		}
		retry := (observation["status"] == "unavailable" || observation["status"] == "observed" && observation["completed"] != true) && claimed.Attempts < 5
		state := "completed"
		if retry {
			state = "pending"
		} else if observation["status"] == "unavailable" {
			state = "failed"
		}
		delay := int64(10) * (int64(1) << claimed.Attempts)
		if delay > 300 {
			delay = 300
		}
		available := time.Unix(s.now()+delay, 0)
		if retry {
			retryAt = available
		}
		if _, e = tx.Exec(ctx, `UPDATE jobs SET state=$2,lease_id=NULL,locked_until=NULL,available_at=$3 WHERE id=$1`, id, state, available); e != nil {
			return nil, e
		}
		tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,idempotency_key,binding_scopes) SELECT $1,'ci.observed',$2::text,$3::text,$4,1,'galaxy-evidence-worker',b.audience,'evidence',c.id,b.id,$3::text||':'||$5::integer::text,b.scopes FROM ci_requests_v2 r JOIN consents c ON c.id=r.consent_id JOIN bindings b ON b.id=c.binding_id WHERE r.id=$2::text::uuid AND c.subject_id=r.subject_id AND b.subject_id=r.subject_id`, source.Verifier(), row.ID, id, observation["status"], claimed.Attempts)
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() != 1 {
			return nil, fault.New("ci_audit_context_unavailable", 500)
		}
		return flags(Object{"processed": true, "state": observation["status"]}), nil
	})
	return evidence.JobOutcome{Result: result, RetryAt: retryAt}, e
}

// RecoverExpired is the original CI-only maintenance transition. It does not
// send a request, reconstruct an operation or start a background loop.
func (s *Service) RecoverExpired(ctx context.Context) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("ci_service_unavailable", 503)
	}
	policy := s.budgetPolicy()
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		at := iso(s.now())
		if p := policy; p != nil {
			if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(734912310)`); e != nil {
				return nil, e
			}
			var active int64
			if e := tx.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE state='running' AND locked_until>$1`, at).Scan(&active); e != nil {
				return nil, e
			}
			if active >= p.MaxActiveJobsGlobal {
				return Object{"budgetLimited": true, "exhausted": 0, "unavailable": 0}, nil
			}
		}
		failed, e := tx.Exec(ctx, `UPDATE jobs SET state='failed',lease_id=NULL,locked_until=NULL WHERE kind=$1 AND attempts>=5 AND (state='pending' OR state='running' AND locked_until<=$2)`, JobKind, at)
		if e != nil {
			return nil, e
		}
		unavailable, e := tx.Exec(ctx, `UPDATE ci_requests_v2 r SET state='unavailable' WHERE r.state='pending' AND EXISTS(SELECT 1 FROM jobs j WHERE j.kind=$1 AND j.payload->>'ciRequestId'=r.id::text AND j.state='failed')`, JobKind)
		if e != nil {
			return nil, e
		}
		return Object{"exhausted": failed.RowsAffected(), "unavailable": unavailable.RowsAffected()}, nil
	})
}
