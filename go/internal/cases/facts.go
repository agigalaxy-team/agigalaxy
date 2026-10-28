package cases

// ProjectFacts is the original deterministic intervention fold. It is a
// projection of persisted reports, never evidence of completion or competence.
func ProjectFacts(rows []Object, parent Object) Object {
	facts := Object{"attempts": []any{}, "interventions": []any{}, "results": []any{}, "resolutions": []any{}, "responses": []any{}, "scopes": []any{}, "synthetic": nil, "resolution": Object{"status": "unrecorded"}, "version": parent["version"], "caseId": parent["id"]}
	push := func(k string, v any) { facts[k] = append(list(facts[k]), v) }
	for _, row := range rows {
		e := object(row["payload"])
		if e == nil {
			e = row
		}
		id := fallback(e["eventId"], e["id"])
		scope := fallback(e["scopeVersion"], fallback(e["taskScopeVersion"], int64(1)))
		var participationScope any
		if text(e, "participationId") != "" {
			participationScope = int64(1)
		}
		participationScope = fallback(e["participationScopeVersion"], participationScope)
		provenance, claim := "legacy-v1", "owner-reported"
		if e["eventId"] != nil {
			provenance, claim = "native-v2", "participant-reported"
		}
		base := Object{"id": id, "version": int64(1), "caseId": parent["id"], "actorId": fallback(e["actorId"], "unknown"), "reportedBy": row["subject_id"], "participationId": e["participationId"], "taskId": e["taskId"], "scopeVersion": scope, "eventId": id, "caseVersion": row["version"], "participationScopeVersion": participationScope, "recordEventIds": []any{id}, "provenance": provenance, "claimAuthority": claim, "synthetic": facts["synthetic"]}
		switch e["kind"] {
		case "case-created":
			facts["synthetic"] = e["synthetic"]
			push("scopes", Object{"version": fallback(e["taskScopeVersion"], int64(1)), "summary": e["summary"], "eventId": id})
		case "case":
			push("scopes", Object{"version": int64(1), "summary": e["summary"], "eventId": id})
		case "case-scope-revised":
			push("scopes", Object{"version": e["taskScopeVersion"], "summary": e["summary"], "eventId": id})
		case "attempt", "attempt-start":
			v := copyObject(base)
			v["strategy"] = fallback(e["strategy"], e["approach"])
			v["role"] = fallback(e["role"], "unknown")
			v["configurationRef"] = e["configurationRef"]
			v["environment"] = fallback(e["environment"], fallback(e["configuration"], "unknown"))
			v["inputScopeSummary"] = fallback(e["inputScopeSummary"], "unknown")
			v["permissionScope"] = fallback(e["permissionScope"], []any{"unknown"})
			v["status"] = "unknown"
			if e["kind"] == "attempt-start" {
				v["status"] = "running"
			}
			v["reportedOutcome"] = "unrecorded"
			v["startedAt"] = fallback(e["startedAt"], row["created_at"])
			v["endedAt"] = nil
			v["resultRefs"] = []any{}
			push("attempts", v)
		case "attempt-end", "attempt-correct":
			prior := FactAt(facts, "attempt", object(e["attemptRef"]))
			if prior == nil {
				continue
			}
			v := copyObject(prior)
			v["version"] = number(prior, "version") + 1
			v["eventId"] = id
			v["caseVersion"] = row["version"]
			v["recordEventIds"] = appended(prior["recordEventIds"], id)
			v["status"] = e["status"]
			v["reportedOutcome"] = fallback(e["reportedOutcome"], "unrecorded")
			v["summary"] = e["summary"]
			v["failureReason"] = e["failureReason"]
			v["endedAt"] = fallback(e["endedAt"], row["created_at"])
			v["correction"] = nil
			if e["kind"] == "attempt-correct" {
				v["correction"] = Object{"reason": e["reason"], "supersedes": e["attemptRef"]}
			}
			push("attempts", v)
		case "intervention":
			var prior Object
			if e["supersedes"] != nil {
				prior = FactAt(facts, "intervention", object(e["supersedes"]))
				if prior == nil {
					continue
				}
			}
			affected, refs, records := []Object{}, []any{}, []any{}
			valid := true
			for _, aid := range list(e["affectsAttemptIds"]) {
				a := LatestFact(facts, "attempt", aid.(string))
				if a == nil {
					valid = false
					break
				}
				affected = append(affected, a)
				refs = append(refs, Object{"id": a["id"], "version": a["version"]})
			}
			if !valid {
				continue
			}
			v := copyObject(base)
			v["id"] = fallback(prior["id"], id)
			v["version"] = number(prior, "version") + 1
			records = append(records, list(prior["recordEventIds"])...)
			for _, a := range affected {
				records = append(records, list(a["recordEventIds"])...)
			}
			records = append(records, id)
			v["recordEventIds"] = records
			for _, k := range []string{"types", "description", "affectsAttemptIds", "sourceRefs", "observedEffect"} {
				v[k] = e[k]
			}
			v["affectsAttemptRefs"] = refs
			v["claimState"] = "self-declared"
			v["confirmation"] = "unconfirmed"
			v["responses"] = []any{}
			v["capabilityVerified"] = false
			push("interventions", v)
		case "intervention-response":
			intervention := FactAt(facts, "intervention", object(e["interventionRef"]))
			if intervention == nil {
				continue
			}
			relationship := "participant"
			if e["actorId"] == intervention["actorId"] {
				relationship = "self"
			} else if e["actorId"] == parent["subject_id"] {
				relationship = "requester"
			}
			response := Object{"id": id, "actorId": e["actorId"], "state": e["state"], "summary": e["summary"], "interventionRef": e["interventionRef"], "relationship": relationship, "recordEventIds": appended(intervention["recordEventIds"], id)}
			push("responses", response)
			responses := []any{}
			for _, r := range list(intervention["responses"]) {
				if object(r)["actorId"] != e["actorId"] {
					responses = append(responses, r)
				}
			}
			responses = append(responses, response)
			intervention["responses"] = responses
			confirmation := "unconfirmed"
			for _, r := range responses {
				o := object(r)
				if o["relationship"] == "self" {
					continue
				}
				if o["state"] == "disputed" {
					confirmation = "disputed"
					break
				}
				if o["state"] == "partial" {
					confirmation = "partially-confirmed"
				} else if o["state"] == "accepted" && confirmation == "unconfirmed" {
					confirmation = "confirmed"
				}
			}
			intervention["confirmation"] = confirmation
		case "result", "result-recorded":
			var prior Object
			if e["supersedes"] != nil {
				prior = FactAt(facts, "result", object(e["supersedes"]))
				if prior == nil {
					continue
				}
			}
			origin := object(e["origin"])
			if origin == nil {
				origin = Object{"kind": "attempt", "id": e["attemptId"], "version": int64(1)}
			}
			source := FactAt(facts, text(origin, "kind"), origin)
			if source == nil {
				continue
			}
			v := copyObject(base)
			v["id"] = fallback(prior["id"], id)
			v["version"] = number(prior, "version") + 1
			v["origin"] = origin
			records := append([]any{}, list(source["recordEventIds"])...)
			records = append(records, list(prior["recordEventIds"])...)
			v["recordEventIds"] = append(records, id)
			v["deliverableRefs"] = fallback(e["deliverableRefs"], []any{})
			v["reportedOutcome"] = fallback(e["reportedOutcome"], e["outcome"])
			for _, k := range []string{"summary", "limitations"} {
				v[k] = e[k]
			}
			v["acceptance"] = "not-provided"
			v["verification"] = "not-provided"
			v["supersedes"] = e["supersedes"]
			push("results", v)
			if source["resultRefs"] != nil {
				refs := appended(source["resultRefs"], Object{"id": v["id"], "version": v["version"]})
				// The original JS spread retains the shared resultRefs array
				// across all recorded versions of the same Attempt.
				for _, priorVersion := range list(facts["attempts"]) {
					if prior := object(priorVersion); prior["id"] == source["id"] {
						prior["resultRefs"] = refs
					}
				}
			}
		case "resolution-recorded":
			v := copyObject(base)
			for _, k := range []string{"status", "summary", "satisfiedGoals", "remainingGoals", "resultRefs", "verificationRefs", "supersedesResolutionId"} {
				v[k] = e[k]
			}
			v["decisionActor"] = e["actorId"]
			push("resolutions", v)
			facts["resolution"] = v
		}
	}
	facts["scopeVersion"] = int64(1)
	if scopes := list(facts["scopes"]); len(scopes) > 0 {
		facts["scopeVersion"] = object(scopes[len(scopes)-1])["version"]
	}
	facts["resolution"] = CurrentResolution(facts, facts)
	return facts
}
func appended(v any, x any) []any { return append(append([]any{}, list(v)...), x) }
func FactAt(facts Object, kind string, ref Object) Object {
	for _, v := range list(facts[kind+"s"]) {
		o := object(v)
		if o["id"] == ref["id"] && number(o, "version") == number(ref, "version") {
			return o
		}
	}
	return nil
}
func LatestFact(facts Object, kind, id string) Object {
	var out Object
	for _, v := range list(facts[kind+"s"]) {
		if o := object(v); text(o, "id") == id {
			out = o
		}
	}
	return out
}
func CurrentResolution(facts, current Object) Object {
	all := list(facts["resolutions"])
	if len(all) == 0 {
		return Object{"status": "unrecorded"}
	}
	decision := object(all[len(all)-1])
	if number(decision, "scopeVersion") != number(facts, "scopeVersion") {
		return Object{"status": "unrecorded", "scopeVersion": facts["scopeVersion"], "priorResolutionId": decision["id"]}
	}
	for _, r := range list(decision["resultRefs"]) {
		ref := object(r)
		latest := LatestFact(current, "result", text(ref, "id"))
		if latest == nil || number(latest, "version") != number(ref, "version") {
			return Object{"status": "unrecorded", "scopeVersion": facts["scopeVersion"], "priorResolutionId": decision["id"], "currentSupport": "referenced-result-superseded", "currentDecisionAvailable": false, "reconfirmationRequired": true, "summary": "引用的结果已更正，当前解决程度需要重新确认。"}
		}
	}
	return decision
}
func PublicFacts(v any) any {
	if o := object(v); o != nil {
		out := Object{}
		for k, v := range o {
			if k != "recordEventIds" {
				out[k] = PublicFacts(v)
			}
		}
		return out
	}
	if a, ok := v.([]any); ok {
		out := []any{}
		for _, v := range a {
			out = append(out, PublicFacts(v))
		}
		return out
	}
	return v
}
