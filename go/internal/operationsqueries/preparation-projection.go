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
		access["capabilityBasis"] = "direct-execution-only"
		access["preparationEligibility"] = Object{"stop": nil, "restore": nil}
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
