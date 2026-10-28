package taskmaterials

func createLegacyAssistance(subject string, request Object, now int64) (Object, error) {
	if !subjectPattern.MatchString(subject) || now < 0 || num(request["enrollmentExpiresAt"]) <= now {
		return nil, fail("assistance_expired")
	}
	return Object{"version": 1, "request": request, "requesterId": subject, "state": "open", "invitations": []any{}, "offers": []any{}, "shortlist": []any{}, "selected": nil, "agreedScope": nil, "pendingScope": nil, "delivery": nil, "resolution": nil, "events": []any{}, "createdAt": now, "lastEventAt": now, "contextAccessGranted": false, "paymentExecuted": false, "capabilityVerified": false}, nil
}
func legacyRule(ok bool, code ...string) error {
	if ok {
		return nil
	}
	value := "assistance_transition_denied"
	if len(code) > 0 {
		value = code[0]
	}
	return fail(value)
}
func applyLegacyAssistance(state Object, actor string, event Object, now int64) (Object, error) {
	for _, value := range arr(state["events"]) {
		prior := value.(map[string]any)
		if obj(prior, "event")["id"] == event["id"] {
			if prior["actorId"] != actor || canonical(prior["event"]) != canonical(event) {
				return nil, fail("assistance_event_conflict")
			}
			return state, nil
		}
	}
	if num(state["version"]) != num(event["expectedVersion"]) {
		return nil, fail("assistance_version_conflict")
	}
	if now < 0 || now < num(state["lastEventAt"]) {
		return nil, fail("assistance_time_conflict")
	}
	if len(arr(state["events"])) >= 1000 {
		return nil, fail("assistance_event_limit")
	}
	next := cloneObject(state)
	requester := actor == str(state, "requesterId")
	provider := actor == str(obj(state, "selected"), "providerId")
	enrollment := contains([]string{"open", "awaiting-confirmation"}, str(state, "state"))
	kind := str(event, "kind")
	if enrollment && now >= num(obj(state, "request")["enrollmentExpiresAt"]) && !contains([]string{"expire", "cancel"}, kind) {
		return nil, fail("assistance_expired")
	}
	offered := func(id any) Object {
		offer := findObject(next["offers"], "id", id)
		if offer != nil && !truth(offer["withdrawn"]) {
			return offer
		}
		return nil
	}
	var e error
	deny := func(ok bool, codes ...string) bool { e = legacyRule(ok, codes...); return e != nil }
	switch kind {
	case "requester-feedback":
		confirmed, already := false, false
		for _, value := range arr(state["events"]) {
			record := value.(map[string]any)
			if record["actorId"] == actor && obj(record, "event")["kind"] == "confirm" {
				confirmed = true
			}
			if obj(record, "event")["kind"] == "requester-feedback" {
				already = true
			}
		}
		if deny(provider && contains([]string{"accepted", "canceled", "resolved"}, str(state, "state")) && confirmed && !already) {
			break
		}
	case "invite":
		if deny(requester && state["state"] == "open" && event["participantId"] != actor) {
			break
		}
		invites := arr(next["invitations"])
		if deny(len(invites) < 16 && findObject(invites, "participantId", event["participantId"]) == nil, "assistance_invitation_limit") {
			break
		}
		next["invitations"] = append(invites, Object{"eventId": event["id"], "participantId": event["participantId"]})
	case "offer":
		duplicate := false
		for _, value := range arr(state["offers"]) {
			offer := value.(map[string]any)
			if offer["providerId"] == actor && !truth(offer["withdrawn"]) {
				duplicate = true
			}
		}
		if deny(state["state"] == "open" && !requester && !duplicate) || deny(event["quote"] == nil || obj(state, "request")["collaboration"] == "basic-bounty") {
			break
		}
		evidence := event["qualificationEvidence"]
		if evidence == nil {
			evidence = Object{"proofIds": []any{}, "assistanceIds": []any{}}
		}
		next["offers"] = append(arr(next["offers"]), Object{"id": event["id"], "providerId": actor, "proposal": event["proposal"], "scope": event["scope"], "quote": event["quote"], "qualificationEvidence": evidence, "withdrawn": false})
	case "withdraw-offer":
		offer := offered(event["offerId"])
		if deny(enrollment && offer != nil && offer["providerId"] == actor) {
			break
		}
		offer["withdrawn"] = true
		list := []any{}
		for _, id := range arr(next["shortlist"]) {
			if id != offer["id"] {
				list = append(list, id)
			}
		}
		next["shortlist"] = list
		if obj(state, "selected")["offerId"] == offer["id"] {
			next["selected"] = nil
			next["state"] = "open"
		}
	case "shortlist":
		if deny(requester && state["state"] == "open") {
			break
		}
		seen := map[string]bool{}
		for _, id := range arr(event["offerIds"]) {
			if deny(!seen[text(id)] && offered(id) != nil) {
				break
			}
			seen[text(id)] = true
		}
		if e != nil {
			break
		}
		next["shortlist"] = event["offerIds"]
	case "select":
		offer := offered(event["offerId"])
		if deny(requester && state["state"] == "open" && offer != nil) {
			break
		}
		next["selected"] = Object{"offerId": offer["id"], "providerId": offer["providerId"]}
		next["state"] = "awaiting-confirmation"
	case "confirm":
		if deny(provider && state["state"] == "awaiting-confirmation") {
			break
		}
		next["state"] = "active"
		next["agreedScope"] = offered(obj(state, "selected")["offerId"])["scope"]
	case "change-scope":
		if deny(requester && state["state"] == "active") {
			break
		}
		next["pendingScope"] = event["scope"]
		next["state"] = "awaiting-scope-confirmation"
	case "confirm-scope":
		if deny(provider && state["state"] == "awaiting-scope-confirmation") {
			break
		}
		next["agreedScope"] = state["pendingScope"]
		next["pendingScope"] = nil
		next["state"] = "active"
	case "deliver":
		if deny(provider && contains([]string{"active", "delivered"}, str(state, "state"))) {
			break
		}
		delivery := Object{"id": event["id"], "attemptId": event["attemptId"], "summary": event["summary"], "evidenceIds": event["evidenceIds"]}
		if value, ok := event["caseReviewVersion"]; ok {
			delivery["caseReviewVersion"] = value
		}
		next["delivery"] = delivery
		next["state"] = "delivered"
	case "accept":
		if deny(requester && state["state"] == "delivered" && event["deliveryId"] == obj(state, "delivery")["id"]) {
			break
		}
		next["state"] = "accepted"
	case "cancel":
		if deny((requester || provider) && contains([]string{"open", "awaiting-confirmation", "active", "awaiting-scope-confirmation", "delivered"}, str(state, "state"))) {
			break
		}
		next["state"] = "canceled"
	case "expire":
		if deny(requester && enrollment && now >= num(obj(state, "request")["enrollmentExpiresAt"])) {
			break
		}
		next["state"] = "expired"
	case "dispute":
		if deny((requester || provider) && contains([]string{"active", "awaiting-scope-confirmation", "delivered", "accepted", "resolved"}, str(state, "state"))) {
			break
		}
		next["state"] = "disputed"
		next["resolution"] = nil
	case "propose-resolution":
		if deny((requester || provider) && contains([]string{"disputed", "awaiting-resolution-confirmation"}, str(state, "state"))) {
			break
		}
		resolution := Object{"id": event["id"], "proposerId": actor, "summary": event["summary"]}
		if value, ok := event["outcome"]; ok {
			resolution["outcome"] = value
		}
		next["resolution"] = resolution
		next["state"] = "awaiting-resolution-confirmation"
	case "confirm-resolution":
		resolution := obj(state, "resolution")
		if deny((requester || provider) && state["state"] == "awaiting-resolution-confirmation" && actor != str(resolution, "proposerId") && event["proposalId"] == resolution["id"]) {
			break
		}
		next["state"] = "resolved"
		if resolution["outcome"] == "resume-work" {
			next["state"] = "active"
			next["delivery"] = nil
			next["pendingScope"] = nil
		}
	}
	if e != nil {
		return nil, e
	}
	next["version"] = num(state["version"]) + 1
	next["lastEventAt"] = now
	next["events"] = append(arr(next["events"]), Object{"actorId": actor, "at": now, "event": event})
	return next, nil
}
