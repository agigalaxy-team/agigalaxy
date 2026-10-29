package operationsautonomy

import "github.com/agigalaxy-team/agigalaxy/go/internal/operationsquerycontract"

// The read ledger records only status and original closed arguments; no
// returned bodies are retained here or treated as authority.
func readResultStatus(result Object) (string, string) {
	if result["availability"] != "available" || has([]string{"invalid-request", "unavailable", "denied", "changed", "unknown"}, str(result["state"])) {
		return "failed", "read-unavailable"
	}
	if obj(result["data"]) == nil {
		return "failed", "read-unavailable"
	}
	page := obj(result["pagination"])
	if page["complete"] != true {
		return "completed", "read-success-partial"
	}
	data := obj(result["data"])
	if items, ok := data["items"].([]any); ok && len(items) == 0 {
		return "completed", "read-success-empty-complete"
	}
	return "completed", "read-success-complete"
}

// Compare schema-owned semantic scope and preserve pagination coordinates.
// Invalid scope values or missing required fields can never become a wildcard.
func sameReadScope(tool string, failed, success Object) bool {
	if tool == "read-ai-delegation" {
		return sameValue(failed, success)
	}
	first := operationsquerycontract.QueryCoverageScope(tool, failed)
	second := operationsquerycontract.QueryCoverageScope(tool, success)
	if first["invalidRoute"] == true || first["invalidFilters"] == true || first["unknownTopLevel"] == true || first["unknownFilterFields"] == true && len(texts(first["allowedFilterKeys"])) > 0 || len(list(first["invalidFilterKeys"])) > 0 || len(list(first["missingRequired"])) > 0 || second["valid"] != true {
		return false
	}
	for _, key := range []string{"tool", "module", "view", "kind", "id", "filters"} {
		if !sameValue(first[key], second[key]) {
			return false
		}
	}
	a, b := obj(failed["filters"]), obj(success["filters"])
	for _, key := range []string{"after", "limit", "page", "pageSize"} {
		if !sameValue(a[key], b[key]) {
			return false
		}
	}
	return true
}

// Later complete successes may cover an earlier read failure only for the same
// original route and scope; the original failure remains in the ledger.
func summarizeReadCoverage(calls []Object, assessment Object) Object {
	successful, unresolved, unverified := []Object{}, []Object{}, []Object{}
	for _, call := range calls {
		tool := str(call["tool"])
		if tool != "query-operations" && tool != "read-operation-object" && tool != "read-ai-delegation" {
			continue
		}
		args := obj(call["arguments"])
		fact := Object{"callId": call["call_id"], "tool": tool, "module": args["module"], "view": args["view"], "kind": args["kind"], "id": args["id"]}
		code := str(call["code"])
		fact["coverage"] = "failed"
		if code == "read-success-partial" {
			fact["coverage"] = "partial"
		} else if has([]string{"read-success-complete", "read-success-empty-complete"}, code) {
			fact["coverage"] = "complete"
		} else if call["state"] == "completed" && code == "" {
			fact["coverage"] = "unverified"
		}
		if call["state"] == "completed" && has([]string{"read-success-complete", "read-success-empty-complete"}, code) {
			successful = append(successful, fact)
			continue
		}
		legacyUnverified := call["state"] == "completed" && code == ""
		resolved := false
		for _, later := range calls {
			if code != "local-validation-ambiguous" && later["tool"] == call["tool"] && later["state"] == "completed" && has([]string{"read-success-complete", "read-success-empty-complete"}, str(later["code"])) && date(later["updated_at"]).After(date(call["updated_at"])) && sameReadScope(tool, obj(call["arguments"]), obj(later["arguments"])) {
				resolved = true
				break
			}
		}
		if !resolved {
			for _, value := range list(assessment["readResolutions"]) {
				r := obj(value)
				if r["failedCallId"] != call["call_id"] {
					continue
				}
				for _, evidenceID := range texts(r["evidenceCallIds"]) {
					for _, evidence := range calls {
						if evidence["call_id"] != evidenceID || evidence["state"] != "completed" || !date(evidence["updated_at"]).After(date(call["updated_at"])) {
							continue
						}
						if code != "local-validation-ambiguous" && r["resolution"] == "superseded" && evidence["tool"] == call["tool"] && has([]string{"read-success-complete", "read-success-empty-complete"}, str(evidence["code"])) && sameReadScope(tool, args, obj(evidence["arguments"])) {
							resolved = true
						}
						if code != "local-validation-ambiguous" && r["resolution"] == "not-applicable" && emptyPlansProveNoHistory(call, evidence) {
							resolved = true
						}
					}
				}
			}
		}
		if !resolved {
			if legacyUnverified {
				unverified = append(unverified, fact)
			} else {
				unresolved = append(unresolved, fact)
			}
		}
	}
	return Object{"successful": successful, "unresolved": unresolved, "unverified": unverified}
}

// An unfiltered, complete, empty plan list proves there is no plan whose
// history can be selected. It cannot resolve an explicit planId request.
func emptyPlansProveNoHistory(failed, evidence Object) bool {
	if failed["tool"] != "query-operations" || evidence["tool"] != "query-operations" || evidence["code"] != "read-success-empty-complete" {
		return false
	}
	f, e := obj(failed["arguments"]), obj(evidence["arguments"])
	if f["module"] != "messaging" || f["view"] != "history" || e["module"] != "messaging" || e["view"] != "plans" {
		return false
	}
	ff, ef := obj(f["filters"]), obj(e["filters"])
	if str(ff["planId"]) != "" || ef["after"] != nil || ef["state"] != nil {
		return false
	}
	scope := operationsquerycontract.QueryCoverageScope("query-operations", e)
	return scope["valid"] == true && len(obj(scope["filters"])) == 0
}
