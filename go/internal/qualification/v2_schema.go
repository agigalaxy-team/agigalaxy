package qualification

import (
	"math"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func positiveInteger(v any) bool {
	switch n := v.(type) {
	case int:
		return n > 0
	case int64:
		return n > 0
	case float64:
		return n > 0 && n <= 9007199254740991 && math.Trunc(n) == n
	default:
		raw, e := protocol.EncodeJS(v)
		if e != nil {
			return false
		}
		var parsed float64
		if protocol.Decode(raw, &parsed) != nil {
			return false
		}
		return parsed > 0 && parsed <= 9007199254740991 && math.Trunc(parsed) == parsed
	}
}
func uuidArray(v any, max int) bool {
	values, ok := v.([]any)
	if !ok || len(values) > max {
		return false
	}
	for _, v := range values {
		if _, ok := v.(string); !ok || !uuidPattern.MatchString(text(v)) {
			return false
		}
	}
	return true
}
func ParseQueryV2(raw []byte) (Object, error) {
	var q Object
	invalid := func() (Object, error) { return nil, fail("invalid_qualification_v2_query", 400) }
	if protocol.Decode(raw, &q) != nil || !queryClosed(q, []string{"taskId", "subjectId"}, []string{"policyId", "policyVersion", "capabilityId", "evidence", "includeSimulation"}) || !uuidPattern.MatchString(str(q, "taskId")) || !subjectPattern.MatchString(str(q, "subjectId")) {
		return invalid()
	}
	for _, spec := range []struct {
		key string
		max int
	}{{"policyId", 80}, {"policyVersion", 32}} {
		if v, ok := q[spec.key]; ok && !boundedString(v, 1, spec.max) {
			return invalid()
		}
	}
	if v, ok := q["capabilityId"]; ok {
		if _, ok := v.(string); !ok || !capabilityPattern.MatchString(text(v)) {
			return invalid()
		}
	}
	if v, ok := q["includeSimulation"]; ok {
		if _, ok := v.(bool); !ok {
			return invalid()
		}
	} else {
		q["includeSimulation"] = false
	}
	evidence := object(q["evidence"])
	if _, exists := q["evidence"]; !exists {
		evidence = Object{}
		q["evidence"] = evidence
	}
	if !queryClosed(evidence, nil, []string{"participationIds", "externalReviewRefs", "capsuleUseIds", "proofIds", "assistanceIds", "calculationGrantId"}) {
		return invalid()
	}
	for _, spec := range []struct {
		key string
		max int
	}{{"participationIds", 32}, {"capsuleUseIds", 32}, {"proofIds", 16}, {"assistanceIds", 16}} {
		if v, ok := evidence[spec.key]; ok {
			if !uuidArray(v, spec.max) {
				return invalid()
			}
		} else {
			evidence[spec.key] = []any{}
		}
	}
	if v, ok := evidence["calculationGrantId"]; ok {
		if _, ok := v.(string); !ok || !uuidPattern.MatchString(text(v)) {
			return invalid()
		}
	}
	if v, ok := evidence["externalReviewRefs"]; ok {
		refs, ok := v.([]any)
		if !ok || len(refs) > 32 {
			return invalid()
		}
		for _, v := range refs {
			ref := object(v)
			if !queryClosed(ref, []string{"id", "version"}, nil) || !uuidPattern.MatchString(str(ref, "id")) || !positiveInteger(ref["version"]) {
				return invalid()
			}
		}
	} else {
		evidence["externalReviewRefs"] = []any{}
	}
	return q, nil
}

// DecisionV2 accepts already-authorized facts only, retaining the original
// distinction between real scoped experience and explicitly requested simulation.
func DecisionV2(policy Object, sources, proofs, restrictions []any, simulation bool) Object {
	count := func(rows []any) int {
		groups := map[string]bool{}
		for _, v := range rows {
			p := object(v)
			if p["usable"] == true {
				groups[str(p, "group")] = true
			}
		}
		return len(groups)
	}
	usable := []any{}
	satisfied := []any{}
	for _, v := range sources {
		if object(v)["synthetic"] == false {
			usable = append(usable, v)
			if object(v)["usable"] == true {
				satisfied = append(satisfied, v)
			}
		}
	}
	needed := number(policy["minAcceptedCollaborations"])
	if policy["collaboration"] == "basic-bounty" && needed < 1 {
		needed = 1
	}
	current := count(usable)
	missing := []any{}
	if int64(current) < needed {
		missing = append(missing, Object{"condition": "relevant-reviewed-experience", "required": needed, "available": current})
	}
	if int64(len(proofs)) < number(policy["minProofs"]) {
		missing = append(missing, Object{"condition": "policy-matched-ci-observations", "required": policy["minProofs"], "available": len(proofs)})
	}
	state := "satisfied"
	if len(restrictions) > 0 {
		state = "not-satisfied"
	} else if len(missing) > 0 {
		state = "insufficient-evidence"
	}
	out := Object{"state": state, "missing": missing, "satisfiedBy": satisfied, "effectiveRestrictions": restrictions, "counts": Object{"distinctRelevantExperiences": current, "policyMatchedCiSources": len(proofs)}, "capabilityVerified": false, "expertiseCertified": false, "automaticSelection": false}
	if simulation {
		state := "satisfied"
		if len(restrictions) > 0 {
			state = "not-satisfied"
		} else if int64(count(sources)) < needed || int64(len(proofs)) < number(policy["minProofs"]) {
			state = "insufficient-evidence"
		}
		out["simulation"] = Object{"only": true, "grantsParticipation": false, "distinctRelevantExperiences": count(sources), "state": state}
	}
	return out
}
