// Package civ2 owns the retained facts-v2 CI request, observation and Proof
// ledger. Each request is bound to exact current source versions and author.
package civ2

import (
	"context"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const JobKind = "verify-github-v2"

type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, bool, func() error, func() (Object, error)) (Object, error)
type Service struct {
	Pool                  *pgxpool.Pool
	Endpoint              string
	Devices               *deviceauth.Service
	Records               *verificationrecords.Service
	Now                   func() time.Time
	Source                evidence.Source
	Signer                evidence.ProofSigner
	ResourceWrite         ResourceWrite
	ResourceBudgetPolicy  *resourcebudget.Policy
	BudgetPolicyNow       func() *resourcebudget.Policy
	Tasks                 evidence.TaskProducer
	ConsentReader         func(context.Context, pgx.Tx, deviceauth.ConsentRequirement) (deviceauth.ConsentIntent, error)
	SourceReader          func(string, string) (*verificationrecords.Service, error)
	ReferenceForRecipient func(context.Context, pgx.Tx, string, Object, Object) (Object, error)
}
type requestRow struct{ ID, Subject, ConsentID, CaseID, Payload, Hash, State string }

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) source() evidence.Source {
	if s.Source != nil {
		return s.Source
	}
	return evidence.GithubSource{}
}
func iso(at int64) string { return time.Unix(at, 0).UTC().Format("2006-01-02T15:04:05.000Z") }
func fmtSource(o Object) string {
	return fmt.Sprintf("github-actions:%s/%s:run:%d:attempt:%d", strings.ToLower(str(o, "owner")), strings.ToLower(str(o, "repository")), num(o, "runId"), num(o, "attempt"))
}
func (s *Service) run(ctx context.Context, a deviceauth.Actor, scope string, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if s.Pool == nil || s.Devices == nil {
		return nil, fault.New("ci_service_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func() error { var e error; auth, e = s.Devices.CurrentControlWithin(ctx, tx, a, scope); return e }
		operation := func() (Object, error) { return fn(tx, auth) }
		if write && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, a, control, authorize, operation)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return operation()
	})
}
func (s *Service) require(ctx context.Context, tx pgx.Tx, r deviceauth.ConsentRequirement) (deviceauth.ConsentIntent, error) {
	if s.ConsentReader != nil {
		return s.ConsentReader(ctx, tx, r)
	}
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fault.New("ci_service_unavailable", 503)
	}
	return s.Devices.RequireConsentWithin(ctx, tx, r)
}
func request(ctx context.Context, tx pgx.Tx, id, owner, lock string) (*requestRow, error) {
	query := `SELECT id::text,subject_id,consent_id::text,case_id::text,payload_text,payload_hash,state FROM ci_requests_v2 WHERE id=$1`
	args := []any{id}
	if owner != "" {
		query += ` AND subject_id=$2`
		args = append(args, owner)
	}
	if lock == "SHARE" || lock == "UPDATE" {
		query += " FOR " + lock
	}
	var r requestRow
	var text *string
	e := tx.QueryRow(ctx, query, args...).Scan(&r.ID, &r.Subject, &r.ConsentID, &r.CaseID, &text, &r.Hash, &r.State)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if text != nil {
		r.Payload = *text
	}
	return &r, e
}
func (s *Service) requestWithin(ctx context.Context, tx pgx.Tx, id string) (*requestRow, error) {
	r, e := request(ctx, tx, id, "", "")
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fault.New("ci_request_unavailable", 404)
	}
	return r, nil
}
func (s *Service) SourceWithin(ctx context.Context, tx pgx.Tx, row *requestRow) (Object, error) {
	if row == nil || row.State == "revoked" || row.Payload == "" || identity.Digest([]byte(row.Payload)) != row.Hash {
		return nil, fault.New("ci_source_unavailable", 409)
	}
	data, e := parseRequest([]byte(row.Payload))
	if e != nil {
		return nil, fault.New("ci_request_unavailable", 422)
	}
	grant, e := s.require(ctx, tx, deviceauth.ConsentRequirement{ID: row.ConsentID, SubjectID: row.Subject, Action: "ci.observe", ObjectID: row.ID, Recipient: s.Endpoint, PayloadJSON: row.Payload})
	if e != nil {
		return nil, e
	}
	if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
		return nil, fault.New("ci_source_unavailable", 409)
	}
	records, e := s.reader(row)
	if e != nil {
		return nil, e
	}
	evref := copyObject(obj(data["evidenceRef"]))
	evref["kind"] = "evidence"
	evidenceView, e := records.RequireReferenceWithin(ctx, tx, nil, evref, verificationrecords.ReferenceOptions{CaseID: str(data, "caseId")})
	if e != nil {
		return nil, e
	}
	target := copyObject(obj(data["resultRef"]))
	target["type"] = "result"
	resultView, e := records.TargetWithin(ctx, tx, nil, target, verificationrecords.TargetOptions{CaseID: str(data, "caseId"), Latest: true})
	if e != nil {
		return nil, e
	}
	result := obj(resultView["fact"])
	origin := obj(result["origin"])
	target = Object{"type": origin["kind"], "id": origin["id"], "version": origin["version"]}
	if _, e = records.TargetWithin(ctx, tx, nil, target, verificationrecords.TargetOptions{CaseID: str(data, "caseId"), Latest: true}); e != nil {
		return nil, e
	}
	context, e := records.CaseWithin(ctx, tx, str(data, "caseId"))
	if e != nil {
		return nil, e
	}
	rows, ok := context["rows"].([]Object)
	if !ok {
		return nil, fmt.Errorf("CI case source rows unavailable")
	}
	var root Object
	for _, r := range rows {
		if one(r["kind"], "case", "case-created") {
			root = r
			break
		}
	}
	rootGrant, e := records.RequireCaseEventForSourceWithin(ctx, tx, root)
	if e != nil {
		return nil, e
	}
	if rootGrant.CurrentVisibility != nil && rootGrant.CurrentVisibility.DeletionPending {
		return nil, fault.New("ci_source_unavailable", 409)
	}
	record := obj(evidenceView["record"])
	if record["reportedBy"] != row.Subject || result["actorId"] != row.Subject {
		return nil, fault.New("ci_source_author_required", 403)
	}
	if record["evidenceType"] != "ci-result" {
		return nil, fault.New("ci_profile_mismatch", 422)
	}
	for k, v := range metadata(obj(data["source"])) {
		if obj(record["source"])[k] != v {
			return nil, fault.New("ci_profile_mismatch", 422)
		}
	}
	if str(record, "taskId") != "" && record["taskId"] != result["taskId"] {
		return nil, fault.New("ci_task_mismatch", 422)
	}
	if str(record, "participationId") != "" && record["participationId"] != result["participationId"] {
		return nil, fault.New("ci_participation_mismatch", 422)
	}
	if num(record, "participationScopeVersion") != 0 && num(record, "participationScopeVersion") != num(result, "participationScopeVersion") {
		return nil, fault.New("ci_scope_mismatch", 409)
	}
	return Object{"data": data, "evidence": evidenceView, "result": result, "synthetic": evidenceView["synthetic"] == true || obj(context["facts"])["synthetic"] == true}, nil
}
func (s *Service) Submit(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	consent, payload, e := envelope(raw)
	if e != nil {
		return nil, fault.New("invalid_ci_request", 422)
	}
	if len(payload) > 8000 {
		return nil, fault.New("invalid_ci_request", 422)
	}
	data, e := parseRequest([]byte(payload))
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, "evidence", true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		row := &requestRow{ID: str(data, "id"), Subject: a.SubjectID, ConsentID: consent, Payload: payload, Hash: identity.Digest([]byte(payload)), State: "pending"}
		if _, e = s.SourceWithin(ctx, tx, row); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO ci_requests_v2(id,subject_id,consent_id,case_id,evidence_id,evidence_version,result_id,result_version,source_key,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`, row.ID, row.Subject, consent, data["caseId"], obj(data["evidenceRef"])["id"], obj(data["evidenceRef"])["version"], obj(data["resultRef"])["id"], obj(data["resultRef"])["version"], s.source().SourceKey(obj(data["source"])), payload, row.Hash); e != nil {
			return nil, e
		}
		saved, e := request(ctx, tx, row.ID, "", "UPDATE")
		if e != nil {
			return nil, e
		}
		if saved == nil || saved.Subject != a.SubjectID || saved.ConsentID != consent || saved.Hash != row.Hash {
			return nil, fault.New("ci_request_conflict", 409)
		}
		if saved.State == "revoked" {
			return nil, fault.New("ci_request_revoked", 409)
		}
		jobID := uuid.NewString()
		if _, e = tx.Exec(ctx, `INSERT INTO jobs(id,kind,deduplication_key,payload,state,available_at) VALUES($1,$2,$3,$4::jsonb,'pending',$5) ON CONFLICT(deduplication_key) DO NOTHING`, jobID, JobKind, "ci-v2:"+row.ID, string(encode(Object{"ciRequestId": row.ID})), iso(s.now())); e != nil {
			return nil, e
		}
		if s.Tasks != nil {
			if e = tx.QueryRow(ctx, `SELECT id::text FROM jobs WHERE deduplication_key=$1`, "ci-v2:"+row.ID).Scan(&jobID); e != nil {
				return nil, e
			}
			if e = s.Tasks(ctx, tx, jobID, row.ID, JobKind); e != nil {
				return nil, e
			}
		}
		if e = s.audit(ctx, tx, a, row.ID, consent, "ci.observe", "evidence", requestID, auth); e != nil {
			return nil, e
		}
		return flags(Object{"requestId": row.ID, "state": saved.State}), nil
	})
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id, consent, action, scope, requestID string, auth deviceauth.ControlAuthorization) error {
	var rid any
	if requestID != "" {
		rid = requestID
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,$2,$3,$3,'accepted',1,ch.payload->>'installationId',b.audience,$4,c.id,b.id,$5,$3,b.scopes,$6::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=$8::uuid AND c.subject_id=$1`, a.SubjectID, action, id, scope, rid, string(encode(auth.CredentialScopes)), a.BindingID, consent)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fault.New("ci_audit_context_unavailable", 500)
	}
	return nil
}
