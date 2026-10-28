package civ2

import (
	"context"

	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type observationRow struct {
	ID, RequestID, JobID string
	Attempt              int64
	Observation          any
}

func latest(ctx context.Context, tx pgx.Tx, id string) (*observationRow, error) {
	var r observationRow
	var raw []byte
	e := tx.QueryRow(ctx, `SELECT id::text,request_id::text,job_id::text,attempt,observation FROM ci_observations_v2 WHERE request_id=$1 ORDER BY attempt DESC LIMIT 1`, id).Scan(&r.ID, &r.RequestID, &r.JobID, &r.Attempt, &raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	r.Observation, e = protocol.DecodeOrdered(raw)
	return &r, e
}
func (s *Service) Get(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	id, e := parseID(raw, "invalid_ci_id")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, "evidence", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		row, e := s.requestWithin(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		if row.Subject != a.SubjectID {
			return nil, fault.New("ci_request_unavailable", 404)
		}
		if row.State == "revoked" {
			return flags(Object{"requestId": id, "state": "revoked"}), nil
		}
		context, e := s.SourceWithin(ctx, tx, row)
		if e != nil {
			var se *fault.Error
			if !errors.As(e, &se) {
				return nil, e
			}
			return flags(Object{"requestId": id, "state": "source-unavailable"}), nil
		}
		observation, e := latest(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		state := row.State
		var data any
		if observation != nil {
			data = observation.Observation
			if state == "observed" && num(obj(data), "validUntil") <= s.now() {
				state = "stale"
			}
		}
		input := obj(context["data"])
		return flags(Object{"requestId": id, "state": state, "evidenceRef": input["evidenceRef"], "resultRef": input["resultRef"], "synthetic": context["synthetic"], "observation": data}), nil
	})
}
func (s *Service) RevokeRequest(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	id, e := parseID(raw, "invalid_ci_id")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, "evidence", true, true, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		row, e := request(ctx, tx, id, a.SubjectID, "UPDATE")
		if e != nil {
			return nil, e
		}
		if row == nil {
			return nil, fault.New("ci_request_unavailable", 404)
		}
		if _, e = tx.Exec(ctx, `UPDATE ci_requests_v2 SET state='revoked' WHERE id=$1`, id); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, id, row.ConsentID, "ci.revoke", "evidence", requestID, auth); e != nil {
			return nil, e
		}
		return flags(Object{"requestId": id, "state": "revoked"}), nil
	})
}
func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || !exact(q, []string{"id", "type"}) || !uuidPattern.MatchString(str(q, "id")) || !one(q["type"], "request", "proof") {
		return nil, fault.New("invalid_ci_receipt", 422)
	}
	scope := "proof"
	if q["type"] == "request" {
		scope = "evidence"
	}
	return s.run(ctx, a, scope, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		var hash, consent, state string
		if q["type"] == "request" {
			row, e := request(ctx, tx, str(q, "id"), a.SubjectID, "")
			if e != nil {
				return nil, e
			}
			if row == nil {
				return Object{"id": q["id"], "type": q["type"], "state": "absent"}, nil
			}
			hash, consent, state = row.Hash, row.ConsentID, row.State
		} else {
			row, e := proof(ctx, tx, str(q, "id"), a.SubjectID, "")
			if e != nil {
				return nil, e
			}
			if row == nil {
				return Object{"id": q["id"], "type": q["type"], "state": "absent"}, nil
			}
			hash, consent, state = row.Hash, row.ConsentID, "recorded-not-current-verified"
			if row.Revoked != nil {
				state = "revoked"
			}
		}
		return flags(Object{"id": q["id"], "type": q["type"], "state": "recorded", "payloadHash": hash, "consentId": consent, "objectState": state}), nil
	})
}
