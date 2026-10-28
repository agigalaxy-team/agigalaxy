package qualification

import (
	"context"
	"encoding/json"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func require(ok bool, code string) error {
	if !ok {
		return fail(code)
	}
	return nil
}
func unavailable(e error) bool {
	switch fault.Status(e) {
	case 403, 404, 409, 422, 503:
		return serviceError(e)
	}
	return false
}
func distinctSorted(value any) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range array(value) {
		s := text(v)
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	} // JavaScript default sort for UUIDs is ASCII.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
func (s *Service) EvaluateV2Within(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, raw []byte, collaboration string) (Object, error) {
	q, e := ParseQueryV2(raw)
	if e != nil {
		return nil, e
	}
	if s.Assistance == nil {
		return nil, fail("qualification_assistance_unavailable", 503)
	}
	target, e := s.Assistance.RequireTaskWithin(ctx, tx, &a, str(q, "taskId"), false)
	if e != nil {
		return nil, e
	}
	request := object(object(target["snapshot"])["request"])
	if e = require(collaboration == "" || request["collaboration"] == collaboration, "qualification_task_mismatch"); e != nil {
		return nil, e
	}
	base := Object{"schemaVersion": 2, "subjectId": q["subjectId"], "taskId": q["taskId"], "decisionScope": "current task eligibility only", "issuer": s.Endpoint, "checkedAt": s.now(), "cacheable": false, "capabilityVerified": false, "expertiseCertified": false, "automaticSelection": false,
		"paths": []any{"open-assistance", "scoped-external-work-review", "scoped-challenge", "authorized-real-capsule-application"}, "sourceCoverage": "explicitly-selected-current-authorized-evidence", "restrictionsCoverage": "current-task-operational-pause; no-inferred-global-ban"}
	qualification := object(request["qualification"])
	profile := qualification["profile"]
	if profile == nil {
		if qualification != nil {
			profile = "legacy"
		} else {
			profile = "open-without-history"
		}
	}
	base["taskEligibilityProfile"] = profile
	base["appliesToTaskSelection"] = qualification == nil || qualification["profile"] == "facts-v2"
	restrictions := []any{}
	if target["paused"] == true {
		restrictions = append(restrictions, Object{"kind": "task-paused", "taskId": q["taskId"], "scope": "new-participation"})
	}
	if qualification == nil {
		if e = require(request["collaboration"] == "open-assistance", "qualification_policy_unavailable"); e != nil {
			return nil, e
		}
		state := "satisfied"
		if len(restrictions) > 0 {
			state = "not-satisfied"
		}
		base["state"], base["missing"], base["satisfiedBy"], base["effectiveRestrictions"], base["basis"] = state, []any{}, []any{}, restrictions, "this-open-task-has-no-history-requirement"
		return base, nil
	}
	for _, item := range []struct {
		key      string
		expected any
	}{{"policyId", qualification["policyId"]}, {"policyVersion", qualification["policyVersion"]}, {"capabilityId", request["capabilityId"]}} {
		if v, ok := q[item.key]; ok && v != item.expected {
			return nil, fail("qualification_task_policy_mismatch")
		}
	}
	policy, e := s.PolicyWithin(ctx, tx, str(qualification, "policyId"), str(qualification, "policyVersion"), str(request, "capabilityId"), str(request, "collaboration"))
	if e != nil {
		return nil, e
	}
	evidence := object(q["evidence"])
	var calculation *CalculationContext
	if evidence["calculationGrantId"] != nil {
		calculation, e = s.CalculationContextWithin(ctx, tx, a, q)
		if e != nil {
			return nil, e
		}
	}
	if len(array(evidence["externalReviewRefs"])) > 0 && (s.ReadExperienceReview == nil || calculation != nil && s.ReadExperienceCalculation == nil) {
		return nil, fail("qualification_experience_review_unavailable", 503)
	}
	if len(array(evidence["capsuleUseIds"])) > 0 && s.ReadCapsuleUse == nil {
		return nil, fail("qualification_capsule_source_unavailable", 503)
	}
	sources := []any{}
	observations := []any{}
	for _, id := range distinctSorted(evidence["participationIds"]) {
		source, e := s.participationWithin(ctx, tx, &a, id, str(q, "subjectId"), policy, calculation.sourceTrace())
		if e != nil {
			if !unavailable(e) {
				return nil, e
			}
			observations = append(observations, Object{"kind": "participation", "id": id, "state": "unavailable", "reason": fault.Code(e)})
		} else {
			sources = append(sources, source)
		}
	}
	for _, v := range array(evidence["externalReviewRefs"]) {
		ref := object(v)
		source, e := s.externalReviewWithin(ctx, tx, a, ref, str(q, "subjectId"), policy, calculation.sourceTrace())
		if e != nil {
			if !unavailable(e) {
				return nil, e
			}
			observations = append(observations, Object{"kind": "external-review", "id": ref["id"], "state": "unavailable", "reason": fault.Code(e)})
		} else {
			sources = append(sources, source)
		}
	}
	for _, v := range array(evidence["capsuleUseIds"]) {
		id := text(v)
		var row Object
		if e = tx.QueryRow(ctx, "SELECT to_jsonb(u) FROM capsule_uses_v2 u WHERE id=$1", id).Scan(&row); e != nil && e != pgx.ErrNoRows {
			return nil, e
		}
		use, e := s.ReadCapsuleUse(ctx, tx, a, row)
		if e == nil && (use["record"] == nil || use["kind"] == "reference" || use["sourceStatus"] != "current") {
			e = fail("qualification_capsule_source_unavailable")
		}
		if e != nil {
			if !unavailable(e) {
				return nil, e
			}
			observations = append(observations, Object{"kind": "capsule-use", "id": id, "state": "unavailable", "reason": fault.Code(e)})
		} else {
			observations = append(observations, Object{"kind": "capsule-use", "id": id, "caseId": use["caseId"], "state": "actual-application-requires-scoped-review", "synthetic": use["synthetic"], "reportedOutcome": use["reportedOutcome"], "capabilityVerified": false})
		}
	}
	legacyRaw, _ := json.Marshal(Object{"policyId": policy["id"], "policyVersion": policy["version"], "capabilityId": policy["capabilityId"], "subjectId": q["subjectId"], "evidence": Object{"proofIds": evidence["proofIds"], "assistanceIds": evidence["assistanceIds"]}})
	legacy, e := s.EvaluateWithin(ctx, tx, a, legacyRaw, str(request, "collaboration"))
	if e != nil {
		return nil, e
	}
	for _, v := range array(legacy["acceptedCollaborations"]) {
		observations = append(observations, Object{"kind": "legacy-assistance", "id": object(v)["assistanceId"], "state": "legacy-source-profile; v2-scope-review-required"})
	}
	decision := DecisionV2(policy, sources, array(legacy["proofs"]), restrictions, q["includeSimulation"] == true)
	if calculation != nil {
		limited := []any{}
		for range array(decision["satisfiedBy"]) {
			limited = append(limited, Object{"condition": "relevant-reviewed-experience", "scope": "selected-task-related-work", "sourceDetailsDisclosed": false})
		}
		decision["satisfiedBy"] = limited
		for k, v := range decision {
			base[k] = v
		}
		visibleObservations := []any{}
		for _, v := range observations {
			o := object(v)
			visible := Object{"kind": o["kind"], "state": o["state"]}
			if reason, ok := o["reason"]; ok {
				visible["reason"] = reason
			}
			visibleObservations = append(visibleObservations, visible)
		}
		statuses := []any{}
		for _, v := range sources {
			source := object(v)
			if source["usable"] != true || source["synthetic"] != false {
				reason := source["reason"]
				if source["synthetic"] == true {
					reason = "synthetic-excluded"
				} else if reason == nil {
					reason = "source-unavailable"
				}
				statuses = append(statuses, Object{"reason": reason})
			}
		}
		hash, e := DefinitionHash(policy)
		if e != nil {
			return nil, e
		}
		base["observations"], base["sourceStatuses"] = visibleObservations, statuses
		base["calculation"] = Object{"grantId": calculation.GrantID, "taskId": q["taskId"], "recipientId": calculation.Payload["recipientId"], "purpose": calculation.Payload["purpose"]}
		base["capabilityId"], base["policyId"], base["policyVersion"], base["policyDefinitionHash"] = policy["capabilityId"], policy["id"], policy["version"], hash
		base["sourceCoverage"] = "selected-licensed-materials; no-original-text-or-third-party-identity"
		return base, nil
	}
	for k, v := range decision {
		base[k] = v
	}
	hash, e := DefinitionHash(policy)
	if e != nil {
		return nil, e
	}
	statuses := []any{}
	for _, v := range sources {
		p := object(v)
		if p["usable"] != true || p["synthetic"] != false {
			reason := p["reason"]
			if p["synthetic"] == true {
				reason = "synthetic-excluded"
			} else if reason == nil {
				reason = "real-source-status-unknown"
			}
			statuses = append(statuses, Object{"kind": p["kind"], "id": p["id"], "reason": reason})
		}
	}
	base["capabilityId"], base["policyId"], base["policyVersion"], base["policyDefinitionHash"], base["registeredPolicyVersion"] = policy["capabilityId"], policy["id"], policy["version"], hash, s.registryEnabled
	base["evaluationRule"] = Object{"id": "task-related-facts", "version": 2, "counting": "distinct-case-or-stable-external-source; real-material-only"}
	base["observations"], base["sourceStatuses"], base["proofMeaning"] = observations, statuses, "policy-matched-ci-observations; not-individual-capability-or-independent-work"
	return base, nil
}
func (s *Service) participationWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id, subject string, policy Object, calculation *SourceTrace) (Object, error) {
	var taskID, owner string
	e := tx.QueryRow(ctx, "SELECT task_id,subject_id FROM task_participations WHERE id=$1", id).Scan(&taskID, &owner)
	if e != nil && e != pgx.ErrNoRows {
		return nil, e
	}
	if e == pgx.ErrNoRows || owner != subject {
		return nil, fail("qualification_source_unavailable", 404)
	}
	var task Object
	var p Object
	if calculation == nil {
		task, e = s.Assistance.ReadTaskWithin(ctx, tx, a, taskID)
		if e != nil {
			return nil, e
		}
		for _, v := range array(task["participations"]) {
			if object(v)["participationId"] == id {
				p = object(v)
				break
			}
		}
	} else {
		t, e := readRow(ctx, tx, "SELECT to_jsonb(t) FROM task_requests t WHERE id=$1", taskID)
		if e != nil {
			return nil, e
		}
		pr, e := readRow(ctx, tx, "SELECT to_jsonb(p) FROM task_participations p WHERE id=$1", id)
		if e != nil {
			return nil, e
		}
		if t == nil || object(t["snapshot"])["contentDeleted"] == true || pr == nil || object(pr["snapshot"])["contentDeleted"] == true {
			return nil, fail("qualification_source_unavailable")
		}
		root, e := readRow(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", t["root_event_id"])
		if e != nil {
			return nil, e
		}
		if e = calculation.ReadEventWithin("task-event", root); e != nil {
			return nil, e
		}
		p = object(pr["snapshot"])
		seen := map[string]bool{}
		for _, key := range []string{"proposalEventId", "scopeEventId"} {
			eventID := str(p, key)
			if seen[eventID] {
				continue
			}
			seen[eventID] = true
			event, e := readRow(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", eventID)
			if e != nil {
				return nil, e
			}
			if e = calculation.ReadEventWithin("task-event", event); e != nil {
				return nil, e
			}
		}
		paused := false
		if t["case_id"] != nil {
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM moderation_reports WHERE case_id=$1 AND paused=true)", t["case_id"]).Scan(&paused); e != nil {
				return nil, e
			}
		}
		task = Object{"taskId": t["id"], "caseId": t["case_id"], "request": object(t["snapshot"])["request"], "requesterId": t["requester_id"], "paused": paused}
	}
	if p == nil || task["caseId"] == nil || object(task["request"])["capabilityId"] != policy["capabilityId"] {
		return nil, fail("qualification_source_scope_mismatch")
	}
	confirmed := false
	for _, v := range array(p["events"]) {
		event := object(v)
		if object(event["event"])["kind"] == "confirm" && event["actorId"] == subject {
			confirmed = true
			break
		}
	}
	if !confirmed {
		return nil, fail("qualification_confirmation_unavailable")
	}
	if calculation != nil {
		for _, v := range array(p["events"]) {
			event := object(v)
			if object(event["event"])["kind"] == "confirm" && event["actorId"] == subject {
				row, e := readRow(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", object(event["event"])["eventId"])
				if e != nil {
					return nil, e
				}
				if e = calculation.ReadEventWithin("task-event", row); e != nil {
					return nil, e
				}
			}
		}
	}
	group := "case:" + str(task, "caseId")
	if task["paused"] == true || p["state"] == "disputed" {
		return Object{"kind": "participation", "id": id, "usable": false, "reason": "source-under-review", "group": group}, nil
	}
	if s.Cases == nil {
		return nil, fail("qualification_case_source_unavailable", 503)
	}
	container, e := s.Cases.CaseWithin(ctx, tx, str(task, "caseId"))
	if e != nil {
		return nil, e
	}
	parent := object(container["parent"])
	if parent == nil || parent["state"] == "withdrawn" {
		return nil, fail("qualification_source_unavailable")
	}
	rows, _ := container["rows"].([]cases.Object)
	facts := object(container["facts"])
	var readEvent func(Object) error
	if calculation != nil {
		var root Object
		for _, row := range rows {
			if row["kind"] == "case" || row["kind"] == "case-created" {
				root = row
				break
			}
		}
		if e = calculation.ReadEventWithin("case-event", root); e != nil {
			return nil, e
		}
		readEvent = func(row Object) error { return calculation.ReadEventWithin("case-event", row) }
	}
	deliveries := array(p["deliveries"])
	for i := len(deliveries) - 1; i >= 0; i-- {
		delivery := object(deliveries[i])
		acceptance := object(delivery["acceptance"])
		if acceptance == nil || acceptance["actorId"] != task["requesterId"] || number(acceptance["at"]) < s.now()-number(policy["historyWindowSeconds"]) {
			continue
		}
		if calculation != nil {
			for _, eventID := range []any{delivery["deliveryId"], acceptance["eventId"]} {
				row, e := readRow(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", eventID)
				if e != nil {
					return nil, e
				}
				if e = calculation.ReadEventWithin("task-event", row); e != nil {
					return nil, e
				}
			}
		}
		result, e := s.Cases.RequireFactWithin(ctx, tx, a, rows, facts, "result", object(delivery["resultRef"]), cases.FactOptions{Latest: true, ReadEventWithin: readEvent})
		if e != nil {
			return nil, e
		}
		if result["actorId"] != subject || result["taskId"] != task["taskId"] || result["participationId"] != id {
			return nil, fail("qualification_actual_participation_mismatch")
		}
		if number(result["participationScopeVersion"]) != number(delivery["scopeVersion"]) {
			return nil, fail("qualification_source_scope_mismatch")
		}
		originRef := object(result["origin"])
		origin, e := s.Cases.RequireFactWithin(ctx, tx, a, rows, facts, str(originRef, "kind"), originRef, cases.FactOptions{ReadEventWithin: readEvent})
		if e != nil {
			return nil, e
		}
		if origin["actorId"] != subject {
			return nil, fail("qualification_actual_participation_mismatch")
		}
		refs := []any{}
		for _, v := range array(delivery["evidenceRefs"]) {
			ref := object(v)
			if id, ok := v.(string); ok {
				ref = Object{"id": id, "version": 1}
			}
			if calculation != nil && calculation.ReadEvidenceWithin != nil {
				if e = calculation.ReadEvidenceWithin(ref, Object{"caseId": task["caseId"], "resultRef": delivery["resultRef"]}); e != nil {
					return nil, e
				}
				refs = append(refs, ref)
				continue
			}
			if s.Cases.Sources == nil {
				return nil, fail("source_access_unavailable", 503)
			}
			source := Object{"kind": "evidence"}
			for k, v := range ref {
				source[k] = v
			}
			if _, e = s.Cases.Sources(ctx, tx, a, source, Object{"caseId": task["caseId"]}); e != nil {
				return nil, e
			}
			refs = append(refs, ref)
		}
		return Object{"kind": "participation", "id": id, "group": group, "caseId": task["caseId"], "taskId": task["taskId"], "usable": true, "synthetic": facts["synthetic"], "role": p["role"], "participatedAt": p["confirmedAt"], "resultRef": delivery["resultRef"], "evidenceRefs": refs, "origin": originRef, "acceptanceRef": acceptance["eventId"], "scopeVersion": delivery["scopeVersion"], "scope": p["agreedScope"], "reportedOutcome": result["reportedOutcome"], "review": "requester-accepted-delivery-in-scope", "independentVerification": false}, nil
	}
	return Object{"kind": "participation", "id": id, "group": group, "usable": false, "reason": "no-current-visible-accepted-delivery"}, nil
}
func (s *Service) externalReviewWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, ref Object, subject string, policy Object, calculation *SourceTrace) (Object, error) {
	var reviewed Object
	var e error
	if calculation == nil {
		reviewed, e = s.ReadExperienceReview(ctx, tx, a, ref)
	} else {
		reviewed, e = s.ReadExperienceCalculation(ctx, tx, a, ref, func(row Object) error { return calculation.ReadEventWithin("experience-event", row) })
	}
	if e != nil {
		return nil, e
	}
	r := object(reviewed["record"])
	if reviewed["referenceStatus"] != "current" || r == nil || reviewed["type"] != "review" {
		return nil, fail("qualification_review_unavailable")
	}
	if reviewed["experienceSubjectId"] != subject || r["capabilityId"] != policy["capabilityId"] {
		return nil, fail("qualification_source_scope_mismatch")
	}
	observed, e := time.Parse(time.RFC3339Nano, str(r, "observedAt"))
	if e != nil || observed.UnixMilli() < (s.now()-number(policy["historyWindowSeconds"]))*1000 {
		return nil, fail("qualification_source_outside_window")
	}
	var reason any = r["state"]
	if r["state"] == "verified-in-scope" {
		reason = nil
	}
	return Object{"kind": "external-review", "id": ref["id"], "version": ref["version"], "group": "external:" + str(reviewed, "sourceGroup"), "usable": r["state"] == "verified-in-scope", "reason": reason, "synthetic": reviewed["synthetic"], "experienceKind": reviewed["experienceKind"], "scope": r["scope"], "reviewerId": reviewed["subjectId"], "review": "registered-reviewer-scoped-attestation", "productionExperienceInferred": reviewed["experienceKind"] != "challenge"}, nil
}
func (s *Service) EvaluateV2(ctx context.Context, a Actor, raw []byte) (any, error) {
	return s.run(ctx, a, func(tx pgx.Tx) (any, error) { return s.EvaluateV2Within(ctx, tx, a.Actor, raw, "") })
}
