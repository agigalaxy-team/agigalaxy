package operationsqueries

import (
	"github.com/google/uuid"
	"regexp"
	"slices"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsquerycontract"
)

var receiptCode = regexp.MustCompile(`^(?:operations|business_admin|invalid_operations|p13|search_quality|feedback|messaging|content|file|forum)_[a-z0-9_]{1,100}$`)

// PriorReadReceipt projects persisted, already validated routes. Historical null
// routes remain null; neither argument digests nor source text supply a route.
func PriorReadReceipt(tool, state string, metadata Object, observed time.Time) Object {
	if !slices.Contains([]string{"workbench-summary", "query-operations", "read-operation-object", "read-ai-delegation", "read-task-operation"}, tool) || !slices.Contains([]string{"started", "completed", "unavailable"}, state) {
		return nil
	}
	var module, view, result, code, at any
	m, v := str(metadata["module"]), str(metadata["view"])
	if tool == "read-task-operation" && m == "autonomy" && v == "original-operation" {
		module, view = m, v
	}
	if _, ok := views[m]; ok {
		module = m
		if tool == "query-operations" && slices.Contains(views[m], v) || tool == "read-operation-object" && kinds[v] == m || tool == "read-ai-delegation" && m == "permissions" && slices.Contains([]string{"ai-work-prompt", "ai-delegation"}, v) {
			view = v
		}
	}
	if v := str(metadata["state"]); slices.Contains([]string{"available", "unavailable", "not-configured", "not-connected", "read", "invalid-request", "unknown"}, v) {
		result = v
	}
	if v := str(metadata["code"]); receiptCode.MatchString(v) {
		code = v
	}
	if !observed.IsZero() {
		at = observed.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	out := Object{"tool": tool, "module": module, "view": view, "state": state, "resultState": result, "code": code, "observedAt": at}
	if tool == "read-task-operation" {
		for _, key := range []string{"taskId", "operationId"} {
			value := str(metadata[key])
			if _, err := uuid.Parse(value); err == nil {
				out[key] = value
			}
		}
		if slices.Contains([]string{"recorded", "not-recorded", "unknown"}, str(metadata["receiptState"])) {
			out["receiptState"] = metadata["receiptState"]
		}
	}
	return out
}

// ReceiptRoute extracts only schema-defined locators, including when a read
// failed. Invalid route or object identifiers are not inferred.
func ReceiptRoute(tool string, arguments Object) (any, any) {
	scope := operationsquerycontract.QueryCoverageScope(tool, arguments)
	if scope["invalidRoute"] == true {
		return nil, nil
	}
	if tool == "query-operations" {
		return scope["module"], scope["view"]
	}
	if tool == "read-operation-object" {
		kind := str(scope["kind"])
		if module := kinds[kind]; module != "" {
			return module, kind
		}
	}
	return nil, nil
}
