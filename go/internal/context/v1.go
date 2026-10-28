package contextdata

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

func (s *Service) active(ctx context.Context, tx pgx.Tx, p Object) (Object, error) {
	if s.LegacyLoad == nil {
		return nil, fault.New("context_collaboration_unavailable", 503)
	}
	loaded, e := s.LegacyLoad(ctx, tx, text(p, "assistanceId"))
	if e != nil {
		return nil, e
	}
	state := obj(obj(loaded["row"])["snapshot"])
	var scopeEvent any
	events := list(state["events"])
	for i := len(events) - 1; i >= 0; i-- {
		event := obj(obj(events[i])["event"])
		if one(event["kind"], "select", "confirm", "change-scope", "confirm-scope") {
			scopeEvent = event["id"]
			break
		}
	}
	if loaded["paused"] == true || state["state"] != "active" || obj(state["request"])["caseId"] != p["caseId"] || obj(state["selected"])["providerId"] != p["participantId"] || state["agreedScope"] != p["scope"] || scopeEvent != p["scopeEventId"] {
		return nil, fault.New("context_collaboration_changed", 403)
	}
	return state, nil
}

const legacyGrantColumns = `id::text,assistance_id::text,subject_id,participant_id,consent_id::text,payload_text,payload_hash,revoked_at,created_at`
const legacyAcceptanceColumns = `id::text,grant_id::text,subject_id,consent_id::text,payload_text,payload_hash,created_at`

func (s *Service) CreateV1(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	input, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	payload := text(input, "payloadJson")
	parsed, e := parseGrant(payload, false)
	if e != nil {
		return nil, e
	}
	p := parsed.Values()
	return s.run(ctx, a, true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		state, e := s.active(ctx, tx, p)
		if e != nil {
			return nil, e
		}
		if state["requesterId"] != a.SubjectID {
			return nil, fault.New("context_requester_required", 403)
		}
		g, e := s.consent(ctx, tx, a.SubjectID, text(input, "consentId"), text(p, "id"), payload)
		if e != nil {
			return nil, e
		}
		if privateRecipient(g, text(p, "participantId")) != nil || number(p, "expiresAt") <= s.now() || number(p, "expiresAt") > g.ExpiresAt {
			return nil, fault.New("context_scope_mismatch", 403)
		}
		prior, e := row(ctx, tx, `SELECT `+legacyGrantColumns+` FROM context_grants WHERE id=$1 FOR UPDATE`, p["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["subject_id"] != a.SubjectID || prior["consent_id"] != input["consentId"] || prior["payload_hash"] != identity.Digest([]byte(payload)) || prior["revoked_at"] != nil {
				return nil, fault.New("context_conflict", 409)
			}
			return Object{"grantId": p["id"], "state": "recorded"}, nil
		}
		var count int64
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM context_grants WHERE assistance_id=$1`, p["assistanceId"]).Scan(&count); e != nil {
			return nil, e
		}
		if count >= 64 {
			return nil, fault.New("context_grant_limit", 413)
		}
		if _, e = tx.Exec(ctx, `INSERT INTO context_grants(id,assistance_id,subject_id,participant_id,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7)`, p["id"], p["assistanceId"], a.SubjectID, p["participantId"], input["consentId"], payload, identity.Digest([]byte(payload))); e != nil {
			return nil, e
		}
		if e = s.auditWrite(ctx, tx, a, auth, text(p, "id"), "context.create", requestID, false); e != nil {
			return nil, e
		}
		return Object{"grantId": p["id"], "state": "recorded"}, nil
	})
}
func (s *Service) liveV1(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, Object, error) {
	candidate, e := row(ctx, tx, `SELECT `+legacyGrantColumns+` FROM context_grants WHERE id=$1 AND (subject_id=$2 OR participant_id=$2)`, id, a.SubjectID)
	if e != nil {
		return nil, nil, e
	}
	if candidate == nil {
		return nil, nil, fault.New("not_found", 404)
	}
	parsed, e := parseGrant(text(candidate, "payload_text"), false)
	if e != nil {
		return nil, nil, e
	}
	p := parsed.Values()
	if _, e = s.active(ctx, tx, p); e != nil {
		return nil, nil, e
	}
	r, e := row(ctx, tx, `SELECT `+legacyGrantColumns+` FROM context_grants WHERE id=$1 FOR UPDATE`, id)
	if e != nil {
		return nil, nil, e
	}
	if r["revoked_at"] != nil || number(p, "expiresAt") <= s.now() {
		return nil, nil, fault.New("context_unavailable", 403)
	}
	if _, e = s.consent(ctx, tx, text(r, "subject_id"), text(r, "consent_id"), id, text(r, "payload_text")); e != nil {
		return nil, nil, e
	}
	return r, p, nil
}
func (s *Service) AcceptV1(ctx context.Context, a deviceauth.Actor, id string, raw []byte, requestID string) (Object, error) {
	input, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	payload := text(input, "payloadJson")
	parsed, e := parseEvent(payload, false)
	if e != nil {
		return nil, e
	}
	p := parsed.Values()
	if p["grantId"] != id {
		return nil, fault.New("context_target_mismatch", 400)
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		r, source, e := s.liveV1(ctx, tx, a, id)
		if e != nil {
			return nil, e
		}
		if a.SubjectID != r["participant_id"] || p["assistanceId"] != source["assistanceId"] || p["scopeEventId"] != source["scopeEventId"] || p["materialsHash"] != identity.Digest(encode(source["materials"])) {
			return nil, fault.New("context_acceptance_mismatch", 403)
		}
		g, e := s.consent(ctx, tx, a.SubjectID, text(input, "consentId"), text(p, "id"), payload)
		if e != nil {
			return nil, e
		}
		if e = privateRecipient(g, text(r, "subject_id")); e != nil {
			return nil, e
		}
		prior, e := row(ctx, tx, `SELECT `+legacyAcceptanceColumns+` FROM context_acceptances WHERE grant_id=$1`, id)
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["id"] != p["id"] || prior["consent_id"] != input["consentId"] || prior["payload_hash"] != identity.Digest([]byte(payload)) {
				return nil, fault.New("context_acceptance_conflict", 409)
			}
		} else {
			if _, e = tx.Exec(ctx, `INSERT INTO context_acceptances(id,grant_id,subject_id,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6)`, p["id"], id, a.SubjectID, input["consentId"], payload, identity.Digest([]byte(payload))); e != nil {
				return nil, e
			}
			if e = s.auditWrite(ctx, tx, a, auth, text(p, "id"), "context.accept", requestID, false); e != nil {
				return nil, e
			}
		}
		return Object{"grantId": id, "eventId": p["id"], "state": "accepted"}, nil
	})
}
func (s *Service) ReadV1Within(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string, includeContent bool, auth deviceauth.ControlAuthorization, readKind, requestID string) (Object, error) {
	r, p, e := s.liveV1(ctx, tx, a, id)
	if e != nil {
		return nil, e
	}
	acceptance, e := row(ctx, tx, `SELECT `+legacyAcceptanceColumns+` FROM context_acceptances WHERE grant_id=$1`, id)
	if e != nil {
		return nil, e
	}
	if acceptance != nil {
		if _, e = s.consent(ctx, tx, text(acceptance, "subject_id"), text(acceptance, "consent_id"), text(acceptance, "id"), text(acceptance, "payload_text")); e != nil {
			return nil, e
		}
	}
	canRead := a.SubjectID == r["subject_id"] || acceptance != nil
	if includeContent {
		action := "context.metadata.read"
		switch {
		case readKind == "inspect":
			action = "context.export.inspect"
		case readKind == "export":
			action = "context.export.read"
		case canRead:
			action = "context.read"
		}
		consent := text(r, "consent_id")
		if a.SubjectID != r["subject_id"] && acceptance != nil {
			consent = text(acceptance, "consent_id")
		}
		if e = s.auditRead(ctx, tx, a, auth, id, action, consent, requestID); e != nil {
			return nil, e
		}
	}
	out := Object{"grantId": id}
	for k, v := range p {
		if k != "materials" {
			out[k] = v
		}
	}
	out["ownerId"] = r["subject_id"]
	state := "pending"
	if acceptance != nil {
		state = "accepted"
	}
	materials := []any{}
	for _, v := range list(p["materials"]) {
		m := obj(v)
		item := build("id", m["id"], "label", m["label"], "mediaType", m["mediaType"])
		if canRead && includeContent {
			item.Set("content", m["content"])
		}
		item.Set("contentHash", identity.Digest([]byte(text(m, "content"))))
		materials = append(materials, item)
	}
	out["state"] = state
	out["materialsHash"] = identity.Digest(encode(p["materials"]))
	out["materials"] = materials
	out["contextAccessGranted"] = canRead && includeContent
	out["capabilityVerified"] = false
	return out, nil
}
func (s *Service) GetV1(ctx context.Context, a deviceauth.Actor, id, requestID string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, fault.New("not_found", 404)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		return s.ReadV1Within(ctx, tx, a, id, true, auth, "direct", requestID)
	})
}
func (s *Service) QueryV1(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	p, e := parseQuery(raw, "query", false)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		rows, e := query(ctx, tx, `SELECT id::text FROM context_grants WHERE assistance_id=$1 AND (subject_id=$2 OR participant_id=$2) AND revoked_at IS NULL ORDER BY id LIMIT 64`, p["assistanceId"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, r := range rows {
			v, e := s.ReadV1Within(ctx, tx, a, text(r, "id"), false, deviceauth.ControlAuthorization{}, "direct", "")
			if e != nil {
				if one(fault.Code(e), "context_unavailable", "context_collaboration_changed", "consent_required", "assistance_case_unavailable") {
					continue
				}
				return nil, e
			}
			items = append(items, v)
		}
		if e = s.auditRead(ctx, tx, a, auth, text(p, "assistanceId"), "context.query", "", requestID); e != nil {
			return nil, e
		}
		return Object{"items": items}, nil
	})
}
func (s *Service) RevokeV1(ctx context.Context, a deviceauth.Actor, id, requestID string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, fault.New("not_found", 404)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		r, e := row(ctx, tx, `SELECT `+legacyGrantColumns+` FROM context_grants WHERE id=$1 AND subject_id=$2 FOR UPDATE`, id, a.SubjectID)
		if e != nil {
			return nil, e
		}
		if r == nil {
			return nil, fault.New("not_found", 404)
		}
		if r["revoked_at"] == nil {
			if _, e = tx.Exec(ctx, `UPDATE context_grants SET revoked_at=$2 WHERE id=$1`, id, s.at()); e != nil {
				return nil, e
			}
			if e = s.auditWrite(ctx, tx, a, auth, id, "context.revoke", requestID, false); e != nil {
				return nil, e
			}
		}
		return Object{"grantId": id, "state": "revoked"}, nil
	})
}
func (s *Service) ReceiptV1(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseQuery(raw, "receipt", false)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		table := "context_grants"
		if p["kind"] == "accept" {
			table = "context_acceptances"
		}
		key := "id"
		if p["kind"] == "accept" {
			key = "grant_id"
		}
		r, e := row(ctx, tx, `SELECT id::text,subject_id,consent_id::text,payload_hash FROM `+table+` WHERE `+key+`=$1`, p["grantId"])
		if e != nil {
			return nil, e
		}
		if r != nil && r["subject_id"] != a.SubjectID {
			return nil, fault.New("not_found", 404)
		}
		matched := r != nil && r["id"] == p["eventId"] && r["payload_hash"] == p["payloadHash"]
		state := "absent"
		if r != nil {
			state = "conflict"
		}
		if matched {
			state = "acknowledged"
		}
		out := Object{}
		for k, v := range p {
			out[k] = v
		}
		out["state"], out["checkedAt"], out["authority"] = state, s.now(), "accepted-event-only; no current material access"
		if matched {
			out["consentId"] = r["consent_id"]
		}
		return out, nil
	})
}
