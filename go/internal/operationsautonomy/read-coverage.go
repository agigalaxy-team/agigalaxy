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
