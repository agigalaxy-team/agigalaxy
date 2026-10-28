// Package evidence owns the retained CI Evidence/Proof ledger. An observation
// attests to the referenced run only and never certifies individual capability.
package evidence

import (
	"context"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"regexp"
	"time"
)

type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, func() error, func() (Object, error)) (Object, error)

// TaskProducer is called only when explicitly attached to the Go scheduler.
// Its operation is the original business jobs UUID, never River's row number.
type TaskProducer func(context.Context, pgx.Tx, string, string, string) error
type Service struct {
	Pool                 *pgxpool.Pool
	Endpoint             string
	Devices              *deviceauth.Service
	Now                  func() time.Time
	Source               Source
	ResourceWrite        ResourceWrite
	Tasks                TaskProducer
	ResourceBudgetPolicy *resourcebudget.Policy
	BudgetPolicyNow      func() *resourcebudget.Policy
	ConsentReader        func(context.Context, pgx.Tx, deviceauth.ConsentRequirement) (deviceauth.ConsentIntent, error)
	LockCaseState        func(context.Context, pgx.Tx, string, string) (string, error)
}
type record struct{ ID, Subject, CaseID, ResultID, ConsentID, SourceKey, Payload, Hash, State string }

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) source() (Source, error) {
	v := s.Source
	if v == nil {
		v = GithubSource{}
	}
	if !regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`).MatchString(v.JobKind()) || protocol.TextLength(v.Verifier()) > 120 {
		return nil, fmt.Errorf("invalid evidence source adapter")
	}
	return v, nil
}
func (s *Service) run(ctx context.Context, a deviceauth.Actor, scope string, write bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if s.Pool == nil || s.Devices == nil {
		return nil, fault.New("evidence_service_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func() error { var e error; auth, e = s.Devices.CurrentControlWithin(ctx, tx, a, scope); return e }
		operation := func() (Object, error) { return fn(tx, auth) }
		if write && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, a, authorize, operation)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return operation()
	})
}
func load(ctx context.Context, tx pgx.Tx, id, subject, lock string) (*record, error) {
	var r record
	sql := `SELECT id::text,subject_id,case_id::text,result_id::text,consent_id::text,source_key,payload_text,payload_hash,state FROM evidence_submissions WHERE id=$1`
	args := []any{id}
	if subject != "" {
		sql += ` AND subject_id=$2`
		args = append(args, subject)
	}
	if (lock == "UPDATE" || lock == "SHARE") && subject != "" {
		purpose := "read"
		if lock == "UPDATE" {
			purpose = "write"
		}
		sql = `SELECT id::text,subject_id,case_id::text,result_id::text,consent_id::text,source_key,payload_text,payload_hash,state FROM public.galaxy_api_lock_evidence_` + purpose + `($1,$2)`
	}
	e := tx.QueryRow(ctx, sql, args...).Scan(&r.ID, &r.Subject, &r.CaseID, &r.ResultID, &r.ConsentID, &r.SourceKey, &r.Payload, &r.Hash, &r.State)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return &r, e
}
func (s *Service) LiveWithin(ctx context.Context, tx pgx.Tx, r record) error {
	var state string
	var e error
	if s.LockCaseState != nil {
		state, e = s.LockCaseState(ctx, tx, r.CaseID, r.Subject)
	} else {
		e = tx.QueryRow(ctx, `SELECT state FROM cases WHERE id=$1 AND subject_id=$2 FOR SHARE`, r.CaseID, r.Subject).Scan(&state)
	}
	if errors.Is(e, pgx.ErrNoRows) || e == nil && state == "withdrawn" {
		return fault.New("case_unavailable", 403)
	}
	if e != nil {
		return e
	}
	var resultID, consent string
	var exact *string
	var payload []byte
	e = tx.QueryRow(ctx, `SELECT id::text,consent_id::text,payload,payload_text FROM case_events WHERE id=$1 AND case_id=$2 AND kind='result'`, r.ResultID, r.CaseID).Scan(&resultID, &consent, &payload, &exact)
	if errors.Is(e, pgx.ErrNoRows) {
		return fault.New("result_required", 400)
	}
	if e != nil {
		return e
	}
	var result Object
	if protocol.Decode(payload, &result) != nil {
		return fmt.Errorf("invalid original result")
	}
	rows, e := tx.Query(ctx, `SELECT id::text,consent_id::text,payload_text FROM case_events WHERE case_id=$1 AND (kind='case' OR id=$2)`, r.CaseID, result["attemptId"])
	if e != nil {
		return e
	}
	grants := []deviceauth.ConsentRequirement{}
	for rows.Next() {
		var id, c string
		var raw *string
		if e = rows.Scan(&id, &c, &raw); e != nil {
			rows.Close()
			return e
		}
		text := ""
		if raw != nil {
			text = *raw
		}
		grants = append(grants, deviceauth.ConsentRequirement{ID: c, ObjectID: id, Action: "case.teaser.publish", PayloadJSON: text})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	if len(grants) != 2 {
		return fault.New("source_history_incomplete", 400)
	}
	resultText := ""
	if exact != nil {
		resultText = *exact
	}
	grants = append(grants, deviceauth.ConsentRequirement{ID: consent, ObjectID: resultID, Action: "case.teaser.publish", PayloadJSON: resultText}, deviceauth.ConsentRequirement{ID: r.ConsentID, ObjectID: r.ID, Action: "evidence.submit", PayloadJSON: r.Payload})
	if s.Devices == nil {
		return fault.New("evidence_service_unavailable", 503)
	}
	for _, g := range grants {
		g.SubjectID = r.Subject
		g.Recipient = s.Endpoint
		if _, e = s.require(ctx, tx, g); e != nil {
			return e
		}
	}
	return nil
}
func (s *Service) RequireLiveWithin(ctx context.Context, tx pgx.Tx, id, subject string) error {
	r, e := load(ctx, tx, id, subject, "")
	if e != nil {
		return e
	}
	if r == nil {
		return fault.New("case_unavailable", 403)
	}
	return s.LiveWithin(ctx, tx, *r)
}
func request(raw []byte, code string) (string, string, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil || !exact(o, []string{"consentId", "payloadJson"}, nil) || !uuidPattern.MatchString(str(o, "consentId")) {
		return "", "", fault.New(code, 400)
	}
	p, ok := o["payloadJson"].(string)
	if !ok {
		return "", "", fault.New(code, 400)
	}
	return str(o, "consentId"), p, nil
}
func (s *Service) Submit(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	consent, payload, e := request(raw, "invalid_evidence")
	if e != nil {
		return nil, e
	}
	var data Object
	if protocol.TextLength(payload) > 4096 || protocol.Decode([]byte(payload), &data) != nil || !exact(data, []string{"id", "caseId", "resultId", "source"}, nil) {
		return nil, fault.New("invalid_evidence", 400)
	}
	for _, k := range []string{"id", "caseId", "resultId"} {
		if !uuidPattern.MatchString(str(data, k)) {
			return nil, fault.New("invalid_evidence", 400)
		}
	}
	source, e := s.source()
	if e != nil {
		return nil, e
	}
	reference, e := source.Reference(data["source"])
	if e != nil {
		return nil, fault.New("invalid_evidence", 400)
	}
	return s.run(ctx, a, "evidence", true, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		r := record{ID: str(data, "id"), Subject: a.SubjectID, CaseID: str(data, "caseId"), ResultID: str(data, "resultId"), ConsentID: consent, Payload: payload, Hash: identity.Digest([]byte(payload)), SourceKey: source.SourceKey(reference)}
		if e := s.LiveWithin(ctx, tx, r); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO evidence_submissions(id,subject_id,case_id,result_id,consent_id,source_key,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, r.ID, r.Subject, r.CaseID, r.ResultID, r.ConsentID, r.SourceKey, r.Payload, r.Hash); e != nil {
			return nil, e
		}
		saved, e := load(ctx, tx, r.ID, a.SubjectID, "UPDATE")
		if e != nil {
			return nil, e
		}
		if saved == nil || saved.Subject != a.SubjectID || saved.Hash != r.Hash || saved.ConsentID != consent {
			return nil, fault.New("evidence_conflict", 409)
		}
		jobID := uuid.NewString()
		if _, e = tx.Exec(ctx, `INSERT INTO jobs(id,kind,deduplication_key,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(deduplication_key) DO NOTHING`, jobID, source.JobKind(), "verify:"+r.ID, string(encode(Object{"evidenceId": r.ID}))); e != nil {
			return nil, e
		}
		if s.Tasks != nil {
			if e = tx.QueryRow(ctx, `SELECT id::text FROM jobs WHERE deduplication_key=$1`, "verify:"+r.ID).Scan(&jobID); e != nil {
				return nil, e
			}
			if e = s.Tasks(ctx, tx, jobID, r.ID, source.JobKind()); e != nil {
				return nil, e
			}
		}
		if e = s.audit(ctx, tx, a, auth, r.ID, "evidence.submit", requestID); e != nil {
			return nil, e
		}
		return Object{"evidenceId": r.ID, "state": saved.State, "capabilityVerified": false}, nil
	})
}

type observation struct {
	ID, JobID string
	Value     any
}

func observations(ctx context.Context, tx pgx.Tx, id string, limit int) ([]observation, error) {
	rows, e := tx.Query(ctx, `SELECT id::text,job_id::text,observation FROM verification_attempts WHERE evidence_id=$1 ORDER BY ordinal DESC LIMIT $2`, id, limit)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []observation{}
	for rows.Next() {
		var r observation
		var raw []byte
		if e = rows.Scan(&r.ID, &r.JobID, &raw); e != nil {
			return nil, e
		}
		r.Value, e = protocol.DecodeOrdered(raw)
		if e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func currentJob(ctx context.Context, tx pgx.Tx, id, kind string) (Object, error) {
	var jobID, state string
	var raw []byte
	e := tx.QueryRow(ctx, `SELECT id::text,state,payload FROM jobs WHERE payload->>'evidenceId'=$1 AND kind=$2 ORDER BY COALESCE((payload->'revalidation'->>'generation')::integer,0) DESC,id DESC LIMIT 1`, id, kind).Scan(&jobID, &state, &raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var p Object
	if protocol.Decode(raw, &p) != nil {
		return nil, fmt.Errorf("invalid verification job")
	}
	return Object{"id": jobID, "state": state, "payload": p}, nil
}
func (s *Service) Get(ctx context.Context, a deviceauth.Actor, id string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, fault.New("not_found", 404)
	}
	return s.run(ctx, a, "evidence", false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		saved, e := load(ctx, tx, id, a.SubjectID, "")
		if e != nil {
			return nil, e
		}
		if saved == nil {
			return nil, fault.New("not_found", 404)
		}
		if e = s.LiveWithin(ctx, tx, *saved); e != nil {
			return nil, e
		}
		attempts, e := observations(ctx, tx, id, 20)
		if e != nil {
			return nil, e
		}
		source, e := s.source()
		if e != nil {
			return nil, e
		}
		job, e := currentJob(ctx, tx, id, source.JobKind())
		if e != nil {
			return nil, e
		}
		var latest Object
		current := false
		if len(attempts) > 0 {
			latest = obj(attempts[0].Value)
			current = attempts[0].JobID == str(job, "id")
		}
		state := saved.State
		revalidation := obj(obj(job["payload"])["revalidation"])
		if revalidation != nil && one(job["state"], "pending", "running") {
			state = "revalidating"
		} else if !current && job["state"] == "failed" {
			state = "unavailable"
		}
		if state == "observed" && latest != nil && num(latest, "validUntil") <= s.now() {
			state = "stale"
		}
		out := []any{}
		for _, r := range attempts {
			out = append(out, r.Value)
		}
		return Object{"evidenceId": id, "state": state, "verificationGeneration": num(revalidation, "generation"), "observations": out, "capabilityVerified": false}, nil
	})
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, auth deviceauth.ControlAuthorization, id, action, requestID string) error {
	table, scope := "proofs", "proof"
	if action == "evidence.submit" {
		table, scope = "evidence_submissions", "evidence"
	}
	if !one(action, "evidence.submit", "proof.publish", "proof.revoke") {
		return fmt.Errorf("unsupported evidence audit")
	}
	var rid any
	if requestID != "" {
		rid = requestID
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,$4,c.id,b.id,$5,$2::text,b.scopes,$6::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=(SELECT consent_id FROM `+table+` WHERE id=$2::text::uuid AND subject_id=$1) AND c.subject_id=$1 AND b.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action=$3 AND object_id=$2::text)`, a.SubjectID, id, action, scope, rid, string(encode(auth.CredentialScopes)), a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var count int
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE actor=$1 AND action=$2 AND object_id=$3`, a.SubjectID, action, id).Scan(&count); e != nil {
		return e
	}
	if count != 1 {
		return fmt.Errorf("evidence audit context unavailable")
	}
	return nil
}
