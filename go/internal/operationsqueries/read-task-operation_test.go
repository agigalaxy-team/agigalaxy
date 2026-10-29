package operationsqueries

import (
	"github.com/google/uuid"
	"testing"
	"time"
)

func TestTaskOperationReadOutcomeOnlyProjectsClosedFacts(t *testing.T) {
	task, operation := uuid.NewString(), uuid.NewString()
	got := PriorReadReceipt("read-task-operation", "completed", Object{"module": "autonomy", "view": "original-operation", "taskId": task, "operationId": operation, "receiptState": "unknown", "command": "private"}, time.Time{})
	if got["module"] != "autonomy" || got["view"] != "original-operation" || got["taskId"] != task || got["operationId"] != operation || got["receiptState"] != "unknown" || got["command"] != nil {
		t.Fatalf("invalid projection %#v", got)
	}
	got = PriorReadReceipt("read-task-operation", "unavailable", Object{"module": "autonomy", "view": "original-operation", "taskId": "bad", "receiptState": "completed"}, time.Time{})
	if got["taskId"] != nil || got["receiptState"] != nil {
		t.Fatalf("invalid fields projected %#v", got)
	}
}
