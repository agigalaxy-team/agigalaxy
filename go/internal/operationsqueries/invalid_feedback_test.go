package operationsqueries

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestInvalidQueryReturnsClosedSchemaFeedback(t *testing.T) {
	s := &Service{}
	for _, input := range []Object{{"module": "jobs", "view": "list"}, {"module": "messaging", "view": "history", "filters": Object{}}} {
		result, err := s.Query(context.Background(), Actor{}, "overview", "query-operations", input)
		if err != nil || result["availability"] != "invalid-request" || result["effectExecuted"] != false {
			t.Fatalf("feedback: %#v %v", result, err)
		}
		b, _ := json.Marshal(result)
		if input["module"] == "jobs" && (!strings.Contains(string(b), "queue") || !strings.Contains(string(b), "search-recovery")) {
			t.Fatalf("missing queue facts: %s", b)
		}
		if input["module"] == "messaging" && (!strings.Contains(string(b), "planId") || !strings.Contains(string(b), "uuid")) {
			t.Fatalf("missing plan facts: %s", b)
		}
	}
	result, err := s.Query(context.Background(), Actor{}, "overview", "query-operations", Object{"module": "jobs", "view": "list", "filters": Object{"queue": "unknown-private-value", "private-field": "private-value"}})
	b, _ := json.Marshal(result)
	if err != nil || strings.Contains(string(b), "private") {
		t.Fatalf("unsafe feedback: %s %v", b, err)
	}
}
