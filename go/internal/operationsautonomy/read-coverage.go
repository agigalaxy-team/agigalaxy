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
func summarizeReadCoverage(calls []Object, plan Object) Object {
	successful, unresolved, unverified, incidental := []Object{}, []Object{}, []Object{}, []Object{}
	profile := currentInspectionPlan(plan)
	for _, call := range calls {
		tool := str(call["tool"])
		if tool != "query-operations" && tool != "read-operation-object" && tool != "read-ai-delegation" && tool != "inspect-operations" {
			continue
		}
		fact := readCoverageFact(call)
		code := str(call["code"])
		if tool == "inspect-operations" {
			if call["state"] == "completed" && has([]string{"inspection-current-complete", "inspection-current-complete-empty-plans"}, code) {
				fact["coverage"] = "profile-complete"
				fact["basis"] = "current-operations-v1"
				successful = append(successful, fact)
				continue
			}
			resolved := false
			for _, later := range calls {
				if later["tool"] == "inspect-operations" && later["state"] == "completed" && has([]string{"inspection-current-complete", "inspection-current-complete-empty-plans"}, str(later["code"])) && date(later["updated_at"]).After(date(call["updated_at"])) {
					resolved = true
					break
				}
			}
			if !resolved {
				fact["coverage"] = "profile-partial"
				fact["basis"] = "current-operations-v1"
				outcome := obj(call["read_outcome"])
				if outcome != nil {
					fact["inspectionOutcome"] = outcome
				} else {
					fact["inspectionOutcome"] = nil
				}
				unresolved = append(unresolved, fact)
			}
			continue
		}
		fact["coverage"] = "failed"
		if code == "read-success-partial" {
			fact["coverage"] = "partial"
			fact["collectionComplete"] = false
		} else if has([]string{"read-success-complete", "read-success-empty-complete"}, code) {
			fact["coverage"] = "complete"
			fact["collectionComplete"] = true
		} else if call["state"] == "completed" && code == "" {
			fact["coverage"] = "unverified"
		}
		if call["state"] == "completed" && has([]string{"read-success-complete", "read-success-empty-complete", "read-success-partial"}, code) {
			successful = append(successful, fact)
			continue
		}
		legacyUnverified := call["state"] == "completed" && code == ""
		resolved := false
		for _, later := range calls {
			if code != "local-validation-ambiguous" && later["tool"] == call["tool"] && later["state"] == "completed" && has([]string{"read-success-complete", "read-success-empty-complete", "read-success-partial"}, str(later["code"])) && date(later["updated_at"]).After(date(call["updated_at"])) && sameReadScope(tool, obj(call["arguments"]), obj(later["arguments"])) {
				resolved = true
				break
			}
		}
		if !resolved && code != "local-validation-ambiguous" {
			for _, evidence := range calls {
				if evidence["state"] == "completed" && date(evidence["updated_at"]).After(date(call["updated_at"])) && inspectionCoversFailure(call, evidence) {
					resolved = true
					break
				}
				if evidence["state"] == "completed" && date(evidence["updated_at"]).After(date(call["updated_at"])) && emptyPlansProveNoHistory(call, evidence) {
					resolved = true
					break
				}
			}
		}

		if !resolved {
			if profile && incidentalInspectionRead(call) {
				fact["reason"] = "not-required-for-current-inspection"
				incidental = append(incidental, fact)
				continue
			}
			if legacyUnverified {
				unverified = append(unverified, fact)
			} else {
				unresolved = append(unresolved, fact)
			}
		}
	}
	return Object{"successful": successful, "unresolved": unresolved, "unverified": unverified, "incidentalReadFailures": incidental}
}

func currentInspectionPlan(plan Object) bool {
	if plan["inspectionProfile"] != "current-operations-v1" {
		return false
	}
	for _, key := range []string{"actions", "grantIds", "strategyIds", "resourceIds", "eventTypes"} {
		if len(list(plan[key])) != 0 {
			return false
		}
	}
	return true
}

func readCoverageFact(call Object) Object {
	tool := str(call["tool"])
	fact := Object{"callId": call["call_id"], "tool": tool}
	if tool == "query-operations" || tool == "read-operation-object" {
		scope := operationsquerycontract.QueryCoverageScope(tool, obj(call["arguments"]))
		for _, key := range []string{"module", "view", "kind", "id"} {
			if scope[key] != nil {
				fact[key] = scope[key]
			}
		}
		safeScope := Object{"filters": scope["filters"], "missingRequired": scope["missingRequired"], "invalidFilterKeys": scope["invalidFilterKeys"], "unknownFields": scope["unknownFields"]}
		paging := Object{}
		for _, key := range []string{"after", "limit", "page", "pageSize"} {
			value, exists := obj(obj(call["arguments"])["filters"])[key]
			if exists && has(texts(scope["allowedFilterKeys"]), key) && !has(texts(scope["invalidFilterKeys"]), key) {
				paging[key] = value
			}
		}
		if len(paging) > 0 {
			safeScope["pagination"] = paging
		}
		fact["scope"] = safeScope
	} else if tool == "read-ai-delegation" {
		id := str(obj(call["arguments"])["aiAccountId"])
		if schemaUUID.MatchString(id) {
			fact["scope"] = Object{"aiAccountId": id}
		}
	}
	return fact
}

// An unrecognizable scope remains unresolved; it cannot safely be declared
// outside the frozen inspection merely because its parameters were invalid.
func incidentalInspectionRead(call Object) bool {
	if call["code"] == "local-validation-ambiguous" {
		return false
	}
	if call["tool"] != "query-operations" && call["tool"] != "read-operation-object" {
		return false
	}
	scope := operationsquerycontract.QueryCoverageScope(str(call["tool"]), obj(call["arguments"]))
	if scope["invalidRoute"] == true || scope["unknownTopLevel"] == true || scope["unknownFilterFields"] == true || scope["invalidFilters"] == true || len(list(scope["invalidFilterKeys"])) > 0 {
		return false
	}
	return !inspectionCoversFailure(call, Object{"tool": "inspect-operations", "code": "inspection-current-complete"})
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

// A fixed inspection covers only its documented overview scopes, never a
// selected object, filtered queue, different window or requested later page.
func inspectionCoversFailure(failed, evidence Object) bool {
	if failed["tool"] != "query-operations" || evidence["tool"] != "inspect-operations" || !has([]string{"inspection-current-complete", "inspection-current-complete-empty-plans"}, str(evidence["code"])) {
		return false
	}
	args := obj(failed["arguments"])
	filters := obj(args["filters"])
	if filters["after"] != nil || filters["page"] != nil || filters["pageSize"] != nil {
		return false
	}
	module, view := str(args["module"]), str(args["view"])
	if module == "jobs" && view == "list" {
		return len(filters) == 0
	}
	if module == "messaging" && view == "history" {
		return evidence["code"] == "inspection-current-complete-empty-plans" && len(filters) == 0
	}
	if module == "messaging" && view == "plans" {
		for k := range filters {
			if k != "limit" {
				return false
			}
		}
		return true
	}
	return fixedOverviewScope(failed)
}

// fixedOverviewScope classifies an existing query's bounded overview scope;
// it does not assert that any inspection or business read occurred.
func fixedOverviewScope(failed Object) bool {
	args := obj(failed["arguments"])
	filters := obj(args["filters"])
	if filters["after"] != nil || filters["page"] != nil || filters["pageSize"] != nil {
		return false
	}
	module, view := str(args["module"]), str(args["view"])
	if view != "overview" {
		return false
	}
	expected := map[string]int64{"search": 7, "recommendations": 30, "analytics": 7, "maintenance": 0}
	days, ok := expected[module]
	if !ok {
		return false
	}
	for k := range filters {
		allowed := k == "days" || module == "search" && has([]string{"limit", "query", "issue"}, k) || module == "recommendations" && k == "query"
		if !allowed && module != "maintenance" {
			return false
		}
	}
	scope := operationsquerycontract.QueryCoverageScope("query-operations", obj(clone(args)))
	if scope["invalidRoute"] == true || scope["invalidFilters"] == true || scope["unknownTopLevel"] == true || len(list(scope["invalidFilterKeys"])) > 0 || len(list(scope["missingRequired"])) > 0 {
		return false
	}
	sf := obj(scope["filters"])
	if days == 0 {
		return len(sf) == 0
	}
	profileScope := operationsquerycontract.QueryCoverageScope("query-operations", obj(clone(Object{"module": module, "view": view, "filters": Object{"days": days}})))
	if profileScope["valid"] != true || !sameValue(sf, profileScope["filters"]) {
		return false
	}
	if module == "search" && filters["limit"] != nil && num(filters["limit"]) > 20 {
		return false
	}
	return true
}
