package taskmaterials

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/jackc/pgx/v5"
)

func (s *Service) legacyInsert(ctx context.Context, tx pgx.Tx, a Actor, auth deviceauth.ControlAuthorization, assistanceID, eventID string, version int64, input Envelope) error {
	if _, e := tx.Exec(ctx, `INSERT INTO assistance_events(id,assistance_id,subject_id,version,consent_id,payload_text,payload_hash)VALUES($1,$2,$3,$4,$5,$6,$7)`, eventID, assistanceID, a.SubjectID, version, input.ConsentID, input.PayloadJSON, identity.Digest([]byte(input.PayloadJSON))); e != nil {
		return e
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)SELECT $1,'assistance.event',$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'assistance',c.id,b.id,$3,$2::text,b.scopes,$4::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$5::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=(SELECT consent_id FROM assistance_events WHERE id=$2::text::uuid AND subject_id=$1)AND c.subject_id=$1 AND b.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action='assistance.event'AND object_id=$2::text)`, a.SubjectID, eventID, a.HTTPRequestID, jsonBytes(auth.CredentialScopes), a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var count int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE actor=$1 AND action='assistance.event'AND object_id=$2", a.SubjectID, eventID).Scan(&count); e != nil {
		return e
	}
	if count != 1 {
		return fail("assistance_audit_context_unavailable", 503)
	}
	return nil
}
func (s *Service) CreateLegacy(ctx context.Context, a Actor, input Envelope) (any, error) {
	request, e := parseLegacyRequest(input.PayloadJSON)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, "assistance", true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if e := s.CaseLiveWithin(ctx, tx, a, str(request, "caseId")); e != nil {
			return nil, e
		}
		grant, e := s.legacyGrant(ctx, tx, a.SubjectID, input.ConsentID, str(request, "id"), input.PayloadJSON)
		if e != nil {
			return nil, e
		}
		if grant.Visibility != request["visibility"] {
			return nil, fail("assistance_visibility_mismatch", 403)
		}
		current, e := row(ctx, tx, "SELECT to_jsonb(a) FROM assistance_requests a WHERE id=$1 FOR UPDATE", request["id"])
		if e != nil {
			return nil, e
		}
		receipt := Object{"assistanceId": request["id"], "eventId": request["id"], "version": 1}
		if current != nil {
			root, e := row(ctx, tx, "SELECT to_jsonb(e) FROM assistance_events e WHERE id=$1", request["id"])
			if e != nil {
				return nil, e
			}
			if current["requester_id"] != a.SubjectID || current["case_id"] != request["caseId"] || root == nil || root["payload_hash"] != identity.Digest([]byte(input.PayloadJSON)) || root["consent_id"] != input.ConsentID {
				return nil, fail("assistance_conflict")
			}
			return receipt, nil
		}
		other, e := row(ctx, tx, "SELECT jsonb_build_object('id',id)FROM task_requests WHERE id=$1 FOR SHARE", request["id"])
		if e != nil {
			return nil, e
		}
		if other != nil {
			return nil, fail("unsupported_semantics")
		}
		if request["qualification"] != nil {
			if s.ValidateQualification == nil {
				return nil, fail("qualification_unavailable", 503)
			}
			if e = s.ValidateQualification(ctx, tx, obj(request, "qualification"), str(request, "capabilityId"), str(request, "collaboration")); e != nil {
				return nil, e
			}
		}
		state, e := createLegacyAssistance(a.SubjectID, request, s.now())
		if e != nil {
			return nil, e
		}
		if request["visibility"] == "Public" {
			if s.Writes == nil {
				return nil, fail("public_write_verification_unavailable", 503)
			}
			if _, e = s.Writes.ConsumeWithin(ctx, tx, publicwrites.Actor{Device: &a.Actor, Scope: "assistance"}, publicwrites.Operation{Kind: "task", OperationID: str(request, "id"), PayloadHash: identity.Digest([]byte(input.PayloadJSON)), TaskID: str(request, "id")}); e != nil {
				return nil, e
			}
		}
		if _, e = tx.Exec(ctx, `INSERT INTO assistance_requests(id,case_id,requester_id,version,snapshot)VALUES($1,$2,$3,1,$4::jsonb)ON CONFLICT(id)DO NOTHING`, request["id"], request["caseId"], a.SubjectID, jsonBytes(state)); e != nil {
			return nil, e
		}
		current, e = row(ctx, tx, "SELECT to_jsonb(a) FROM assistance_requests a WHERE id=$1 FOR UPDATE", request["id"])
		if e != nil {
			return nil, e
		}
		prior, e := row(ctx, tx, "SELECT to_jsonb(e) FROM assistance_events e WHERE id=$1", request["id"])
		if e != nil {
			return nil, e
		}
		if current["requester_id"] != a.SubjectID || current["case_id"] != request["caseId"] {
			return nil, fail("assistance_conflict")
		}
		if prior != nil {
			if prior["payload_hash"] != identity.Digest([]byte(input.PayloadJSON)) || prior["consent_id"] != input.ConsentID {
				return nil, fail("assistance_conflict")
			}
		} else if e = s.legacyInsert(ctx, tx, a, auth, str(request, "id"), str(request, "id"), 1, input); e != nil {
			return nil, e
		}
		return receipt, nil
	})
}
func (s *Service) SubmitLegacy(ctx context.Context, a Actor, id string, input Envelope) (any, error) {
	data, e := parseLegacyEvent(input.PayloadJSON)
	if e != nil {
		return nil, e
	}
	if data["assistanceId"] != id {
		return nil, fail("assistance_target_mismatch", 400)
	}
	event := obj(data, "event")
	kind := str(event, "kind")
	return s.run(ctx, a, "assistance", true, contains([]string{"cancel", "withdraw-offer", "expire", "dispute"}, kind), func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		loaded, e := s.LegacyLoadWithin(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		if !s.visible(loaded.Grants[id], a.SubjectID) {
			return nil, fail("not_found", 404)
		}
		if loaded.Paused && kind != "cancel" {
			return nil, fail("assistance_paused", 403)
		}
		grant, e := s.legacyGrant(ctx, tx, a.SubjectID, input.ConsentID, str(event, "id"), input.PayloadJSON)
		if e != nil {
			return nil, e
		}
		prior, e := row(ctx, tx, "SELECT to_jsonb(e) FROM assistance_events e WHERE id=$1", event["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["assistance_id"] != id || prior["subject_id"] != a.SubjectID || prior["consent_id"] != input.ConsentID || prior["payload_hash"] != identity.Digest([]byte(input.PayloadJSON)) {
				return nil, fail("assistance_event_conflict")
			}
			return Object{"assistanceId": id, "eventId": event["id"], "version": prior["version"]}, nil
		}
		if kind == "invite" {
			var exists bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM subjects WHERE id=$1)", event["participantId"]).Scan(&exists); e != nil {
				return nil, e
			}
			if !exists || !s.visible(loaded.Grants[id], str(event, "participantId")) {
				return nil, fail("invitation_recipient_unavailable", 403)
			}
		}
		previous := obj(loaded.Row, "snapshot")
		state, e := applyLegacyAssistance(previous, a.SubjectID, event, s.now())
		if e != nil {
			return nil, e
		}
		request := obj(previous, "request")
		if request["qualification"] != nil && contains([]string{"select", "confirm"}, kind) {
			if s.LegacyQualification == nil {
				return nil, fail("qualification_unavailable", 503)
			}
			selected := obj(state, "selected")
			offer := findObject(state["offers"], "id", selected["offerId"])
			evidence := offer["qualificationEvidence"]
			if evidence == nil {
				evidence = Object{"proofIds": []any{}, "assistanceIds": []any{}}
			}
			query := clone(obj(request, "qualification"))
			query["capabilityId"], query["subjectId"], query["evidence"] = request["capabilityId"], selected["providerId"], evidence
			evaluation, e := s.LegacyQualification(ctx, tx, a, query, str(request, "collaboration"))
			if e != nil {
				return nil, e
			}
			if !truth(evaluation["eligible"]) {
				return nil, fail("qualification_required", 403)
			}
		}
		recipients := []string{str(loaded.Row, "requester_id")}
		if kind == "invite" {
			recipients = append(recipients, str(event, "participantId"))
		}
		if kind != "shortlist" && state["selected"] != nil {
			recipients = append(recipients, str(obj(state, "selected"), "providerId"))
		}
		public := grant.Visibility == "Public" && grant.Purpose == "public-profile" && request["visibility"] == "Public" && contains([]string{"confirm", "change-scope", "confirm-scope", "deliver", "accept", "cancel", "dispute", "propose-resolution", "confirm-resolution", "requester-feedback"}, kind)
		if grant.Visibility != "Private" && !public {
			return nil, fail("assistance_participant_consent_required", 403)
		}
		for _, recipient := range recipients {
			if !s.visible(grant, recipient) {
				return nil, fail("assistance_participant_consent_required", 403)
			}
		}
		if kind == "invite" {
			if s.Writes == nil {
				return nil, fail("public_write_verification_unavailable", 503)
			}
			if _, e = s.Writes.ConsumeWithin(ctx, tx, publicwrites.Actor{Device: &a.Actor, Scope: "assistance"}, publicwrites.Operation{Kind: "invitation", OperationID: str(event, "id"), PayloadHash: identity.Digest([]byte(input.PayloadJSON)), TaskID: id, RecipientID: str(event, "participantId")}); e != nil {
				return nil, e
			}
		}
		if kind == "offer" && s.Writes != nil {
			if e = s.Writes.MarkInvitationRespondedWithin(ctx, tx, publicwrites.Targets{TaskID: id, RecipientID: a.SubjectID}); e != nil {
				return nil, e
			}
		}
		checkReview := func(version int64) error {
			source, e := s.legacyCaseReview(ctx, tx, str(loaded.Row, "case_id"), a.SubjectID)
			if e != nil {
				return e
			}
			if num(source["reviewVersion"]) != version {
				return fail("assistance_case_version_changed")
			}
			return nil
		}
		if kind == "deliver" {
			if value, ok := event["caseReviewVersion"]; ok {
				if e = checkReview(num(value)); e != nil {
					return nil, e
				}
			}
			var attempt bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM case_events WHERE id=$1 AND case_id=$2 AND kind='attempt')", event["attemptId"], loaded.Row["case_id"]).Scan(&attempt); e != nil {
				return nil, e
			}
			if !attempt {
				return nil, fail("assistance_attempt_required")
			}
			for _, evidenceID := range arr(event["evidenceIds"]) {
				var matches bool
				if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM evidence_submissions e JOIN case_events r ON r.id=e.result_id WHERE e.id=$1 AND e.case_id=$2 AND r.payload->>'attemptId'=$3)`, evidenceID, loaded.Row["case_id"], event["attemptId"]).Scan(&matches); e != nil {
					return nil, e
				}
				if !matches {
					return nil, fail("assistance_evidence_mismatch")
				}
			}
		}
		if e = s.legacyInsert(ctx, tx, a, auth, id, str(event, "id"), num(state["version"]), input); e != nil {
			return nil, e
		}
		if kind == "accept" {
			if value, ok := obj(previous, "delivery")["caseReviewVersion"]; ok {
				if e = checkReview(num(value)); e != nil {
					return nil, e
				}
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE assistance_requests SET version=$2,snapshot=$3::jsonb WHERE id=$1", id, num(state["version"]), jsonBytes(state)); e != nil {
			return nil, e
		}
		return Object{"assistanceId": id, "eventId": event["id"], "version": state["version"]}, nil
	})
}
