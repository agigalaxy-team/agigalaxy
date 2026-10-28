package targetgovernance

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
	var envelope Object
	if protocol.Decode(raw, &envelope) != nil || envelope == nil || !strict(envelope, "consentId", "payloadJson") {
		return nil, "", "", invalid()
	}
	payload, ok := envelope["payloadJson"].(string)
	if !ok || len([]byte(payload)) > 10000 || !opportunities.UUID.MatchString(str(envelope, "consentId")) {
		return nil, "", "", invalid()
	}
	x, e := ParsePayload([]byte(payload), report)
	return x, str(envelope, "consentId"), payload, e
}
func (s *Service) privateAudience(g deviceauth.ConsentIntent, a Actor, allowed, required []string) error {
	if g.Visibility != "Private" {
		return fail("target_governance_audience_mismatch", 403)
	}
	for _, id := range g.Viewers {
		if id != a.Device.SubjectID && !has(allowed, id) {
			return fail("target_governance_audience_mismatch", 403)
		}
	}
	for _, id := range required {
		if id != a.Device.SubjectID && !has(g.Viewers, id) {
			return fail("target_governance_audience_mismatch", 403)
		}
	}
	return nil
}
func (s *Service) save(ctx context.Context, tx pgx.Tx, a Actor, current deviceauth.ControlAuthorization, x Object, reportID, consent, payload, kind string, version int64) (Object, error) {
	_, e := tx.Exec(ctx, "INSERT INTO target_governance_events_v2(id,report_id,subject_id,version,kind,consent_id,payload_text,payload_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", x["id"], reportID, a.Device.SubjectID, version, kind, consent, payload, identity.Digest([]byte(payload)), stamp(s.now()))
	if e != nil {
		return nil, e
	}
	if !has(current.CredentialScopes, "moderation") || a.Device.BindingID == "" {
		return nil, fmt.Errorf("governance audit authorization required")
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'moderation',c.id,b.id,$4,$2::text,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM target_governance_events_v2 e JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE e.id=$2::uuid AND e.subject_id=$1 AND c.subject_id=$1 AND b.subject_id=$1`, a.Device.SubjectID, x["id"], "target.moderation."+kind, nullable(a.RequestID), encode(current.CredentialScopes), a.Device.BindingID)
	if e != nil {
		return nil, e
	}
	if tag.RowsAffected() != 1 {
		return nil, fmt.Errorf("governance event audit unavailable")
	}
	return s.receiptWithin(ctx, tx, a, Object{"eventId": x["id"], "payloadHash": identity.Digest([]byte(payload))})
}
func (s *Service) Report(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, consent, payload, e := parseEnvelope(raw, true)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx, current deviceauth.ControlAuthorization) (Object, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "target-governance:"+str(x, "id")); e != nil {
			return nil, e
		}
		old, e := s.replay(ctx, tx, a, str(x, "id"), consent, payload)
		if e != nil || old != nil {
			return old, e
		}
		src, e := s.source(ctx, tx, a.Device, obj(x, "target"), true, true)
		if e != nil {
			return nil, e
		}
		target := obj(src, "target")
		if num(target, "version") != num(obj(x, "target"), "version") || target["type"] == "task" && target["rootEventId"] != obj(x, "target")["rootEventId"] {
			return nil, fail("target_version_changed", 409)
		}
		if !truth(src, "sourceAvailable") {
			return nil, fail("target_unavailable", 404)
		}
		g, e := s.grant(ctx, tx, Object{"id": x["id"], "consent_id": consent, "subject_id": a.Device.SubjectID, "payload_text": payload})
		if e != nil {
			return nil, e
		}
		if e = s.privateAudience(g, a, s.ModeratorIDs, nil); e != nil {
			return nil, e
		}
		if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
			return nil, fail("target_governance_author_unavailable", 403)
		}
		column := "task_id"
		var task, room any
		if target["type"] == "room" {
			column = "room_id"
			room = target["id"]
		} else {
			task = target["id"]
		}
		var count int
		if e = tx.QueryRow(ctx, "SELECT count(*)::int FROM target_reports_v2 WHERE subject_id=$1 AND "+column+"=$2 AND closed_at IS NULL", a.Device.SubjectID, target["id"]).Scan(&count); e != nil {
			return nil, e
		}
		if count >= 3 {
			return nil, fail("target_report_limit", 429)
		}
		_, e = tx.Exec(ctx, "INSERT INTO target_reports_v2(id,subject_id,target_type,task_id,room_id,target_version,root_event_id,party_ids,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)", x["id"], a.Device.SubjectID, target["type"], task, room, target["version"], target["rootEventId"], encode(unique(append([]string{a.Device.SubjectID}, stringsOf(src["parties"])...))), stamp(s.now()))
		if e != nil {
			return nil, e
		}
		return s.save(ctx, tx, a, current, x, str(x, "id"), consent, payload, "report", 1)
	})
}
func (s *Service) validateRestriction(r, x Object, maxDays int64) error {
	allowed := []string{"discovery-hidden", "new-participation-paused"}
	if r["target_type"] == "room" {
		allowed = []string{"sending-paused", "invitations-paused"}
	}
	for _, scope := range stringsOf(x["scopes"]) {
		if !has(allowed, scope) {
			return fail("invalid_target_restriction", 400)
		}
	}
	if num(x, "until") <= s.now() || num(x, "until") > s.now()+maxDays*86400 {
		return fail("invalid_target_restriction", 400)
	}
	return nil
}
func (s *Service) Event(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, consent, payload, e := parseEnvelope(raw, false)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, true, func(tx pgx.Tx, current deviceauth.ControlAuthorization) (Object, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "target-governance:"+str(x, "id")); e != nil {
			return nil, e
		}
		old, e := s.replay(ctx, tx, a, str(x, "id"), consent, payload)
		if e != nil || old != nil {
			return old, e
		}
		initial, e := s.load(ctx, tx, str(x, "reportId"), false)
		if e != nil {
			return nil, e
		}
		if initial == nil {
			return nil, fail("not_found", 404)
		}
		src, e := s.source(ctx, tx, nil, s.target(initial), false, true)
		if e != nil && !missing(e) {
			return nil, e
		}
		r, e := s.load(ctx, tx, str(x, "reportId"), true)
		if e != nil {
			return nil, e
		}
		parties, events, e := s.visible(ctx, tx, a, r)
		if e != nil {
			return nil, e
		}
		if num(r, "version") != num(x, "expectedVersion") {
			return nil, fail("target_governance_version_changed", 409)
		}
		kind := str(x, "kind")
		decision := has([]string{"review", "pause", "resume", "resolve"}, kind)
		independent, e := s.independent(ctx, tx, a, parties)
		if e != nil {
			return nil, e
		}
		if decision && !independent {
			return nil, fail("target_independent_handler_required", 403)
		}
		if !decision && !has(parties, a.Device.SubjectID) {
			return nil, fail("target_governance_party_required", 403)
		}
		complaint := false
		for _, event := range events {
			k := str(event, "kind")
			if k == "" {
				k = "report"
			}
			complaint = complaint || has([]string{"report", "supplement", "appeal"}, k)
		}
		if decision && kind != "resume" && !complaint {
			return nil, fail("target_report_material_unavailable", 403)
		}
		if has([]string{"pause", "resolve"}, kind) && (num(obj(src, "target"), "version") != num(x, "targetVersion") || !truth(src, "sourceAvailable")) {
			return nil, fail("target_version_or_source_unavailable", 409)
		}
		g, e := s.grant(ctx, tx, Object{"id": x["id"], "consent_id": consent, "subject_id": a.Device.SubjectID, "payload_text": payload})
		if e != nil {
			return nil, e
		}
		required := []string{}
		if decision {
			required = []string{str(r, "subject_id")}
		}
		if e = s.privateAudience(g, a, unique(append(append([]string{}, s.ModeratorIDs...), parties...)), required); e != nil {
			return nil, e
		}
		if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
			return nil, fail("target_governance_author_unavailable", 403)
		}
		state := str(r, "state")
		closed, until, scopes, restrictionEvent, decisionEvent := r["closed_at"], r["restriction_until"], r["restriction_scopes"], r["restriction_event_id"], r["decision_event_id"]
		appeals := num(r, "appeal_count")
		if closed != nil && seconds(closed) <= s.now()-180*86400 {
			return nil, fail("target_governance_expired", 410)
		}
		if num(r, "version") >= 100 && !has([]string{"resume", "withdraw-report"}, kind) {
			return nil, fail("target_governance_event_limit", 429)
		}
		switch kind {
		case "review":
			if !has([]string{"received", "appealed", "reviewing"}, state) {
				return nil, fail("target_governance_state", 409)
			}
			state = "reviewing"
		case "pause":
			if has([]string{"withdrawn", "resolved"}, state) {
				return nil, fail("target_governance_state", 409)
			}
			if e = s.validateRestriction(r, x, 7); e != nil {
				return nil, e
			}
			until, scopes, restrictionEvent = stamp(num(x, "until")), x["scopes"], x["id"]
		case "resume":
			until, scopes, restrictionEvent = nil, []string{}, x["id"]
		case "resolve":
			if has([]string{"withdrawn", "resolved"}, state) {
				return nil, fail("target_governance_state", 409)
			}
			restriction := obj(x, "restriction")
			if x["verdict"] == "dismissed" && restriction != nil {
				return nil, fail("dismissed_cannot_restrict", 400)
			}
			until, scopes = nil, []string{}
			if restriction != nil {
				if e = s.validateRestriction(r, restriction, 30); e != nil {
					return nil, e
				}
				until, scopes = stamp(num(restriction, "until")), restriction["scopes"]
			}
			restrictionEvent, decisionEvent, state, closed = x["id"], x["id"], "resolved", stamp(s.now())
		case "appeal":
			effective := until != nil && seconds(until) > s.now()
			if state != "resolved" && !effective || appeals >= 3 {
				return nil, fail("target_governance_state", 409)
			}
			state, closed, appeals = "appealed", nil, appeals+1
		case "withdraw-report":
			if a.Device.SubjectID != r["subject_id"] || state == "withdrawn" {
				return nil, fail("target_governance_state", 409)
			}
			state, closed = "withdrawn", stamp(s.now())
		case "supplement":
			if state == "withdrawn" {
				return nil, fail("target_governance_state", 409)
			}
		}
		receipt, e := s.save(ctx, tx, a, current, x, str(r, "id"), consent, payload, kind, num(r, "version")+1)
		if e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, "UPDATE target_reports_v2 SET version=$2,state=$3,closed_at=$4,appeal_count=$5,restriction_until=$6,restriction_scopes=$7::jsonb,restriction_event_id=$8,decision_event_id=$9 WHERE id=$1", r["id"], num(r, "version")+1, state, closed, appeals, until, encode(scopes), restrictionEvent, decisionEvent)
		return receipt, e
	})
}
