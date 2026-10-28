package civ2

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

type proofRow struct {
	ID, Subject, RequestID, ObservationID, ConsentID, Payload, Hash, Signed string
	Revoked                                                                 *time.Time
}

func proof(ctx context.Context, tx pgx.Tx, id, owner, lock string) (*proofRow, error) {
	query := `SELECT id::text,subject_id,request_id::text,observation_id::text,consent_id::text,payload_text,payload_hash,signed,revoked_at FROM ci_proofs_v2 WHERE id=$1`
	args := []any{id}
	if owner != "" {
		query += ` AND subject_id=$2`
		args = append(args, owner)
	}
	if lock == "SHARE" || lock == "UPDATE" {
		query += " FOR " + lock
	}
	var r proofRow
	var payload *string
	e := tx.QueryRow(ctx, query, args...).Scan(&r.ID, &r.Subject, &r.RequestID, &r.ObservationID, &r.ConsentID, &payload, &r.Hash, &r.Signed, &r.Revoked)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if payload != nil {
		r.Payload = *payload
	}
	return &r, e
}

type currentSource struct {
	Row         *requestRow
	Context     Object
	Observation *observationRow
}

func (s *Service) currentWithin(ctx context.Context, tx pgx.Tx, id string) (*currentSource, error) {
	row, e := s.requestWithin(ctx, tx, id)
	if e != nil {
		return nil, e
	}
	context, e := s.SourceWithin(ctx, tx, row)
	if e != nil {
		return nil, e
	}
	current, e := request(ctx, tx, id, "", "SHARE")
	if e != nil {
		return nil, e
	}
	if current == nil || current.State != "observed" {
		return nil, fault.New("ci_observation_unavailable", 409)
	}
	o, e := latest(ctx, tx, id)
	if e != nil {
		return nil, e
	}
	if o == nil || obj(o.Observation)["status"] != "observed" || obj(o.Observation)["completed"] != true || num(obj(o.Observation), "validUntil") <= s.now() {
		return nil, fault.New("ci_observation_unavailable", 409)
	}
	return &currentSource{Row: row, Context: context, Observation: o}, nil
}
func (s *Service) proofPayload(id string, preparedAt int64, current *currentSource) *protocol.OrderedObject {
	o := obj(current.Observation.Observation)
	v := ordered("version", 2, "type", "ci-execution-observation", "sourceProfile", "facts-v2", "id", id, "subject", current.Row.Subject, "issuer", s.Endpoint, "bindingId", current.Row.ID, "observationId", current.Observation.ID, "scope", "referenced-ci-run-only", "strength", o["strength"], "independence", o["independence"], "attribution", o["attribution"], "source", o["source"])
	if c, ok := o["sourceControl"]; ok {
		v.Set("sourceControl", c)
	}
	for _, entry := range []struct {
		k string
		v any
	}{{"conclusion", o["conclusion"]}, {"synthetic", current.Context["synthetic"]}, {"taskOutcomeVerification", "not-independently-verified"}, {"capabilityVerified", false}, {"preparedAt", preparedAt}, {"observedAt", o["collectedAt"]}, {"expiresAt", o["validUntil"]}, {"limitations", o["limitations"]}, {"statusPath", "/v2/ci/proofs/" + id + "/status"}} {
		v.Set(entry.k, entry.v)
	}
	return v
}
func (s *Service) Preview(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	q, e := parsePreview(raw, "invalid_ci_proof_preview")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, "proof", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		current, e := s.currentWithin(ctx, tx, str(q, "requestId"))
		if e != nil {
			return nil, e
		}
		if current.Row.Subject != a.SubjectID {
			return nil, fault.New("ci_request_unavailable", 404)
		}
		payload, e := protocol.EncodeJS(s.proofPayload(str(q, "id"), s.now(), current))
		if e != nil {
			return nil, e
		}
		return flags(Object{"payloadJson": string(payload), "payloadHash": identity.Digest(payload), "published": false}), nil
	})
}
func (s *Service) Publish(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	consent, payload, e := envelope(raw)
	if e != nil || len(payload) > 12000 {
		return nil, fault.New("invalid_ci_proof", 422)
	}
	var q Object
	if protocol.Decode([]byte(payload), &q) != nil {
		return nil, fault.New("invalid_ci_proof", 422)
	}
	if _, e = parsePreview(encode(Object{"id": q["id"], "requestId": q["bindingId"]}), "invalid_ci_proof"); e != nil || !safe(q, "preparedAt", 0, 9007199254740991) || num(q, "preparedAt") > s.now() || num(q, "preparedAt") < s.now()-300 {
		return nil, fault.New("invalid_ci_proof", 422)
	}
	return s.run(ctx, a, "proof", true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		current, e := s.currentWithin(ctx, tx, str(q, "bindingId"))
		if e != nil {
			return nil, e
		}
		if current.Row.Subject != a.SubjectID {
			return nil, fault.New("ci_request_unavailable", 404)
		}
		expected := s.proofPayload(str(q, "id"), num(q, "preparedAt"), current)
		wire, e := protocol.EncodeJS(expected)
		if e != nil {
			return nil, e
		}
		if string(wire) != payload {
			return nil, fault.New("ci_proof_preview_changed", 409)
		}
		grant, e := s.require(ctx, tx, deviceauth.ConsentRequirement{ID: consent, SubjectID: a.SubjectID, Action: "proof.publish", ObjectID: str(q, "id"), Recipient: s.Endpoint, PayloadJSON: payload})
		if e != nil {
			return nil, e
		}
		if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
			return nil, fault.New("ci_source_unavailable", 409)
		}
		prior, e := proof(ctx, tx, str(q, "id"), "", "SHARE")
		if e != nil {
			return nil, e
		}
		matches := func(row *proofRow) bool {
			return row != nil && row.Subject == a.SubjectID && row.ConsentID == consent && row.Hash == identity.Digest([]byte(payload)) && row.Revoked == nil
		}
		if prior != nil {
			if !matches(prior) {
				return nil, fault.New("ci_proof_conflict", 409)
			}
			return Object{"proofId": q["id"], "signed": prior.Signed}, nil
		}
		if s.Signer == nil {
			return nil, fault.New("ci_signer_unavailable", 503)
		}
		at := s.now()
		signed, e := s.Signer.SignProof(ctx, expected, str(q, "id"), at, num(q, "expiresAt")-at)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO ci_proofs_v2(id,subject_id,request_id,observation_id,consent_id,payload_text,payload_hash,signed) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, q["id"], a.SubjectID, q["bindingId"], q["observationId"], consent, payload, identity.Digest([]byte(payload)), signed); e != nil {
			return nil, e
		}
		saved, e := proof(ctx, tx, str(q, "id"), "", "SHARE")
		if e != nil {
			return nil, e
		}
		if !matches(saved) {
			return nil, fault.New("ci_proof_conflict", 409)
		}
		if e = s.audit(ctx, tx, a, str(q, "id"), consent, "ci.proof.publish", "proof", requestID, auth); e != nil {
			return nil, e
		}
		return flags(Object{"proofId": q["id"], "signed": saved.Signed}), nil
	})
}
func describe(v any) (Object, error) {
	o := obj(v)
	if !safe(o, "version", 2, 2) || o["sourceProfile"] != "facts-v2" || !uuidPattern.MatchString(str(o, "bindingId")) {
		return nil, fault.New("invalid_ci_proof", 422)
	}
	if _, ok := o["synthetic"].(bool); !ok {
		return nil, fault.New("invalid_ci_proof", 422)
	}
	base := copyObject(o)
	delete(base, "sourceProfile")
	delete(base, "bindingId")
	delete(base, "synthetic")
	base["version"] = 1
	base["evidenceId"] = o["bindingId"]
	provenance, e := evidence.DescribeProof(base)
	if e != nil {
		return nil, e
	}
	provenance["version"] = 2
	provenance["profile"] = "github-actions-provenance/2"
	return provenance, nil
}
func (s *Service) ProofWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, error) {
	row, e := proof(ctx, tx, id, "", "")
	if e != nil {
		return nil, e
	}
	if row == nil || row.Revoked != nil || row.Payload == "" {
		return nil, fault.New("ci_proof_unavailable", 404)
	}
	current, e := s.currentWithin(ctx, tx, row.RequestID)
	if e != nil {
		return nil, e
	}
	if current.Observation.ID != row.ObservationID {
		return nil, fault.New("ci_proof_unavailable", 409)
	}
	grant, e := s.require(ctx, tx, deviceauth.ConsentRequirement{ID: row.ConsentID, SubjectID: row.Subject, Action: "proof.publish", ObjectID: id, Recipient: s.Endpoint, PayloadJSON: row.Payload})
	if e != nil {
		return nil, e
	}
	if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending || !s.canReadProof(grant, a) {
		return nil, fault.New("ci_proof_unavailable", 404)
	}
	locked, e := proof(ctx, tx, id, "", "SHARE")
	if e != nil {
		return nil, e
	}
	if locked == nil || locked.Revoked != nil {
		return nil, fault.New("ci_proof_unavailable", 404)
	}
	if s.Signer == nil {
		return nil, fault.New("ci_proof_verifier_unavailable", 503)
	}
	raw, _, e := s.Signer.VerifyProof(ctx, row.Signed, s.now())
	if e != nil {
		return nil, e
	}
	data, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	wire, e := protocol.EncodeJS(data)
	if e != nil {
		return nil, e
	}
	if identity.Digest([]byte(row.Payload)) != row.Hash || string(wire) != row.Payload {
		return nil, fault.New("ci_proof_integrity_mismatch", 500)
	}
	provenance, e := describe(data)
	if e != nil {
		return nil, e
	}
	return flags(Object{"proofId": id, "status": "active", "signed": row.Signed, "data": data, "provenance": provenance}), nil
}
func (s *Service) canReadProof(v deviceauth.ConsentIntent, a *deviceauth.Actor) bool {
	if v.IssuedAt > s.now() || v.ExpiresAt <= s.now() {
		return false
	}
	if a != nil && a.SubjectID == v.SubjectID {
		return true
	}
	if v.CurrentVisibility != nil && v.CurrentVisibility.DeletionPending {
		return false
	}
	if v.Visibility == "Public" {
		return v.Purpose == "public-profile"
	}
	if a != nil && (v.Visibility == "Private" || v.Visibility == "Proof-only" || v.Visibility == "Hub-scoped" && v.Recipient == s.Endpoint) {
		for _, id := range v.Viewers {
			if id == a.SubjectID {
				return true
			}
		}
	}
	return false
}
func (s *Service) GetProof(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	id, e := parseID(raw, "invalid_ci_id")
	if e != nil {
		return nil, e
	}
	if a != nil {
		return s.run(ctx, *a, "proof", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
			return s.ProofWithin(ctx, tx, a, id)
		})
	}
	if s.Pool == nil {
		return nil, fault.New("ci_service_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.ProofWithin(ctx, tx, nil, id) })
}
func (s *Service) RevokeProof(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	id, e := parseID(raw, "invalid_ci_id")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, "proof", true, true, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		row, e := proof(ctx, tx, id, a.SubjectID, "UPDATE")
		if e != nil {
			return nil, e
		}
		if row == nil {
			return nil, fault.New("ci_proof_unavailable", 404)
		}
		if _, e = tx.Exec(ctx, `UPDATE ci_proofs_v2 SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1`, id, iso(s.now())); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, id, row.ConsentID, "ci.proof.revoke", "proof", requestID, auth); e != nil {
			return nil, e
		}
		return flags(Object{"proofId": id, "status": "revoked"}), nil
	})
}
