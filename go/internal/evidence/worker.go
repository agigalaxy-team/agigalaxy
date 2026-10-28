package evidence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

type Verify func(context.Context, Object, int64) (Object, error)
type JobOutcome struct {
	Result  Object
	RetryAt time.Time
}
type verificationJob struct {
	ID, State, Lease string
	Attempts         int64
	Payload          Object
	Available        time.Time
	Locked           *time.Time
}

func job(ctx context.Context, tx pgx.Tx, id, kind string) (*verificationJob, error) {
	var r verificationJob
	var lease *string
	var raw []byte
	e := tx.QueryRow(ctx, `SELECT id::text,state,lease_id::text,attempts,payload,available_at,locked_until FROM jobs WHERE id=$1 AND kind=$2 FOR UPDATE`, id, kind).Scan(&r.ID, &r.State, &lease, &r.Attempts, &raw, &r.Available, &r.Locked)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if lease != nil {
		r.Lease = *lease
	}
	if json.Unmarshal(raw, &r.Payload) != nil {
		return nil, fmt.Errorf("invalid original verification job")
	}
	return &r, nil
}
func (s *Service) revalidationLive(ctx context.Context, tx pgx.Tx, j *verificationJob) error {
	command := obj(j.Payload["revalidation"])
	if command == nil {
		return nil
	}
	var subject, consent string
	var raw *string
	e := tx.QueryRow(ctx, `SELECT subject_id,consent_id::text,payload_text FROM moderation_events WHERE id=$1 AND report_id=$2`, command["eventId"], command["reportId"]).Scan(&subject, &consent, &raw)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && (subject != str(command, "subjectId") || consent != str(command, "consentId")) {
		return fault.New("revalidation_consent_required", 403)
	}
	if e != nil {
		return e
	}
	var p Object
	if raw == nil || json.Unmarshal([]byte(*raw), &p) != nil {
		return fmt.Errorf("invalid original revalidation payload")
	}
	if p["kind"] != "revalidate" || p["evidenceId"] != j.Payload["evidenceId"] {
		return fault.New("revalidation_target_mismatch", 403)
	}
	_, e = s.require(ctx, tx, deviceauth.ConsentRequirement{ID: consent, SubjectID: subject, Action: "moderation.publish", ObjectID: str(command, "eventId"), Recipient: s.Endpoint, PayloadJSON: *raw})
	return e
}
func checked(source Source, value, reference Object, now int64) (Object, error) {
	o, e := source.CheckObservation(value, reference, now)
	if e != nil {
		return nil, e
	}
	if o == nil || o["status"] != "observed" || o["capabilitiesVerified"] != false || o["verifier"] != source.Verifier() || num(o, "collectedAt") != now || !safe(o, "validUntil", 0, 9007199254740991) || num(o, "validUntil") <= now || num(o, "validUntil") > now+86400 {
		return nil, fmt.Errorf("invalid evidence observation")
	}
	return o, nil
}

// ProcessJob is explicit scheduler consumption of one original jobs UUID.
// It never polls a different object, creates a replacement operation, starts
// a production loop, or treats River retries as business retries.
func (s *Service) ProcessJob(ctx context.Context, id string, verify Verify) (JobOutcome, error) {
	if s.Pool == nil || s.Devices == nil {
		return JobOutcome{}, fault.New("evidence_service_unavailable", 503)
	}
	source, e := s.source()
	if e != nil {
		return JobOutcome{}, e
	}
	policy := s.budgetPolicy()
	var claimed *verificationJob
	var deferUntil time.Time
	initial, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
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
				return Object{"processed": false, "budgetLimited": true}, nil
			}
		}
		j, e := job(ctx, tx, id, source.JobKind())
		if e != nil {
			return nil, e
		}
		if j == nil {
			return Object{"processed": false}, nil
		}
		markUnavailable := func() error {
			tag, e := tx.Exec(ctx, `UPDATE evidence_submissions SET state='unavailable' WHERE id=$1 AND state='pending'`, j.Payload["evidenceId"])
			if e != nil {
				return e
			}
			if tag.RowsAffected() > 0 {
				return s.auditTransition(ctx, tx, str(j.Payload, "evidenceId"), id, source, "evidence.unavailable")
			}
			return nil
		}
		if j.State == "failed" {
			if e := markUnavailable(); e != nil {
				return nil, e
			}
			return Object{"processed": false}, nil
		}
		if j.State == "running" && j.Locked != nil && !j.Locked.After(now) && j.Attempts >= 5 {
			if _, e = tx.Exec(ctx, `UPDATE jobs SET state='failed',lease_id=NULL WHERE id=$1`, id); e != nil {
				return nil, e
			}
			if e = s.auditTransition(ctx, tx, str(j.Payload, "evidenceId"), id, source, "verification.exhausted"); e != nil {
				return nil, e
			}
			if e = markUnavailable(); e != nil {
				return nil, e
			}
			return Object{"processed": false}, nil
		}
		if j.Attempts >= 5 || !(j.State == "pending" && !j.Available.After(now) || j.State == "running" && j.Locked != nil && !j.Locked.After(now)) {
			if j.State == "pending" && j.Available.After(now) {
				deferUntil = j.Available
			}
			return Object{"processed": false}, nil
		}
		if p := policy; p != nil {
			var active int64
			if e = tx.QueryRow(ctx, `SELECT count(*) FROM jobs active LEFT JOIN evidence_submissions owned ON active.payload->>'evidenceId'=owned.id::text LEFT JOIN ci_requests_v2 ci ON active.payload->>'ciRequestId'=ci.id::text WHERE (owned.subject_id=(SELECT subject_id FROM evidence_submissions WHERE id=$1) OR ci.subject_id=(SELECT subject_id FROM evidence_submissions WHERE id=$1) OR active.kind='builder-probe' AND active.payload->>'subjectId'=(SELECT subject_id FROM evidence_submissions WHERE id=$1)) AND active.state='running' AND active.locked_until>$2`, j.Payload["evidenceId"], now).Scan(&active); e != nil {
				return nil, e
			}
			if active >= p.MaxActiveJobsPerSubject {
				return Object{"processed": false, "budgetLimited": true}, nil
			}
		}
		j.Lease = uuid.NewString()
		j.Attempts++
		if _, e = tx.Exec(ctx, `UPDATE jobs SET state='running',attempts=attempts+1,lease_id=$2,locked_until=$3 WHERE id=$1`, id, j.Lease, now.Add(30*time.Second)); e != nil {
			return nil, e
		}
		claimed = j
		return nil, nil
	})
	if e != nil {
		return JobOutcome{}, e
	}
	if claimed == nil {
		return JobOutcome{Result: initial, RetryAt: deferUntil}, nil
	}
	var evidence *record
	_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var e error
		evidence, e = load(ctx, tx, str(claimed.Payload, "evidenceId"), "", "")
		return nil, e
	})
	if e != nil {
		return JobOutcome{}, e
	}
	if evidence == nil {
		return JobOutcome{Result: Object{"processed": false, "leaseLost": true}}, nil
	}
	var observation Object
	_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.LiveWithin(ctx, tx, *evidence); e != nil {
			return nil, e
		}
		return nil, s.revalidationLive(ctx, tx, claimed)
	})
	if e != nil {
		var se *fault.Error
		if !errors.As(e, &se) {
			return JobOutcome{}, e
		}
		observation = Object{"status": "revoked", "capabilitiesVerified": false, "collectedAt": s.now()}
	} else {
		var payload Object
		err := json.Unmarshal([]byte(evidence.Payload), &payload)
		var ref Object
		if err == nil {
			ref, err = source.Reference(payload["source"])
		}
		if err == nil {
			if verify == nil {
				verify = source.Verify
			}
			collected := s.now()
			observation, err = verify(ctx, ref, collected)
			if err == nil {
				observation, err = checked(source, observation, ref, collected)
			}
		}
		if err != nil {
			observation = Object{"status": "unavailable", "capabilitiesVerified": false, "collectedAt": s.now(), "reason": "source_unavailable_or_invalid"}
		}
	}
	var retryAt time.Time
	result, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		current, e := job(ctx, tx, id, source.JobKind())
		if e != nil {
			return nil, e
		}
		if current == nil || current.Lease != claimed.Lease || current.State != "running" {
			return Object{"processed": false, "leaseLost": true}, nil
		}
		if e = s.LiveWithin(ctx, tx, *evidence); e == nil {
			e = s.revalidationLive(ctx, tx, claimed)
		}
		if e != nil {
			var se *fault.Error
			if !errors.As(e, &se) {
				return nil, e
			}
			observation = Object{"status": "revoked", "capabilitiesVerified": false, "collectedAt": s.now()}
		}
		if _, e = tx.Exec(ctx, `INSERT INTO verification_attempts(id,evidence_id,job_id,attempt,observation) VALUES($1,$2,$3,$4,$5::jsonb)`, uuid.NewString(), evidence.ID, id, claimed.Attempts, string(encode(observation))); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE evidence_submissions SET state=$2 WHERE id=$1`, evidence.ID, observation["status"]); e != nil {
			return nil, e
		}
		retry := observation["status"] == "unavailable" && claimed.Attempts < 5
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
		if e = s.auditObservation(ctx, tx, evidence.ID, id, str(observation, "status"), source.Verifier(), claimed.Attempts); e != nil {
			return nil, e
		}
		return Object{"processed": true, "state": observation["status"]}, nil
	})
	return JobOutcome{Result: result, RetryAt: retryAt}, e
}
func (s *Service) auditObservation(ctx context.Context, tx pgx.Tx, evidenceID, jobID, state, verifier string, attempt int64) error {
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes) SELECT $4,'evidence.observe',$1::text,$2::text,$3,1,'galaxy-evidence-worker',b.audience,'evidence',c.id,b.id,NULL,$2::text||':'||$5::integer::text,b.scopes FROM evidence_submissions e JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id WHERE e.id=$1::text::uuid AND c.subject_id=e.subject_id AND b.subject_id=e.subject_id AND EXISTS(SELECT 1 FROM verification_attempts v WHERE v.evidence_id=e.id AND v.job_id=$2::text::uuid AND v.attempt=$5::integer)`, evidenceID, jobID, state, verifier, attempt)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("evidence observation audit context unavailable")
	}
	return nil
}
func (s *Service) auditTransition(ctx context.Context, tx pgx.Tx, evidenceID, jobID string, source Source, action string) error {
	var target any
	if jobID != "" {
		target = jobID
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,idempotency_key,binding_scopes) SELECT $4,$3,e.id::text,j.id::text,CASE WHEN $3='verification.exhausted' THEN 'failed' ELSE e.state END,1,'galaxy-evidence-worker',b.audience,'evidence',c.id,b.id,j.id::text||':'||$3,b.scopes FROM evidence_submissions e JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id JOIN jobs j ON j.payload->>'evidenceId'=e.id::text WHERE e.id=$1::uuid AND c.subject_id=e.subject_id AND b.subject_id=e.subject_id AND j.kind=$2 AND j.state='failed' AND ($5::uuid IS NULL OR j.id=$5::uuid)`, evidenceID, source.JobKind(), action, source.Verifier(), target)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("evidence transition audit context unavailable")
	}
	return nil
}
