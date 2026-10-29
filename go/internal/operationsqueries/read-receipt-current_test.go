package operationsqueries

import "testing"

func TestReceiptRouteOnlyProjectsValidatedRoute(t *testing.T) {
	module, view := ReceiptRoute("query-operations", Object{"module": "feedback", "view": "list", "filters": Object{"PRIVATE_UNKNOWN": "secret"}})
	if module != "feedback" || view != "list" {
		t.Fatalf("valid route lost: %v %v", module, view)
	}
	module, view = ReceiptRoute("query-operations", Object{"module": "not-a-route", "view": "list"})
	if module != nil || view != nil {
		t.Fatalf("invalid route inferred: %v %v", module, view)
	}
	module, view = ReceiptRoute("read-operation-object", Object{"kind": "feedback", "id": "not-an-id"})
	if module != nil || view != nil {
		t.Fatalf("invalid target inferred: %v %v", module, view)
	}
}
