package taskmaterials

import "math"

func parseLegacyRequest(raw string) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_assistance_payload", 400) }
	if len([]byte(raw)) > 16000 {
		return invalid()
	}
	p, e := parseObject(raw)
	if e != nil || !exactFields(p, []string{"id", "caseId", "title", "problem", "attemptedApproaches", "scope", "visibility", "collaboration", "enrollmentExpiresAt"}, []string{"budget", "capabilityId", "qualification"}) || !validID(str(p, "id")) || !validID(str(p, "caseId")) || !trimmed(p, "title", 160) || !trimmed(p, "problem", 1200) || !trimmed(p, "scope", 1200) || !contains([]string{"Private", "Public"}, str(p, "visibility")) || !contains([]string{"open-assistance", "basic-bounty"}, str(p, "collaboration")) || !validInt(p["enrollmentExpiresAt"], 1, math.MaxInt64) {
		return invalid()
	}
	approaches, ok := p["attemptedApproaches"].([]any)
	if !ok || len(approaches) > 8 {
		return invalid()
	}
	for i, value := range approaches {
		v, ok := value.(string)
		if !ok {
			return invalid()
		}
		v = jsTrim(v)
		if !validText(v, 1200) {
			return invalid()
		}
		approaches[i] = v
	}
	if value, ok := p["capabilityId"]; ok && !capability.MatchString(text(value)) {
		return invalid()
	}
	qualification, qualified := p["qualification"]
	if qualified {
		q := objectOrNil(qualification)
		if !exactFields(q, []string{"policyId", "policyVersion"}, nil) || !validText(q["policyId"], 80) || !validText(q["policyVersion"], 32) || p["capabilityId"] == nil {
			return invalid()
		}
	}
	_, hasBudget := p["budget"]
	if str(p, "collaboration") == "basic-bounty" {
		if !hasBudget {
			return invalid()
		}
	} else if hasBudget {
		return invalid()
	}
	if hasBudget && !validTaskBudget(obj(p, "budget")) {
		return invalid()
	}
	return p, nil
}
func objectOrNil(value any) Object { v, _ := value.(map[string]any); return v }
func parseLegacyEvent(raw string) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_assistance_payload", 400) }
	if len([]byte(raw)) > 16000 {
		return invalid()
	}
	envelope, e := parseObject(raw)
	if e != nil || !exactFields(envelope, []string{"assistanceId", "event"}, nil) || !validID(str(envelope, "assistanceId")) {
		return invalid()
	}
	p := obj(envelope, "event")
	if !validID(str(p, "id")) || !validInt(p["expectedVersion"], 1, math.MaxInt64) {
		return invalid()
	}
	required := []string{"id", "expectedVersion", "kind"}
	optional := []string{}
	add := func(keys ...string) { required = append(required, keys...) }
	switch str(p, "kind") {
	case "requester-feedback":
		add("descriptionClarity", "scopeMatched", "note")
		if !contains([]string{"clear", "partly-clear", "unclear"}, str(p, "descriptionClarity")) || !trimmed(p, "note", 300) {
			return invalid()
		}
		if _, ok := p["scopeMatched"].(bool); !ok {
			return invalid()
		}
	case "invite":
		add("participantId", "note")
		if !subjectPattern.MatchString(str(p, "participantId")) || !trimmed(p, "note", 300) {
			return invalid()
		}
	case "offer":
		add("proposal", "scope")
		optional = append(optional, "quote", "qualificationEvidence")
		if !trimmed(p, "proposal", 1200) || !trimmed(p, "scope", 1200) {
			return invalid()
		}
		if _, ok := p["quote"]; ok && !validTaskBudget(obj(p, "quote")) {
			return invalid()
		}
		if _, ok := p["qualificationEvidence"]; ok {
			q := obj(p, "qualificationEvidence")
			if !exactFields(q, []string{"proofIds", "assistanceIds"}, nil) || !validUUIDList(q["proofIds"], 16, true) || !validUUIDList(q["assistanceIds"], 16, true) {
				return invalid()
			}
		}
	case "withdraw-offer":
		add("offerId", "reason")
		if !validID(str(p, "offerId")) || !trimmed(p, "reason", 1200) {
			return invalid()
		}
	case "shortlist":
		add("offerIds")
		if !validUUIDList(p["offerIds"], 16, false) {
			return invalid()
		}
	case "select":
		add("offerId")
		if !validID(str(p, "offerId")) {
			return invalid()
		}
	case "confirm", "confirm-scope", "expire":
	case "change-scope":
		add("scope", "reason")
		if !trimmed(p, "scope", 1200) || !trimmed(p, "reason", 1200) {
			return invalid()
		}
	case "deliver":
		add("attemptId", "summary", "evidenceIds")
		optional = append(optional, "caseReviewVersion")
		if !validID(str(p, "attemptId")) || !trimmed(p, "summary", 1200) || !validUUIDList(p["evidenceIds"], 16, false) {
			return invalid()
		}
		if value, ok := p["caseReviewVersion"]; ok && !validInt(value, 0, 1000) {
			return invalid()
		}
	case "accept":
		add("deliveryId", "summary")
		if !validID(str(p, "deliveryId")) || !trimmed(p, "summary", 1200) {
			return invalid()
		}
	case "cancel", "dispute":
		add("reason")
		if !trimmed(p, "reason", 1200) {
			return invalid()
		}
	case "propose-resolution":
		add("summary")
		optional = append(optional, "outcome")
		if !trimmed(p, "summary", 1200) {
			return invalid()
		}
		if value, ok := p["outcome"]; ok && !contains([]string{"close", "resume-work"}, text(value)) {
			return invalid()
		}
	case "confirm-resolution":
		add("proposalId")
		if !validID(str(p, "proposalId")) {
			return invalid()
		}
	default:
		return invalid()
	}
	if !exactFields(p, required, optional) {
		return invalid()
	}
	return envelope, nil
}
