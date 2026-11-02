package operationsautonomy

import "testing"

func TestReadResultStatusPreservesAvailabilityAndPageOutcome(t *testing.T) {
	state, code := readResultStatus(Object{"availability": "available", "data": Object{"items": []any{}}, "pagination": Object{"complete": true}})
	if state != "completed" || code != "read-success-empty-complete" {
		t.Fatalf("empty %s %s", state, code)
	}
	_, code = readResultStatus(Object{"availability": "available", "data": Object{}, "pagination": Object{"complete": true}})
	if code == "read-success-empty-complete" {
		t.Fatal("missing items inferred empty")
	}
	state, _ = readResultStatus(Object{"availability": "unavailable"})
	if state != "failed" {
		t.Fatalf("unavailable %s", state)
	}
}

func TestReadScopeUsesContractAndKeepsRequiredAndPaginationBoundaries(t *testing.T) {
	bad := Object{"module": "maintenance", "view": "overview", "filters": Object{"bad-field": "ignored"}}
	good := Object{"module": "maintenance", "view": "overview", "filters": Object{}}
	if !sameReadScope("query-operations", bad, good) {
		t.Fatal("extra invalid field prevented same route repair")
	}
	missing := Object{"module": "jobs", "view": "list", "filters": Object{}}
	one := Object{"module": "jobs", "view": "list", "filters": Object{"queue": "information-watch"}}
	if sameReadScope("query-operations", missing, one) {
		t.Fatal("missing required queue became wildcard")
	}
	page1 := Object{"module": "feedback", "view": "list", "filters": Object{"limit": 20}}
	page2 := Object{"module": "feedback", "view": "list", "filters": Object{"limit": 20, "after": "00000000-0000-0000-0000-000000000001"}}
	if sameReadScope("query-operations", page1, page2) {
		t.Fatal("later page covered first page")
	}
}

func TestFixedInspectionOnlyCoversItsDocumentedCurrentScopes(t *testing.T) {
	evidence := Object{"tool": "inspect-operations", "code": "inspection-current-complete"}
	query := func(module, view string, filters Object) Object {
		return Object{"tool": "query-operations", "arguments": Object{"module": module, "view": view, "filters": filters}}
	}
	for _, call := range []Object{query("jobs", "list", Object{}), query("maintenance", "overview", Object{}), query("search", "overview", Object{"days": 7, "limit": 20}), query("search", "overview", Object{"days": 7, "query": "", "issue": "all"}), query("recommendations", "overview", Object{"days": 30}), query("analytics", "overview", Object{"days": 7}), query("messaging", "plans", Object{})} {
		if !inspectionCoversFailure(call, evidence) {
			t.Fatalf("expected current scope covered: %#v", call)
		}
	}
	for _, call := range []Object{query("jobs", "list", Object{"queue": "information-watch"}), query("search", "overview", Object{"days": 30}), query("search", "overview", Object{"days": 7, "limit": 50}), query("analytics", "overview", Object{"days": 30}), query("messaging", "plans", Object{"state": "active"}), query("messaging", "history", Object{})} {
		if inspectionCoversFailure(call, evidence) {
			t.Fatalf("unrelated scope covered: %#v", call)
		}
	}
	evidence["code"] = "inspection-current-complete-empty-plans"
	if !inspectionCoversFailure(query("messaging", "history", Object{}), evidence) || inspectionCoversFailure(query("messaging", "history", Object{"planId": "00000000-0000-0000-0000-000000000001"}), evidence) {
		t.Fatal("empty-plan history proof too broad")
	}
}
