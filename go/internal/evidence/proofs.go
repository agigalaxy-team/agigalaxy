package evidence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"net/url"
	"strings"
	"time"
)

type ProofSigner interface {
	SignProof(context.Context, any, string, int64, int64) (string, error)
	VerifyProof(context.Context, string, int64) (json.RawMessage, int64, error)
}
type ProofService struct {
	Evidence    *Service
	Signer      ProofSigner
	CaseContext func(context.Context, pgx.Tx, *deviceauth.Actor, string, string) (Object, error)
	Moderation  func(context.Context, pgx.Tx, *deviceauth.Actor, string) (Object, error)
}
type proofRow struct {
	ID, Subject, EvidenceID, ObservationID, ConsentID, Payload, Hash, Signed string
	Revoked                                                                  *time.Time
}

func loadProof(ctx context.Context, tx pgx.Tx, id, subject, lock string) (*proofRow, error) {
	query := `SELECT id::text,subject_id,evidence_id::text,observation_id::text,consent_id::text,payload_text,payload_hash,signed,revoked_at FROM proofs WHERE id=$1`
	args := []any{id}
	if subject != "" {
		query += ` AND subject_id=$2`
		args = append(args, subject)
	}
	if lock == "UPDATE" || lock == "SHARE" {
		query += " FOR " + lock
	}
	var r proofRow
	e := tx.QueryRow(ctx, query, args...).Scan(&r.ID, &r.Subject, &r.EvidenceID, &r.ObservationID, &r.ConsentID, &r.Payload, &r.Hash, &r.Signed, &r.Revoked)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return &r, e
}
func (s *ProofService) source(ctx context.Context, tx pgx.Tx, id, subject string) (observation, *record, error) {
	return s.sourceWithLock(ctx, tx, id, subject, false)
}
func (s *ProofService) sourceWithLock(ctx context.Context, tx pgx.Tx, id, subject string, searchLocked bool) (observation, *record, error) {
	fail := func(code string) (observation, *record, error) { return observation{}, nil, fault.New(code, 409) }
	if s.Evidence == nil {
		return fail("proof_source_unavailable")
	}
	row, e := load(ctx, tx, id, subject, "")
	if e != nil {
		return observation{}, nil, e
	}
	if row == nil || row.State != "observed" {
		return fail("proof_source_unavailable")
	}
	if e = s.Evidence.LiveWithin(ctx, tx, *row); e != nil {
		return observation{}, nil, e
	}
	lock := "SHARE"
	if searchLocked {
		lock = ""
	}
	current, e := load(ctx, tx, id, subject, lock)
	if e != nil {
		return observation{}, nil, e
	}
	if current == nil || current.State != "observed" {
		return fail("proof_source_unavailable")
	}
	latest, e := observations(ctx, tx, id, 1)
	if e != nil {
		return observation{}, nil, e
	}
	source, e := s.Evidence.source()
	if e != nil {
		return observation{}, nil, e
	}
	job, e := currentJob(ctx, tx, id, source.JobKind())
	if e != nil {
		return observation{}, nil, e
	}
	if job != nil && (one(job["state"], "pending", "running") || len(latest) == 0 || latest[0].JobID != str(job, "id")) {
		return fail("proof_revalidation_pending_or_unavailable")
	}
	if len(latest) == 0 {
		return fail("proof_source_unavailable")
	}
	o := obj(latest[0].Value)
	if o == nil || o["status"] != "observed" || o["strength"] != "ci-execution-fact" || o["capabilitiesVerified"] != false || o["completed"] != true || num(o, "validUntil") <= s.Evidence.now() {
		return fail("proof_source_unavailable")
	}
	return latest[0], row, nil
}
func (s *ProofService) payload(id, subject, evidenceID string, preparedAt int64, source observation) *protocol.OrderedObject {
	o := obj(source.Value)
	v := ordered("version", 1, "type", "ci-execution-observation", "id", id, "subject", subject, "issuer", s.Evidence.Endpoint, "evidenceId", evidenceID, "observationId", source.ID, "scope", "referenced-ci-run-only", "strength", o["strength"], "independence", o["independence"], "attribution", o["attribution"], "source", o["source"], "conclusion", o["conclusion"])
	if o["sourceControl"] != nil {
		v.Set("sourceControl", o["sourceControl"])
	}
	for _, p := range []struct {
		k string
		v any
	}{{"taskOutcomeVerification", "not-independently-verified"}, {"capabilityVerified", false}, {"preparedAt", preparedAt}, {"observedAt", o["collectedAt"]}, {"expiresAt", o["validUntil"]}, {"limitations", o["limitations"]}, {"statusPath", "/v1/proofs/" + id + "/status"}} {
		v.Set(p.k, p.v)
	}
	return v
}
func (s *ProofService) Preview(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || !exact(q, []string{"id", "evidenceId"}, nil) || !uuidPattern.MatchString(str(q, "id")) || !uuidPattern.MatchString(str(q, "evidenceId")) {
		return nil, fault.New("invalid_proof_request", 400)
	}
	if s.Evidence == nil {
		return nil, fault.New("proof_service_unavailable", 503)
	}
	return s.Evidence.run(ctx, a, "proof", false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		source, _, e := s.source(ctx, tx, str(q, "evidenceId"), a.SubjectID)
		if e != nil {
			return nil, e
		}
		payload, e := protocol.EncodeJS(s.payload(str(q, "id"), a.SubjectID, str(q, "evidenceId"), s.Evidence.now(), source))
		if e != nil {
			return nil, e
		}
		return Object{"payloadJson": string(payload), "payloadHash": identity.Digest(payload), "published": false}, nil
	})
}
func (s *ProofService) Publish(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	consent, payload, e := request(raw, "invalid_proof_payload")
	if e != nil {
		return nil, e
	}
	var candidate Object
	if s.Evidence == nil {
		return nil, fault.New("proof_service_unavailable", 503)
	}
	now := s.Evidence.now()
	if protocol.TextLength(payload) > 12000 || protocol.Decode([]byte(payload), &candidate) != nil || !uuidPattern.MatchString(str(candidate, "id")) || !uuidPattern.MatchString(str(candidate, "evidenceId")) || !safe(candidate, "preparedAt", 0, 9007199254740991) || num(candidate, "preparedAt") > now || num(candidate, "preparedAt") < now-300 {
		return nil, fault.New("invalid_proof_payload", 400)
	}
	return s.Evidence.run(ctx, a, "proof", true, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		source, _, e := s.source(ctx, tx, str(candidate, "evidenceId"), a.SubjectID)
		if e != nil {
			return nil, e
		}
		expected := s.payload(str(candidate, "id"), a.SubjectID, str(candidate, "evidenceId"), num(candidate, "preparedAt"), source)
		wire, e := protocol.EncodeJS(expected)
		if e != nil {
			return nil, e
		}
		if payload != string(wire) {
			return nil, fault.New("proof_preview_changed", 409)
		}
		if _, e = s.Evidence.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: consent, SubjectID: a.SubjectID, Action: "proof.publish", ObjectID: str(candidate, "id"), Recipient: s.Evidence.Endpoint, PayloadJSON: payload}); e != nil {
			return nil, e
		}
		prior, e := loadProof(ctx, tx, str(candidate, "id"), "", "UPDATE")
		if e != nil {
			return nil, e
		}
		same := func(r *proofRow) bool {
			return r != nil && r.Subject == a.SubjectID && r.Hash == identity.Digest([]byte(payload)) && r.ConsentID == consent && r.Revoked == nil
		}
		if prior != nil {
			if !same(prior) {
				return nil, fault.New("proof_conflict", 409)
			}
			return Object{"proofId": prior.ID, "signed": prior.Signed}, nil
		}
		if s.Signer == nil {
			return nil, fault.New("proof_signer_unavailable", 503)
		}
		signed, e := s.Signer.SignProof(ctx, expected, str(candidate, "id"), s.Evidence.now(), num(expected.Values(), "expiresAt")-s.Evidence.now())
		if e != nil {
			return nil, e
		}
		tag, e := tx.Exec(ctx, `INSERT INTO proofs(id,subject_id,evidence_id,observation_id,consent_id,payload_text,payload_hash,signed) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`, candidate["id"], a.SubjectID, candidate["evidenceId"], source.ID, consent, payload, identity.Digest([]byte(payload)), signed)
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() == 0 {
			prior, e := loadProof(ctx, tx, str(candidate, "id"), "", "")
			if e != nil {
				return nil, e
			}
			if !same(prior) {
				return nil, fault.New("proof_conflict", 409)
			}
			return Object{"proofId": prior.ID, "signed": prior.Signed}, nil
		}
		if e = s.Evidence.audit(ctx, tx, a, auth, str(candidate, "id"), "proof.publish", requestID); e != nil {
			return nil, e
		}
		return Object{"proofId": candidate["id"], "signed": signed}, nil
	})
}
func describeProof(v any) (Object, error) {
	d := obj(v)
	issuer, ue := url.Parse(str(d, "issuer"))
	if ue != nil || issuer.Scheme == "" {
		return nil, fmt.Errorf("invalid CI proof issuer")
	}
	if !exact(d, []string{"version", "type", "id", "subject", "issuer", "evidenceId", "observationId", "scope", "strength", "independence", "attribution", "source", "conclusion", "taskOutcomeVerification", "capabilityVerified", "preparedAt", "observedAt", "expiresAt", "limitations", "statusPath"}, []string{"sourceControl"}) || !safe(d, "version", 1, 1) || d["type"] != "ci-execution-observation" || !uuidPattern.MatchString(str(d, "id")) || !uuidPattern.MatchString(str(d, "evidenceId")) || !uuidPattern.MatchString(str(d, "observationId")) || protocol.TextLength(str(d, "subject")) < 1 || protocol.TextLength(str(d, "subject")) > 240 || d["scope"] != "referenced-ci-run-only" || d["strength"] != "ci-execution-fact" || d["independence"] != "repository-controlled" || d["attribution"] != "submitter-asserted" || d["taskOutcomeVerification"] != "not-independently-verified" || d["capabilityVerified"] != false || !conclusion(d["conclusion"]) {
		return nil, fmt.Errorf("invalid CI proof data")
	}
	for _, k := range []string{"preparedAt", "observedAt", "expiresAt"} {
		if !safe(d, k, 0, 9007199254740991) {
			return nil, fmt.Errorf("invalid CI proof time")
		}
	}
	source := obj(d["source"])
	if !exact(source, []string{"provider", "owner", "repository", "runId", "attempt", "commit", "repositoryId", "sourceUpdatedAt"}, nil) || !safe(source, "repositoryId", 1, 9007199254740991) {
		return nil, fmt.Errorf("invalid CI proof source")
	}
	r := Object{}
	for _, k := range []string{"provider", "owner", "repository", "runId", "attempt", "commit"} {
		r[k] = source[k]
	}
	if _, e := (GithubSource{}).Reference(r); e != nil {
		return nil, e
	}
	if _, e := time.Parse(time.RFC3339Nano, str(source, "sourceUpdatedAt")); e != nil || !strings.HasSuffix(str(source, "sourceUpdatedAt"), "Z") {
		return nil, fmt.Errorf("invalid CI source time")
	}
	if c, ok := d["sourceControl"]; ok {
		if !control(c) {
			return nil, fmt.Errorf("invalid CI source control")
		}
		if owner := obj(obj(c)["repositoryOwner"]); owner != nil && !strings.EqualFold(str(owner, "login"), str(source, "owner")) {
			return nil, fmt.Errorf("repository owner mismatch")
		}
	}
	limitations, ok := d["limitations"].([]any)
	if !ok || len(limitations) < 1 || len(limitations) > 30 {
		return nil, fmt.Errorf("invalid CI limitations")
	}
	for _, v := range limitations {
		s, ok := v.(string)
		if !ok || protocol.TextLength(s) < 1 || protocol.TextLength(s) > 2000 {
			return nil, fmt.Errorf("invalid CI limitations")
		}
	}
	if _, ok := d["statusPath"].(string); !ok {
		return nil, fmt.Errorf("invalid CI status path")
	}
	normalizedSource := fields(source, "provider", "owner", "repository", "runId", "attempt", "commit", "repositoryId", "sourceUpdatedAt")
	var normalizedControl any
	if c := obj(d["sourceControl"]); c != nil {
		v := fields(c, "version", "observedVia")
		if owner := obj(c["repositoryOwner"]); owner != nil {
			v.Set("repositoryOwner", fields(owner, "id", "login", "type"))
		} else {
			v.Set("repositoryOwner", nil)
		}
		v.Set("submitterControlVerified", false)
		v.Set("independentExecutionVerified", false)
		normalizedControl = v
	}
	return Object{"version": 1, "profile": "github-actions-provenance/1", "sourceKey": fmt.Sprintf("github-actions:repository:%d:run:%d:attempt:%d", num(source, "repositoryId"), num(source, "runId"), num(source, "attempt")), "issuer": d["issuer"], "proofId": d["id"], "source": normalizedSource, "conclusion": d["conclusion"], "sourceControl": normalizedControl, "authority": "issuer-attested-github-api-observation", "submitterControlVerified": false, "independentExecutionVerified": false}, nil
}
func (s *ProofService) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, statusOnly bool) (out Object, err error) {
	if !uuidPattern.MatchString(id) {
		return nil, fault.New("not_found", 404)
	}
	row, e := loadProof(ctx, tx, id, "", "")
	if e != nil {
		return nil, e
	}
	if row == nil || row.Revoked != nil {
		return nil, fault.New("not_found", 404)
	}
	defer func() {
		if err != nil {
			var pe *pgconn.PgError
			if !errors.As(err, &pe) {
				err = fault.New("not_found", 404)
			}
		}
	}()
	source, evidence, e := s.source(ctx, tx, row.EvidenceID, row.Subject)
	if e != nil {
		return nil, e
	}
	if source.ID != row.ObservationID {
		return nil, fmt.Errorf("source changed")
	}
	intent, e := s.Evidence.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: row.ConsentID, SubjectID: row.Subject, Action: "proof.publish", ObjectID: id, Recipient: s.Evidence.Endpoint, PayloadJSON: row.Payload})
	if e != nil {
		return nil, e
	}
	current, e := loadProof(ctx, tx, id, "", "SHARE")
	if e != nil {
		return nil, e
	}
	if current == nil || current.Revoked != nil {
		return nil, fmt.Errorf("proof revoked")
	}
	if !readable(intent, a, s.Evidence.now(), true) {
		return nil, fmt.Errorf("visibility denied")
	}
	if s.Signer == nil {
		return nil, fmt.Errorf("proof signer unavailable")
	}
	raw, expires, e := s.Signer.VerifyProof(ctx, row.Signed, s.Evidence.now())
	if e != nil {
		return nil, e
	}
	data, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	provenance, e := describeProof(data)
	if e != nil {
		return nil, e
	}
	out = Object{}
	if statusOnly {
		out["status"] = "active"
		out["expiresAt"] = expires
		out["capabilityVerified"] = false
	} else {
		out["proofId"] = id
		out["signed"] = row.Signed
		out["status"] = "active"
	}
	if s.CaseContext != nil {
		context, e := s.CaseContext(ctx, tx, a, evidence.CaseID, row.Subject)
		if e != nil {
			return nil, e
		}
		if context != nil {
			out["caseContext"] = context
		}
	} else {
		var has bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM case_events WHERE case_id=$1 AND kind='revision')`, evidence.CaseID).Scan(&has); e != nil {
			return nil, e
		}
		if has {
			return nil, fmt.Errorf("proof case context reader unavailable")
		}
	}
	out["provenance"] = provenance
	if s.Moderation != nil {
		context, e := s.Moderation(ctx, tx, a, evidence.CaseID)
		if e != nil {
			return nil, e
		}
		if len(arr(context["items"])) > 0 {
			out["moderationContext"] = context
		}
	} else if a != nil {
		var exists bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM moderation_reports WHERE case_id=$1)`, evidence.CaseID).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return nil, fmt.Errorf("proof moderation reader unavailable")
		}
	}
	return out, nil
}
func readable(v deviceauth.ConsentIntent, a *deviceauth.Actor, now int64, proof bool) bool {
	var viewer *string
	if a != nil {
		viewer = &a.SubjectID
	}
	return readableFor(v, viewer, now, proof)
}
func readableFor(v deviceauth.ConsentIntent, viewer *string, now int64, proof bool) bool {
	if v.IssuedAt > now || v.ExpiresAt <= now {
		return false
	}
	if viewer != nil && *viewer == v.SubjectID {
		return true
	}
	if v.CurrentVisibility != nil && v.CurrentVisibility.DeletionPending {
		return false
	}
	if v.Visibility == "Public" {
		return v.Purpose == "public-profile"
	}
	if viewer != nil && (v.Visibility == "Private" || proof && v.Visibility == "Proof-only") {
		for _, id := range v.Viewers {
			if id == *viewer {
				return true
			}
		}
	}
	return false
}
func (s *ProofService) Get(ctx context.Context, a *deviceauth.Actor, id string, statusOnly bool) (Object, error) {
	if s.Evidence == nil || s.Evidence.Pool == nil {
		return nil, fault.New("proof_service_unavailable", 503)
	}
	if a != nil {
		return s.Evidence.run(ctx, *a, "proof", false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
			return s.ReadWithin(ctx, tx, a, id, statusOnly)
		})
	}
	return postgres.InTx(ctx, s.Evidence.Pool, func(tx pgx.Tx) (Object, error) { return s.ReadWithin(ctx, tx, nil, id, statusOnly) })
}
func (s *ProofService) Revoke(ctx context.Context, a deviceauth.Actor, id, requestID string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, fault.New("not_found", 404)
	}
	if s.Evidence == nil {
		return nil, fault.New("proof_service_unavailable", 503)
	}
	return s.Evidence.run(ctx, a, "proof", false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		r, e := loadProof(ctx, tx, id, a.SubjectID, "UPDATE")
		if e != nil {
			return nil, e
		}
		if r == nil {
			return nil, fault.New("not_found", 404)
		}
		if r.Revoked == nil {
			if _, e = tx.Exec(ctx, `UPDATE proofs SET revoked_at=$2 WHERE id=$1`, id, time.Unix(s.Evidence.now(), 0)); e != nil {
				return nil, e
			}
			if e = s.Evidence.audit(ctx, tx, a, auth, id, "proof.revoke", requestID); e != nil {
				return nil, e
			}
		}
		return Object{"proofId": id, "status": "revoked"}, nil
	})
}
