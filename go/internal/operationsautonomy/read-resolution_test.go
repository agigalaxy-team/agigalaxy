package operationsautonomy

import "testing"

func TestSelectedReadResolutionsRequireOriginalLaterEvidence(t *testing.T) {
	selected := "f85c58ea-b51c-4bb5-9cc3-7fde209e977a"
	failedInspection := "11111111-1111-4111-8111-111111111111"
	failedJobs := "22222222-2222-4222-8222-222222222222"
	evidence := "33333333-3333-4333-8333-333333333333"
	plan := Object{"resourceIds": []any{selected}}
	calls := []Object{
		{"call_id": failedInspection, "tool": "inspect-operations", "state": "completed", "code": "inspection-current-partial", "updated_at": "2026-10-29T01:00:00Z"},
		{"call_id": failedJobs, "tool": "query-operations", "state": "failed", "code": "read-unavailable", "arguments": Object{"module": "jobs", "view": "list", "filters": Object{}}, "updated_at": "2026-10-29T01:00:01Z"},
		{"call_id": evidence, "tool": "read-operation-object", "state": "completed", "code": "read-success-complete", "arguments": Object{"kind": "forum-file", "id": selected}, "updated_at": "2026-10-29T01:00:02Z"},
	}
	resolution := func(failed, cited string) Object {
		return Object{"failedCallId": failed, "resolution": "not-applicable", "evidenceCallIds": []any{cited}}
	}
	assessment := Object{"readResolutions": []any{resolution(failedInspection, evidence), resolution(failedJobs, evidence)}}
	check := func(plan, assessment Object, unresolved, incidental int) {
		t.Helper()
		result := summarizeReadCoverage(calls, plan, assessment)
		if len(result["unresolved"].([]Object)) != unresolved || len(result["incidentalReadFailures"].([]Object)) != incidental {
			t.Fatalf("unexpected coverage %#v", result)
		}
	}
	check(plan, nil, 2, 0)
	check(plan, assessment, 0, 2)
	check(plan, Object{"readResolutions": []any{resolution(failedInspection, "44444444-4444-4444-8444-444444444444")}}, 2, 0)
	check(Object{"resourceIds": []any{selected}, "inspectionProfile": "current-operations-v1"}, assessment, 2, 0)
	calls[1]["tool"] = "read-operation-object"
	calls[1]["arguments"] = Object{"kind": "chat-file", "id": selected}
	check(plan, assessment, 1, 1)
	calls[1]["tool"] = "query-operations"
	calls[1]["arguments"] = Object{"module": "messaging", "view": "history", "filters": Object{"planId": selected}}
	check(plan, assessment, 1, 1)
	calls[1]["arguments"] = Object{"module": "jobs", "view": "list", "filters": Object{"unexpected": "x"}}
	check(plan, assessment, 1, 1)
	calls[2]["code"] = "read-success-partial"
	check(plan, assessment, 2, 0)
}

func TestSelectedReceiptEvidenceDoesNotInventCompletion(t *testing.T) {
	target := "508373a5-cae1-4a62-b9f9-8f9bd4b908cc"
	op := "f74db7af-f0c7-4c38-8466-0ce73d07ead4"
	writer := "44444444-4444-4444-8444-444444444444"
	failed := "22222222-2222-4222-8222-222222222222"
	calls := []Object{
		{"call_id": writer, "operation_id": op, "tool": "execute-operation", "state": "completed", "updated_at": "2026-10-29T01:00:00Z"},
		{"call_id": failed, "tool": "query-operations", "state": "failed", "code": "read-unavailable", "arguments": Object{"module": "jobs", "view": "list", "filters": Object{}}, "updated_at": "2026-10-29T01:00:01Z"},
	}
	plan := Object{"resourceIds": []any{target}}
	receipts := []Object{{"operation_id": op, "target_id": target, "action": "ordinary-strategy-create-draft", "state": "completed", "basis": "persisted-domain-operation-receipt"}}
	assessment := Object{"goalSatisfied": false, "remainingWork": []any{Object{"kind": "action"}}, "readResolutions": []any{Object{"failedCallId": failed, "resolution": "not-applicable", "evidenceCallIds": []any{writer}}}}
	// A validated original receipt remains authoritative if the native call
	// row was left started before its terminal bookkeeping completed.
	calls[0]["state"] = "started"
	facts := selectedReceiptEvidence(calls, receipts, plan)
	coverage := summarizeReadCoverage(calls, plan, assessment, Object{"receipts": facts})
	if len(facts) != 1 || len(coverage["unresolved"].([]Object)) != 0 || len(coverage["incidentalReadFailures"].([]Object)) != 1 || assessment["goalSatisfied"] != false {
		t.Fatalf("original selected receipt not retained: %#v %#v", facts, coverage)
	}
	receipts[0]["state"] = "unknown"
	if len(selectedReceiptEvidence(calls, receipts, plan)) != 0 {
		t.Fatal("unknown receipt cannot prove selected target")
	}
	receipts[0]["state"], receipts[0]["basis"] = "completed", "unverified"
	if len(selectedReceiptEvidence(calls, receipts, plan)) != 0 {
		t.Fatal("unverified receipt cannot prove selected target")
	}
}
