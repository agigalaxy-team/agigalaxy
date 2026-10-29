package jobs

import (
	"github.com/google/uuid"
	"strings"
	"testing"
)

func TestAutonomyPayloadAttemptPairIsClosed(t *testing.T) {
	task, attempt, session := uuid.NewString(), uuid.NewString(), uuid.NewString()
	cases := []struct {
		name    string
		payload map[string]any
		valid   bool
	}{
		{"legacy", map[string]any{"taskId": task}, true},
		{"legacy-reconcile", map[string]any{"taskId": task, "reconcile": true}, true},
		{"attempt", map[string]any{"taskId": task, "nativeAttemptId": attempt, "sessionId": session}, true},
		{"attempt-reconcile", map[string]any{"taskId": task, "nativeAttemptId": attempt, "sessionId": session, "reconcile": false}, true},
		{"half", map[string]any{"taskId": task, "nativeAttemptId": attempt}, false},
		{"session-only", map[string]any{"taskId": task, "sessionId": session}, false},
		{"both-null", map[string]any{"taskId": task, "nativeAttemptId": nil, "sessionId": nil}, false},
		{"task-noncanonical", map[string]any{"taskId": strings.ToUpper(task)}, false},
		{"null", map[string]any{"taskId": task, "nativeAttemptId": nil, "sessionId": session}, false},
		{"bad", map[string]any{"taskId": task, "nativeAttemptId": attempt, "sessionId": 7}, false},
		{"noncanonical", map[string]any{"taskId": task, "nativeAttemptId": strings.ToUpper(attempt), "sessionId": session}, false},
		{"unknown", map[string]any{"taskId": task, "foo": "bar"}, false},
		{"bad-bool", map[string]any{"taskId": task, "reconcile": "true"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tsk := Task{ID: uuid.NewString(), Endpoint: "test-endpoint", Action: AutonomyTask, SourceID: task, OperationID: uuid.NewString(), Payload: tc.payload}
			if got := tsk.valid(); got != tc.valid {
				t.Fatalf("queue valid=%v want=%v", got, tc.valid)
			}
			parsed, _, err := ParseLegacyPendingTask("test-endpoint", LegacyPendingJob{ID: uuid.NewString(), Queue: AutonomyTask, SingletonKey: "test", Data: tc.payload})
			if (err == nil) != tc.valid {
				t.Fatalf("adoption err=%v", err)
			}
			if err == nil && (parsed.Payload["nativeAttemptId"] != tc.payload["nativeAttemptId"] || parsed.Payload["sessionId"] != tc.payload["sessionId"]) {
				t.Fatal("attempt coordinates lost")
			}
		})
	}
	if validAutonomyPayload(map[string]any{"taskId": task}, uuid.NewString()) {
		t.Fatal("source mismatch accepted")
	}
}
