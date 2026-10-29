package operationsqueries

// These fields describe the human-confirmation preparation read only. They do
// not confer execution authority; Duty never receives a fabricated negative.
func preparationBasis(known bool) Object {
	if !known {
		return Object{"capabilityBasis": "not-checked", "executionAuthorized": nil, "recheckedWhenPreparing": true}
	}
	return Object{"capabilityBasis": "human-confirmation-preparation", "executionAuthorized": false, "recheckedWhenPreparing": true}
}

func fileItemPreparation(source Object, known bool) Object {
	out := fileItem(source)
	if !known {
		out["canRetryScan"] = nil
	}
	for k, v := range preparationBasis(known) {
		out[k] = v
	}
	if access := object(out["access"]); access != nil {
		// Owner canStop/canRestore describe direct human execution only.
		// They are not preparation eligibility for an AI-assisted card.
		access["canStop"], access["canRestore"] = nil, nil
		access["capabilityBasis"] = "direct-execution-only"
		sourceEligibility := object(object(source["access"])["preparationEligibility"])
		eligibility := Object{"stop": nil, "restore": nil, "basis": "not-checked", "executionAuthorized": nil, "recheckedWhenPreparing": true}
		if known && sourceEligibility["basis"] == "human-confirmation-preparation" {
			if value, ok := sourceEligibility["stop"].(bool); ok {
				eligibility["stop"] = value
			}
			if value, ok := sourceEligibility["restore"].(bool); ok {
				eligibility["restore"] = value
			}
			eligibility["basis"], eligibility["executionAuthorized"] = "human-confirmation-preparation", false
		}
		access["preparationEligibility"] = eligibility
	}
	return out
}

func projectCasePreparation(data Object, known bool) {
	handling := object(data["handling"])
	if handling == nil {
		return
	}
	if !known {
		handling["canModerate"] = nil
	}
	for k, v := range preparationBasis(known) {
		handling[k] = v
	}
}
