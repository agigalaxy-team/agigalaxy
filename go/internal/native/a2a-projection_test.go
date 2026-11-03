package native

import "testing"

func TestA2aProjectionRejectsPeerContextAndTerminalStateReplacement(t *testing.T) {
	task := map[string]any{
		"id":        "peer-task",
		"contextId": "peer-context",
		"status":    map[string]any{"state": "TASK_STATE_COMPLETED"},
	}
	snapshot, err := a2aSnapshot(task, nil)
	if err != nil || snapshot["contextId"] != "peer-context" || snapshot["state"] != "completed" {
		t.Fatal("valid peer task was not projected", snapshot, err)
	}
	if _, err = a2aSnapshot(task, map[string]any{"contextId": "another"}); err == nil {
		t.Fatal("peer context replacement accepted")
	}
	if _, err = a2aSnapshot(task, map[string]any{"taskId": "peer-task", "contextId": "peer-context", "state": "failed"}); err == nil {
		t.Fatal("terminal peer state changed")
	}
}
