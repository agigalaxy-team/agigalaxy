package operationsautonomy

import "testing"

func TestReadCoverageRequiresCompleteMatchingLaterEvidence(t *testing.T) {
	arg := Object{"module": "maintenance", "view": "overview", "filters": Object{}}
	calls := []Object{
		{"call_id": "failed", "tool": "query-operations", "state": "unknown", "code": "invalid_operations_agentos_query", "arguments": arg, "updated_at": "2026-10-29T01:00:00Z"},
		{"call_id": "other", "tool": "query-operations", "state": "completed", "code": "read-success-complete", "arguments": Object{"module": "audit", "view": "overview", "filters": Object{}}, "updated_at": "2026-10-29T01:00:01Z"},
		{"call_id": "partial", "tool": "query-operations", "state": "completed", "code": "read-success-partial", "arguments": arg, "updated_at": "2026-10-29T01:00:02Z"},
	}
	c := summarizeReadCoverage(calls, nil)
	if len(c["unresolved"].([]Object)) != 0 {
		t.Fatalf("bounded partial should cover same requested page: %#v", c)
	}
	calls = append(calls, Object{"call_id": "complete", "tool": "query-operations", "state": "completed", "code": "read-success-complete", "arguments": arg, "updated_at": "2026-10-29T01:00:03Z"})
	c = summarizeReadCoverage(calls, nil)
	if len(c["unresolved"].([]Object)) != 0 {
		t.Fatalf("complete original scope did not resolve: %#v", c)
	}
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

func TestEmptyPlansOnlyResolveUnspecifiedHistoryWithOriginalEvidence(t *testing.T) {
	failed := Object{"tool": "query-operations", "arguments": Object{"module": "messaging", "view": "history", "filters": Object{}}}
	evidence := Object{"tool": "query-operations", "code": "read-success-empty-complete", "arguments": Object{"module": "messaging", "view": "plans", "filters": Object{}}}
	if !emptyPlansProveNoHistory(failed, evidence) {
		t.Fatal("complete empty plan list not recognized")
	}
	obj(failed["arguments"])["filters"] = Object{"planId": "00000000-0000-0000-0000-000000000001"}
	if emptyPlansProveNoHistory(failed, evidence) {
		t.Fatal("explicit plan history cannot be dismissed")
	}
	obj(failed["arguments"])["filters"] = Object{}
	obj(evidence["arguments"])["filters"] = Object{"state": "active"}
	if emptyPlansProveNoHistory(failed, evidence) {
		t.Fatal("filtered empty list cannot prove all plans absent")
	}
	obj(evidence["arguments"])["filters"] = Object{"after": "1"}
	if emptyPlansProveNoHistory(failed, evidence) {
		t.Fatal("later empty page cannot prove all plans absent")
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
