package agentos

import "testing"

func TestConversationRetryTemporaryAuthorizationBoundary(t *testing.T) {
	message := "查询当前公开汇总，不作修改。"
	base := Object{
		"runId": "original-native-run", "status": "ERROR", "userInput": message,
		"errorCode": "operations_authorization_unavailable", "failure": nil,
		"businessActivity": Object{"state": "not-started", "basis": "same-owner-turn-tool-and-card-ledger"},
	}
	cases := []struct {
		name    string
		patch   Object
		message string
		want    bool
	}{
		{name: "temporary authorization failure and unstarted ledger", want: true},
		{name: "original input changed", message: "不同的问题"},
		{name: "not terminal", patch: Object{"status": "RUNNING"}},
		{name: "already completed", patch: Object{"status": "COMPLETED"}},
		{name: "missing original run", patch: Object{"runId": ""}},
		{name: "invalid original run", patch: Object{"runId": "other/run"}},
		{name: "actual authority changed", patch: Object{"errorCode": "operations_agentos_authority_changed"}},
		{name: "actual permission denied", patch: Object{"errorCode": "operations_permission_denied"}},
		{name: "unclassified error", patch: Object{"errorCode": "operations_agentos_run_failed"}},
		{name: "explicit rejected failure", patch: Object{"failure": Object{"stage": "model-request", "category": "request-rejected", "reportedStatus": 403}}},
		{name: "no business evidence", patch: Object{"businessActivity": nil}},
		{name: "unknown business effect", patch: Object{"businessActivity": Object{"state": "unknown", "basis": "same-owner-turn-tool-and-card-ledger"}}},
		{name: "existing business records", patch: Object{"businessActivity": Object{"state": "check-records", "basis": "same-owner-turn-tool-and-card-ledger"}}},
		{name: "unbound ledger evidence", patch: Object{"businessActivity": Object{"state": "not-started", "basis": "other"}}},
		{name: "existing timeout retry retained", patch: Object{"errorCode": "operations_agentos_model_request_failed", "failure": Object{"category": "timeout"}}, want: true},
		{name: "model request rejected remains blocked", patch: Object{"errorCode": "operations_agentos_model_request_failed", "failure": Object{"category": "request-rejected"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run := copyObject(base)
			for key, value := range tc.patch {
				run[key] = value
			}
			question := message
			if tc.message != "" {
				question = tc.message
			}
			if got := retryableOriginalConversationRun(run, question); got != tc.want {
				t.Fatalf("retry eligibility = %v, want %v", got, tc.want)
			}
		})
	}
}
