package builders

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

type ProbeWorker struct {
	Service         *Service
	Budget          *resourcebudget.Policy
	BudgetPolicyNow func() *resourcebudget.Policy
	Transport       ProbeTransport
}

func (w *ProbeWorker) live(ctx context.Context, tx pgx.Tx, payload Object) (Object, error) {
	s := w.Service
	parent, e := one(ctx, tx, "SELECT * FROM public.galaxy_worker_lock_builder($1)", payload["builderId"])
	if e != nil {
		return nil, e
	}
	if parent == nil {
		return nil, fault.New("builder_probe_source_unavailable", 404)
	}
	rows, e := query(ctx, tx, "SELECT id::text,builder_id::text,subject_id,revision,kind,consent_id::text,payload_text,payload_hash,received_at FROM builder_events WHERE builder_id=$1 ORDER BY revision", payload["builderId"])
	if e != nil {
		return nil, e
	}
	b := loadedBuilder{parent: parent, rows: rows}
	var request Object
	for _, row := range rows {
		if row["kind"] == "declare" {
			b.declaration = row
		}
		if row["kind"] == "probe-request" && row["id"] == payload["requestId"] {
			request = row
		}
	}
	if b.declaration == nil || request == nil {
		return nil, fault.New("builder_probe_source_unavailable", 404)
	}
	if e = s.liveProbeMode(ctx, tx, nil, b, request, true); e != nil {
		return nil, e
	}
	return obj(event(request)["target"]), nil
}

// ProcessNext claims only an existing original explicit probe job. Its lease is
// never held over HTTP, and current source authority is checked on both sides.
func (w *ProbeWorker) ProcessNext(ctx context.Context) (Object, error) {
	if w == nil || w.Service == nil || w.Service.Pool == nil {
		return nil, fault.New("builder_probe_worker_unavailable", 503)
	}
	policy := resourcebudget.DefaultPolicy()
	snapshot := w.Budget
	if w.BudgetPolicyNow != nil {
		snapshot = w.BudgetPolicyNow()
	}
	if snapshot != nil {
		policy = *snapshot
	}
	if e := policy.Validate(); e != nil {
		return nil, e
	}
	s := w.Service
	at := time.Unix(s.now(), 0)
	job, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912310)"); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, `UPDATE jobs SET state='failed',lease_id=NULL,locked_until=NULL WHERE id IN (SELECT id FROM jobs WHERE kind='builder-probe' AND attempts>=3 AND (state='pending' OR state='running' AND locked_until<=$1) ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED)`, at); e != nil {
			return nil, e
		}
		count, e := one(ctx, tx, "SELECT count(*) AS count FROM jobs WHERE state='running' AND locked_until>$1", at)
		if e != nil {
			return nil, e
		}
		if num(count, "count") >= policy.MaxActiveJobsGlobal {
			return nil, nil
		}
		row, e := one(ctx, tx, `SELECT j.id::text,j.payload::text,j.attempts FROM jobs j WHERE j.kind='builder-probe' AND j.attempts<3 AND j.available_at<=$1 AND (j.state='pending' OR j.state='running' AND j.locked_until<=$1) AND NOT EXISTS (SELECT 1 FROM jobs recent WHERE recent.kind='builder-probe' AND recent.attempts>0 AND recent.available_at>$1 AND (recent.payload->'origins') ?| ARRAY(SELECT jsonb_array_elements_text(j.payload->'origins'))) AND (SELECT count(*) FROM jobs a LEFT JOIN evidence_submissions e ON a.payload->>'evidenceId'=e.id::text LEFT JOIN ci_requests_v2 ci ON a.payload->>'ciRequestId'=ci.id::text WHERE a.state='running' AND a.locked_until>$1 AND (e.subject_id=j.payload->>'subjectId' OR ci.subject_id=j.payload->>'subjectId' OR a.kind='builder-probe' AND a.payload->>'subjectId'=j.payload->>'subjectId'))<$2 ORDER BY j.available_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`, at, policy.MaxActiveJobsPerSubject)
		if e != nil || row == nil {
			return nil, e
		}
		lease := uuid.NewString()
		if _, e = tx.Exec(ctx, "UPDATE jobs SET state='running',attempts=attempts+1,lease_id=$2,locked_until=$3,available_at=$4 WHERE id=$1", row["id"], lease, at.Add(30*time.Second), at.Add(60*time.Second)); e != nil {
			return nil, e
		}
		var payload Object
		if protocol.Decode([]byte(txt(row, "payload")), &payload) != nil {
			return nil, fmt.Errorf("invalid original probe job")
		}
		row["payload"] = payload
		row["lease_id"] = lease
		row["attempts"] = num(row, "attempts") + 1
		return row, nil
	})
	if e != nil {
		return nil, e
	}
	if job == nil {
		return Object{"processed": false}, nil
	}
	unavailable := func() Object {
		return Object{"version": 1, "status": "revoked", "reason": "probe-source-unavailable", "checkedAt": s.now(), "validUntil": s.now() + 300, "stage": "none", "cardRetrieved": false, "endpointReachable": nil, "protocolResponded": false, "authenticationRequired": false, "authority": "registry-worker-public-observation", "endpointControlVerified": false, "capabilityVerified": false}
	}
	target, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return w.live(ctx, tx, obj(job["payload"])) })
	var observation Object
	if e != nil {
		if !domainError(e) {
			return nil, e
		}
		observation = unavailable()
	} else {
		observation, e = ObserveEndpoint(ctx, target, s.Now, w.Transport)
		if e != nil {
			return nil, e
		}
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		current, e := one(ctx, tx, "SELECT state,lease_id::text FROM jobs WHERE id=$1 FOR UPDATE", job["id"])
		if e != nil {
			return nil, e
		}
		if current == nil || current["lease_id"] != job["lease_id"] || current["state"] != "running" {
			return Object{"processed": false, "leaseLost": true}, nil
		}
		if _, e = w.live(ctx, tx, obj(job["payload"])); e != nil {
			if !domainError(e) {
				return nil, e
			}
			observation = unavailable()
		}
		wire, e := protocol.EncodeJS(observation)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO builder_probes(id,request_id,job_id,attempt,observation) VALUES($1,$2,$3,$4,$5::jsonb)", uuid.NewString(), obj(job["payload"])["requestId"], job["id"], job["attempts"], string(wire)); e != nil {
			return nil, e
		}
		state := "completed"
		if observation["status"] == "unavailable" {
			state = "failed"
			if num(job, "attempts") < 3 {
				state = "pending"
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE jobs SET state=$2,lease_id=NULL,locked_until=NULL,available_at=$3 WHERE id=$1", job["id"], state, time.Unix(s.now()+60, 0)); e != nil {
			return nil, e
		}
		tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,idempotency_key,binding_scopes) SELECT 'galaxy-builder-probe','builder.probe.observe',r.id::text,$2::text,$3,1,'galaxy-evidence-worker',b.audience,'builders',c.id,b.id,$2::text||':'||$4::integer::text,b.scopes FROM builder_events r JOIN consents c ON c.id=r.consent_id JOIN bindings b ON b.id=c.binding_id WHERE r.id=$1`, obj(job["payload"])["requestId"], job["id"], observation["status"], job["attempts"])
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() != 1 {
			return nil, fmt.Errorf("probe audit context unavailable")
		}
		return Object{"processed": true, "state": observation["status"]}, nil
	})
}
