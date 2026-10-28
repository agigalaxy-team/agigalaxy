package verificationrecords

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

func sourceKey(source Object) string {
	return "declared-source:" + identity.Digest(encode([]any{source["originSystem"], source["externalStableId"]}))
}
func (s *Service) writeContext(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, data Object) (Object, error) {
	if str(data, "taskId") != "" && data["kind"] != "revoke" {
		if s.TaskWrite == nil {
			return nil, fault.New("task_service_unavailable", 503)
		}
		task, e := s.TaskWrite(ctx, tx, a, str(data, "taskId"))
		if e != nil {
			return nil, e
		}
		if task["caseId"] != data["caseId"] {
			return nil, fault.New("task_case_link_required", 409)
		}
	}
	context, e := s.CaseWithin(ctx, tx, str(data, "caseId"))
	if e != nil {
		return nil, e
	}
	parent, facts := obj(context["parent"]), obj(context["facts"])
	owner := parent["subject_id"] == a.SubjectID
	if data["kind"] != "revoke" && parent["state"] == "withdrawn" {
		return nil, fault.New("case_unavailable", 409)
	}
	if data["kind"] != "revoke" && (!owner || str(data, "participationId") != "") {
		if str(data, "taskId") == "" || str(data, "participationId") == "" || s.Participation == nil {
			return nil, fault.New("participation_required", 403)
		}
		p, e := s.Participation(ctx, tx, a, str(data, "taskId"), str(data, "participationId"))
		if e != nil {
			return nil, e
		}
		if p["subjectId"] != a.SubjectID {
			return nil, fault.New("participation_required", 403)
		}
		if num(data, "expectedVersion") == 0 {
			if p["paused"] == true || one(p["taskState"], "closed", "canceled") {
				return nil, fault.New("participation_paused", 403)
			}
			if !one(p["state"], "active", "delivered", "accepted", "disputed") {
				return nil, fault.New("participation_required", 403)
			}
			scope := int64(1)
			if _, ok := data["participationScopeVersion"]; ok {
				scope = num(data, "participationScopeVersion")
			}
			if num(p, "scopeVersion") != scope {
				return nil, fault.New("participation_scope_changed", 409)
			}
		}
	}
	if facts["synthetic"] == true && data["synthetic"] != true {
		return nil, fault.New("synthetic_mismatch", 422)
	}
	return context, nil
}
func (s *Service) Submit(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	var request Object
	if protocol.Decode(raw, &request) != nil {
		return nil, fault.New("invalid_verification_record", 400)
	}
	payload, ok := request["payloadJson"].(string)
	if !ok {
		return nil, fault.New("invalid_verification_record", 400)
	}
	data, e := parseRecord(payload)
	if e != nil {
		return nil, e
	}
	if data["reportedBy"] != a.SubjectID {
		return nil, fault.New("reporter_mismatch", 403)
	}
	return s.run(ctx, a, true, data["kind"] == "revoke", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		context, e := s.writeContext(ctx, tx, a, data)
		if e != nil {
			return nil, e
		}
		kind := str(data, "kind")
		objectType := kind
		if kind == "revoke" {
			objectType = str(data, "objectType")
		}
		hash := identity.Digest([]byte(payload))
		consent := str(request, "consentId")
		if _, e = s.require(ctx, tx, deviceauth.ConsentRequirement{ID: consent, SubjectID: a.SubjectID, Action: "evidence.submit", ObjectID: str(data, "operationId"), Recipient: s.Endpoint, PayloadJSON: payload}); e != nil {
			return nil, e
		}
		if num(data, "expectedVersion") == 0 && kind != "revoke" {
			if _, e = tx.Exec(ctx, `INSERT INTO verification_objects(id,object_type,case_id,subject_id,version,state) VALUES($1,$2,$3,$4,0,'active') ON CONFLICT(id) DO NOTHING`, data["id"], objectType, data["caseId"], a.SubjectID); e != nil {
				return nil, e
			}
		}
		o, e := loadObject(ctx, tx, str(data, "id"), "UPDATE")
		if e != nil {
			return nil, e
		}
		if o == nil || o.Subject != a.SubjectID || o.CaseID != str(data, "caseId") || o.Type != objectType {
			return nil, fault.New("record_not_found", 404)
		}
		duplicate, e := loadEvent(ctx, tx, str(data, "operationId"), 0, true)
		if e != nil {
			return nil, e
		}
		if duplicate != nil {
			if duplicate.ObjectID != o.ID || duplicate.Hash != hash || duplicate.ConsentID != consent {
				return nil, fault.New("record_conflict", 409)
			}
			receipt := receiptView(o, duplicate)
			if duplicate.Payload["kind"] == "verification" {
				current, e := s.ReadWithin(ctx, tx, &a, Object{"type": objectType, "id": o.ID, "version": duplicate.Version})
				if e != nil {
					return nil, e
				}
				if current["record"] == nil {
					reason := str(current, "reason")
					if reason == "" {
						reason = "evidence_reference_unavailable"
					}
					return nil, fault.New(reason, 409)
				}
				receipt["synthetic"] = current["synthetic"]
			}
			return receipt, nil
		}
		if o.Version != num(data, "expectedVersion") {
			return nil, fault.New("record_version_changed", 409)
		}
		if o.State != "active" {
			return nil, fault.New("record_revoked", 409)
		}
		if o.Version > 0 && str(data, "reason") == "" {
			return nil, fault.New("correction_reason_required", 422)
		}
		var previous *recordEvent
		if o.Version > 0 {
			previous, e = loadEvent(ctx, tx, o.ID, o.Version, false)
			if e != nil {
				return nil, e
			}
		}
		if previous != nil && previous.Context["synthetic"] == true && data["synthetic"] != true {
			return nil, fault.New("synthetic_mismatch", 422)
		}
		if previous != nil && previous.Payload["kind"] == "verification" && kind == "verification" && data["synthetic"] != true {
			prior, e := s.ReadWithin(ctx, tx, &a, Object{"type": objectType, "id": o.ID, "version": previous.Version})
			if e != nil {
				return nil, e
			}
			if prior["record"] == nil {
				reason := str(prior, "reason")
				if reason == "" {
					reason = "evidence_reference_unavailable"
				}
				return nil, fault.New(reason, 409)
			}
			if prior["synthetic"] == true {
				return nil, fault.New("synthetic_mismatch", 422)
			}
		}
		if previous != nil && kind != "revoke" {
			if previous.Payload["taskId"] != data["taskId"] || previous.Payload["participationId"] != data["participationId"] {
				return nil, fault.New("record_context_changed", 409)
			}
			if objectType == "evidence" && sourceKey(obj(previous.Payload["source"])) != sourceKey(obj(data["source"])) {
				return nil, fault.New("source_identity_changed", 409)
			}
			if objectType == "verification" {
				before, after := obj(previous.Payload["target"]), obj(data["target"])
				if before["type"] != after["type"] || before["id"] != after["id"] {
					return nil, fault.New("verification_target_changed", 409)
				}
			}
		}
		derived := Object{"recordedAt": time.Unix(s.now(), 0).UTC().Format("2006-01-02T15:04:05.000Z"), "synthetic": data["synthetic"] == true || obj(context["facts"])["synthetic"] == true, "claimAuthority": "authenticated-subject-report", "independentExecutionVerified": false, "capabilityVerified": false}
		if kind != "revoke" {
			if at(data, "observedAt").After(time.Unix(s.now(), 0)) {
				return nil, fault.New("future_observation", 422)
			}
			if str(data, "expiresAt") != "" && !at(data, "expiresAt").After(at(data, "observedAt")) {
				return nil, fault.New("invalid_expiry", 422)
			}
		}
		if kind == "evidence" {
			if at(obj(data["source"]), "originalAt").After(at(data, "observedAt")) {
				return nil, fault.New("source_time_mismatch", 422)
			}
			derived["sourceKey"] = sourceKey(obj(data["source"]))
			derived["sourceStrength"] = "submitter-reported-reference"
			derived["sourceIdentityVerified"] = false
			derived["importedAt"] = derived["recordedAt"]
			derived["currentSourceState"] = "not-checked"
			derived["externalRevocation"] = "unknown"
		}
		if kind == "verification" {
			target, e := s.TargetWithin(ctx, tx, &a, obj(data["target"]), TargetOptions{CaseID: o.CaseID, ScopeVersion: pointer(num(data, "scopeVersion")), Latest: true})
			if e != nil {
				return nil, e
			}
			fact := obj(target["fact"])
			if str(data, "taskId") != "" && fact["taskId"] != data["taskId"] {
				return nil, fault.New("target_task_mismatch", 422)
			}
			feedback := one(data["method"], "participant-feedback", "requester-acceptance")
			if data["method"] == "requester-acceptance" && target["requesterId"] != a.SubjectID {
				return nil, fault.New("requester_required", 403)
			}
			if feedback && !one(data["observation"], "accepted", "partially-accepted", "rejected", "comment", "inconclusive") || !feedback && !one(data["observation"], "passed", "failed", "inconclusive") {
				return nil, fault.New("observation_method_mismatch", 422)
			}
			if !feedback && len(arr(data["evidenceRefs"])) == 0 {
				return nil, fault.New("supporting_evidence_required", 422)
			}
			synthetic := fact["synthetic"] == true
			for _, ref := range arr(data["evidenceRefs"]) {
				ref := copyObject(obj(ref))
				ref["kind"] = "evidence"
				source, e := s.RequireReferenceWithin(ctx, tx, &a, ref, ReferenceOptions{CaseID: o.CaseID})
				if e != nil {
					return nil, e
				}
				synthetic = synthetic || source["synthetic"] == true
			}
			derived["synthetic"] = derived["synthetic"] == true || synthetic
			strength := "user-side-scoped-report"
			if feedback {
				strength = "participant-feedback"
			} else if data["method"] == "local-test" || strings.HasSuffix(str(data, "method"), "-test") {
				strength = "user-side-test-report"
			}
			derived["sourceStrength"] = strength
			relationship := "task-participant"
			if fact["actorId"] == a.SubjectID {
				relationship = "self"
			} else if target["requesterId"] == a.SubjectID {
				relationship = "requester"
			}
			derived["recordedRelationship"] = relationship
			derived["declaredRelationship"] = data["relationship"]
			derived["relationshipIndependentlyVerified"] = false
			derived["targetAuthor"] = fact["actorId"]
			derived["scope"] = "declared-scope-only"
			derived["taskOutcomeVerified"] = false
		}
		if e = appendEvent(ctx, tx, data, consent, payload, hash, derived); e != nil {
			return nil, e
		}
		if e = dependencies(ctx, tx, data); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, data, consent, requestID, auth); e != nil {
			return nil, e
		}
		saved := *o
		saved.Version = num(data, "expectedVersion") + 1
		saved.State = "active"
		if kind == "revoke" {
			saved.State = "revoked"
		}
		return receiptView(&saved, &recordEvent{Version: saved.Version, Payload: data, Context: derived}), nil
	})
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, data Object, consent, requestID string, auth deviceauth.ControlAuthorization) error {
	var rid any
	if requestID != "" {
		rid = requestID
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
SELECT $1,$2,$3,$4,'accepted',1,ch.payload->>'installationId',b.audience,'evidence',c.id,b.id,$5,$4,b.scopes,$6::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=$8 AND c.subject_id=$1`, a.SubjectID, "verification-record."+str(data, "kind"), data["id"], data["operationId"], rid, string(encode(auth.CredentialScopes)), a.BindingID, consent)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("verification audit context unavailable")
	}
	return nil
}
