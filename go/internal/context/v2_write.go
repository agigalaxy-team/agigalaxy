package contextdata

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

func (s *Service) participation(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, p Object) (Object, error) {
	if s.Participation == nil {
		return nil, fault.New("context_participation_unavailable", 503)
	}
	v, e := s.Participation(ctx, tx, a, text(p, "taskId"), text(p, "participationId"))
	if e != nil {
		return nil, e
	}
	if v["subjectId"] != p["participantId"] || number(v, "scopeVersion") != number(p, "scopeVersion") || v["scopeEventId"] != p["scopeEventId"] {
		return nil, fault.New("context_scope_changed", 403)
	}
	if v["paused"] == true || v["taskState"] != "open" || !one(v["state"], "active", "delivered", "accepted") {
		return nil, fault.New("context_participation_inactive", 403)
	}
	return v, nil
}
func replayedGrant(r Object, a deviceauth.Actor, consent, payload string) (Object, error) {
	if r["subject_id"] != a.SubjectID || r["consent_id"] != consent || r["payload_hash"] != identity.Digest([]byte(payload)) {
		return nil, fault.New("context_conflict", 409)
	}
	return Object{"grantId": r["id"], "eventId": r["id"], "state": "acknowledged", "materialsHash": r["materials_hash"], "contextAccessGranted": false, "authority": "accepted-event-only; not-current-authorization"}, nil
}
func replayedEvent(r Object, a deviceauth.Actor, input Object, consent, payload string) (Object, error) {
	if r["subject_id"] != a.SubjectID || r["grant_id"] != input["grantId"] || r["consent_id"] != consent || r["payload_hash"] != identity.Digest([]byte(payload)) {
		return nil, fault.New("context_event_conflict", 409)
	}
	return Object{"grantId": r["grant_id"], "eventId": r["id"], "state": "acknowledged", "contextAccessGranted": false, "authority": "accepted-event-only; not-current-authorization"}, nil
}

const grantColumns = `id::text,task_id::text,participation_id::text,subject_id,participant_id,scope_version,scope_event_id::text,consent_id::text,payload_text,payload_hash,materials_hash,expires_at,state,response_event_id::text,revoked_at,erased_at,created_at`
const eventColumns = `id::text,grant_id::text,subject_id,kind,consent_id::text,payload_text,payload_hash,created_at`

func (s *Service) CreateV2(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	input, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	payload := text(input, "payloadJson")
	parsed, e := parseGrant(payload, true)
	if e != nil {
		return nil, e
	}
	p := parsed.Values()
	return s.run(ctx, a, true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		participation, e := s.participation(ctx, tx, a, p)
		if e != nil {
			return nil, e
		}
		if participation["requesterId"] != a.SubjectID {
			return nil, fault.New("context_requester_required", 403)
		}
		prior, e := row(ctx, tx, `SELECT `+grantColumns+` FROM context_grants_v2 WHERE id=$1 FOR UPDATE`, p["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			return replayedGrant(prior, a, text(input, "consentId"), payload)
		}
		grant, e := s.consent(ctx, tx, a.SubjectID, text(input, "consentId"), text(p, "id"), payload)
		if e != nil {
			return nil, e
		}
		if e = privateRecipient(grant, text(p, "participantId")); e != nil {
			return nil, e
		}
		if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
			return nil, fault.New("context_source_deletion_pending", 403)
		}
		expires := number(p, "expiresAt")
		if expires <= s.now() || expires > grant.ExpiresAt {
			return nil, fault.New("context_expiry_mismatch", 403)
		}
		hash := identity.Digest(encode(p["materials"]))
		tag, e := tx.Exec(ctx, `INSERT INTO context_grants_v2(id,task_id,participation_id,subject_id,participant_id,scope_version,scope_event_id,consent_id,payload_text,payload_hash,materials_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12),$13) ON CONFLICT(id) DO NOTHING`, p["id"], p["taskId"], p["participationId"], a.SubjectID, p["participantId"], number(p, "scopeVersion"), p["scopeEventId"], input["consentId"], payload, identity.Digest([]byte(payload)), hash, expires, s.at())
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() == 0 {
			r, e := row(ctx, tx, `SELECT `+grantColumns+` FROM context_grants_v2 WHERE id=$1 FOR UPDATE`, p["id"])
			if e != nil {
				return nil, e
			}
			return replayedGrant(r, a, text(input, "consentId"), payload)
		}
		if e = s.auditWrite(ctx, tx, a, auth, text(p, "id"), "context.create", requestID, true); e != nil {
			return nil, e
		}
		return Object{"grantId": p["id"], "eventId": p["id"], "state": "recorded-awaiting-recipient-acceptance", "materialsHash": hash, "contextAccessGranted": false}, nil
	})
}
func (s *Service) SubmitEventV2(ctx context.Context, a deviceauth.Actor, id string, raw []byte, requestID string) (Object, error) {
	input, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	payload := text(input, "payloadJson")
	parsed, e := parseEvent(payload, true)
	if e != nil {
		return nil, e
	}
	p := parsed.Values()
	if p["grantId"] != id {
		return nil, fault.New("context_target_mismatch", 400)
	}
	return s.run(ctx, a, true, p["kind"] != "accept", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		if _, e := s.locateV2(ctx, tx, a, id, false); e != nil {
			return nil, e
		}
		prior, e := row(ctx, tx, `SELECT `+eventColumns+` FROM context_events_v2 WHERE id=$1`, p["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			return replayedEvent(prior, a, p, text(input, "consentId"), payload)
		}
		var r Object
		state := ""
		if p["kind"] == "accept" {
			v, e := s.inspectV2(ctx, tx, a, id)
			if e != nil {
				return nil, e
			}
			r, state = v.row, v.state
		} else {
			r, e = s.locateV2(ctx, tx, a, id, true)
			if e != nil {
				return nil, e
			}
		}
		if p["taskId"] != r["task_id"] || p["participationId"] != r["participation_id"] || number(p, "scopeVersion") != number(r, "scope_version") || p["materialsHash"] != r["materials_hash"] {
			return nil, fault.New("context_response_mismatch", 403)
		}
		expected := r["participant_id"]
		if p["kind"] == "revoke" {
			expected = r["subject_id"]
		}
		if a.SubjectID != expected {
			return nil, fault.New("context_response_actor_required", 403)
		}
		raced, e := row(ctx, tx, `SELECT `+eventColumns+` FROM context_events_v2 WHERE id=$1`, p["id"])
		if e != nil {
			return nil, e
		}
		if raced != nil {
			return replayedEvent(raced, a, p, text(input, "consentId"), payload)
		}
		if p["kind"] == "accept" && state != "pending" {
			return nil, fault.New("context_not_awaiting_acceptance", 409)
		}
		if p["kind"] == "decline" && r["state"] != "pending" || p["kind"] == "revoke" && r["revoked_at"] != nil {
			return nil, fault.New("context_response_conflict", 409)
		}
		grant, e := s.consent(ctx, tx, a.SubjectID, text(input, "consentId"), text(p, "id"), payload)
		if e != nil {
			return nil, e
		}
		recipient := r["subject_id"]
		if p["kind"] == "revoke" {
			recipient = r["participant_id"]
		}
		if e = privateRecipient(grant, recipient.(string)); e != nil {
			return nil, e
		}
		var collision bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM context_grants_v2 WHERE id=$1)`, p["id"]).Scan(&collision); e != nil {
			return nil, e
		}
		if collision {
			return nil, fault.New("context_event_conflict", 409)
		}
		if _, e = tx.Exec(ctx, `INSERT INTO context_events_v2(id,grant_id,subject_id,kind,consent_id,payload_text,payload_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, p["id"], id, a.SubjectID, p["kind"], input["consentId"], payload, identity.Digest([]byte(payload)), s.at()); e != nil {
			return nil, e
		}
		result := "revoked"
		if p["kind"] == "revoke" {
			_, e = tx.Exec(ctx, `UPDATE context_grants_v2 SET state='revoked',revoked_at=$2 WHERE id=$1`, id, s.at())
		} else {
			result = "declined"
			if p["kind"] == "accept" {
				result = "accepted"
			}
			_, e = tx.Exec(ctx, `UPDATE context_grants_v2 SET state=$2,response_event_id=$3 WHERE id=$1`, id, result, p["id"])
		}
		if e != nil {
			return nil, e
		}
		if e = s.auditWrite(ctx, tx, a, auth, text(p, "id"), "context."+text(p, "kind"), requestID, true); e != nil {
			return nil, e
		}
		return Object{"grantId": id, "eventId": p["id"], "state": result, "materialsHash": r["materials_hash"], "contextAccessGranted": false, "authority": "accepted-event-only; recheck-before-read"}, nil
	})
}
