package moderation

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func parseEnvelope(raw []byte, report bool) (Object, string, string, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil || !strict(q, "consentId", "payloadJson") || !opportunities.UUID.MatchString(str(q, "consentId")) {
		return nil, "", "", invalid()
	}
	payload, ok := q["payloadJson"].(string)
	if !ok {
		return nil, "", "", invalid()
	}
	x, e := ParsePayload([]byte(payload), report)
	return x, str(q, "consentId"), payload, e
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a Actor, id, action string, current deviceauth.ControlAuthorization, report bool) error {
	table, subject := "moderation_events", "subject_id"
	if report {
		table, subject = "moderation_reports", "reporter_id"
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'moderation',c.id,b.id,$4,$2::text,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM `+table+` e JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE e.id=$2::uuid AND e.`+subject+`=$1 AND c.subject_id=$1 AND b.subject_id=$1`, a.Device.SubjectID, id, action, nullable(a.RequestID), encode(current.CredentialScopes), a.Device.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("moderation audit context unavailable")
	}
	return nil
}
func (s *Service) Report(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, consent, payload, e := parseEnvelope(raw, true)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx, current deviceauth.ControlAuthorization) (Object, error) {
		if len(s.ModeratorIDs) == 0 {
			return nil, fail("moderation_not_configured", 409)
		}
		var target string
		participants := []string{}
		if x["caseId"] != nil {
			source, e := s.caseSource(ctx, tx, a.Device.SubjectID, str(x, "caseId"), true)
			if e != nil {
				return nil, e
			}
			parent := obj(source, "parent")
			target = str(parent, "id")
			participants = append(participants, str(parent, "subject_id"))
			found := false
			for _, event := range objectsOf(source["rows"]) {
				found = found || event["id"] == x["targetEventId"] && num(event, "version") <= num(x, "caseVersion")
			}
			if !found {
				return nil, fail("moderation_case_event_mismatch", 409)
			}
			prior, e := row(ctx, tx, "SELECT to_jsonb(r) FROM moderation_reports r WHERE id=$1", x["id"])
			if e != nil {
				return nil, e
			}
			if prior == nil && num(parent, "version") != num(x, "caseVersion") {
				return nil, fail("moderation_case_version_conflict", 409)
			}
			if x["evidenceId"] != nil {
				if _, e = s.evidenceTarget(ctx, tx, a.Device.SubjectID, str(x, "caseId"), str(x, "targetEventId"), str(x, "evidenceId")); e != nil {
					return nil, e
				}
			}
		} else {
			if s.Assistance == nil {
				return nil, fail("moderation_assistance_unavailable", 503)
			}
			source, e := s.Assistance.LegacyLoadWithin(ctx, tx, str(x, "assistanceId"), false)
			if e != nil {
				return nil, e
			}
			if !s.Assistance.LegacySourceVisible(source.Grants[str(source.Row, "id")], a.Device.SubjectID) {
				return nil, fail("not_found", 404)
			}
			target = str(source.Row, "id")
			participants = append(participants, str(source.Row, "requester_id"))
			if selected := obj(obj(source.Row, "snapshot"), "selected"); selected != nil {
				participants = append(participants, str(selected, "providerId"))
			}
		}
		g, e := s.grant(ctx, tx, a.Device.SubjectID, consent, str(x, "id"), payload)
		if e != nil {
			return nil, e
		}
		if e = s.checkRecipients(g, a.Device.SubjectID, s.ModeratorIDs); e != nil {
			return nil, e
		}
		prior, e := row(ctx, tx, "SELECT to_jsonb(r) FROM moderation_reports r WHERE id=$1", x["id"])
		if e != nil {
			return nil, e
		}
		receipt := Object{"reportId": x["id"], "eventId": x["id"], "version": 1}
		if prior != nil {
			if prior["reporter_id"] != a.Device.SubjectID || prior["consent_id"] != consent || prior["payload_hash"] != identity.Digest([]byte(payload)) {
				return nil, fail("moderation_conflict", 409)
			}
			return receipt, nil
		}
		column := "assistance_id"
		if x["caseId"] != nil {
			column = "case_id"
		}
		var count int
		if e = tx.QueryRow(ctx, "SELECT count(*) FROM moderation_reports WHERE "+column+"=$1 AND reporter_id=$2", target, a.Device.SubjectID).Scan(&count); e != nil {
			return nil, e
		}
		if count >= 3 {
			return nil, fail("moderation_report_limit", 429)
		}
		if _, e = tx.Exec(ctx, "INSERT INTO moderation_reports(id,assistance_id,reporter_id,participant_ids,consent_id,payload_text,payload_hash,case_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", x["id"], x["assistanceId"], a.Device.SubjectID, encode(participants), consent, payload, identity.Digest([]byte(payload)), x["caseId"]); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, str(x, "id"), "moderation.report", current, true); e != nil {
			return nil, e
		}
		return receipt, nil
	})
}
func (s *Service) Event(ctx context.Context, a Actor, id string, raw []byte) (Object, error) {
	x, consent, payload, e := parseEnvelope(raw, false)
	if e != nil {
		return nil, e
	}
	if x["reportId"] != id {
		return nil, fail("moderation_target_mismatch", 409)
	}
	return s.run(ctx, a, true, true, func(tx pgx.Tx, current deviceauth.ControlAuthorization) (Object, error) {
		found, e := s.load(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		if found == nil || !s.allowed(a.Device.SubjectID, found) {
			return nil, fail("not_found", 404)
		}
		table, key := "assistance_requests", found["assistance_id"]
		if found["case_id"] != nil {
			table, key = "cases", found["case_id"]
		}
		if _, e = tx.Exec(ctx, "SELECT id FROM "+table+" WHERE id=$1 FOR UPDATE", key); e != nil {
			return nil, e
		}
		r, e := s.load(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		ps := parties(r)
		g, e := s.grant(ctx, tx, a.Device.SubjectID, consent, str(x, "id"), payload)
		if e != nil {
			return nil, e
		}
		previous, e := row(ctx, tx, "SELECT to_jsonb(e) FROM moderation_events e WHERE id=$1", x["id"])
		if e != nil {
			return nil, e
		}
		if previous != nil {
			if previous["report_id"] != id || previous["subject_id"] != a.Device.SubjectID || previous["consent_id"] != consent || previous["payload_hash"] != identity.Digest([]byte(payload)) {
				return nil, fail("moderation_conflict", 409)
			}
			return Object{"reportId": id, "eventId": x["id"], "version": previous["version"]}, nil
		}
		kind := str(x, "kind")
		appeal, statement, isVerifier := kind == "appeal", has([]string{"supplement", "correct"}, kind), has(verifierKinds, kind)
		party, independent := has(ps, a.Device.SubjectID), s.independent(a.Device.SubjectID, r)
		if isVerifier {
			if e = verifierTransition(r, a.Device.SubjectID, x, s.now(), independent); e != nil {
				return nil, e
			}
			if kind == "invite-verifier" {
				reported, e := s.grant(ctx, tx, str(r, "reporter_id"), str(r, "consent_id"), str(r, "id"), str(r, "payload_text"))
				if e != nil {
					return nil, e
				}
				if !s.visible(reported, a.Device.SubjectID) {
					return nil, fail("not_found", 404)
				}
				if num(x, "expiresAt") > g.ExpiresAt {
					return nil, fail("verifier_invitation_expiry", 409)
				}
				if e = s.verifierSource(ctx, tx, r, a.Device.SubjectID, nil); e != nil {
					return nil, e
				}
			}
			if has([]string{"accept-verifier", "verification-response"}, kind) {
				if _, e = s.liveInvitation(ctx, tx, r, a.Device.SubjectID, str(x, "invitationId")); e != nil {
					return nil, e
				}
			}
			if kind == "verification-response" {
				if e = s.verifierSource(ctx, tx, r, a.Device.SubjectID, nil); e != nil {
					return nil, e
				}
			}
		} else if appeal && !party || !appeal && statement && !(party || independent || kind == "correct" && verifier(r, a.Device.SubjectID) != nil) || !appeal && !statement && !independent {
			return nil, fail("moderation_role_denied", 403)
		}
		if kind == "correct" {
			var original Object
			if x["correctsEventId"] == id {
				original = Object{"subject_id": r["reporter_id"]}
			} else {
				original, e = row(ctx, tx, "SELECT to_jsonb(e) FROM (SELECT subject_id FROM moderation_events WHERE id=$1 AND report_id=$2)e", x["correctsEventId"], id)
				if e != nil {
					return nil, e
				}
			}
			if original == nil || original["subject_id"] != a.Device.SubjectID {
				return nil, fail("moderation_correction_denied", 403)
			}
		}
		recipients := s.ModeratorIDs
		if !(appeal || statement && party) {
			recipients = append(append([]string{}, s.ModeratorIDs...), ps...)
			if kind == "invite-verifier" {
				recipients = append(recipients, str(x, "verifierId"))
			}
		}
		if e = s.checkRecipients(g, a.Device.SubjectID, recipients); e != nil {
			return nil, e
		}
		if num(r, "version") != num(x, "expectedVersion") {
			return nil, fail("moderation_version_conflict", 409)
		}
		var verificationJob Object
		if kind == "revalidate" {
			verificationJob, e = s.prepareRevalidation(ctx, tx, a, r, x, consent)
			if e != nil {
				return nil, e
			}
		}
		state, paused, appeals := str(r, "state"), truth(r, "paused"), num(r, "appeal_count")
		switch kind {
		case "pause":
			if paused {
				return nil, fail("moderation_transition_denied", 409)
			}
			paused = true
		case "resume":
			if !paused {
				return nil, fail("moderation_transition_denied", 409)
			}
			paused = false
		case "resolve":
			if state == "resolved" {
				return nil, fail("moderation_transition_denied", 409)
			}
			state = "resolved"
		case "appeal":
			if state != "resolved" || appeals >= 3 {
				return nil, fail("moderation_transition_denied", 409)
			}
			state = "appealed"
			appeals++
		}
		version := num(r, "version") + 1
		if version > 100 {
			return nil, fail("moderation_event_limit", 413)
		}
		if _, e = tx.Exec(ctx, "INSERT INTO moderation_events(id,report_id,subject_id,consent_id,version,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7)", x["id"], id, a.Device.SubjectID, consent, version, payload, identity.Digest([]byte(payload))); e != nil {
			return nil, e
		}
		if verificationJob != nil {
			if e = s.enqueueRevalidation(ctx, tx, verificationJob); e != nil {
				return nil, e
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE moderation_reports SET version=$2,state=$3,paused=$4,appeal_count=$5 WHERE id=$1", id, version, state, paused, appeals); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, str(x, "id"), "moderation.event", current, false); e != nil {
			return nil, e
		}
		return Object{"reportId": id, "eventId": x["id"], "version": version}, nil
	})
}
