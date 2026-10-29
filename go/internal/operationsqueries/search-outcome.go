package operationsqueries

// searchOutcomeFacts derives only same-window request results. A known result
// includes both a nonempty result and a known empty result.
func searchOutcomeFacts(metrics Object) Object {
	known, empty := safeInteger(metrics["resultKnownSearches"]), safeInteger(metrics["noResults"])
	measured, limited := safeInteger(metrics["measuredSearches"]), safeInteger(metrics["scanLimited"])
	out := Object{"basis": "same-window-distinct-search-request-results", "state": "unknown", "knownOutcomeCount": known, "withResultsCount": nil, "noResultsCount": empty, "scanLimitedCount": limited, "definitions": Object{"knownOutcomeCount": "known-result-state-including-zero-results", "withResultsCount": "at-least-one-result", "noResultsCount": "known-zero-results"}}
	if known == nil || empty == nil || measured == nil || limited == nil {
		return out
	}
	k, _ := number(known)
	n, _ := number(empty)
	m, _ := number(measured)
	l, _ := number(limited)
	if n > k || k > m || l > m || k != m-l {
		out["state"] = "inconsistent"
		return out
	}
	out["state"], out["withResultsCount"] = "available", safeInteger(k-n)
	return out
}
