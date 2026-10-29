package operationsqueries

import "testing"

func TestQueryReadPermissionUsesClosedSourceContract(t *testing.T) {
	permission, err := QueryReadPermission("query-operations", Object{"module": "search", "view": "overview"})
	if err != nil || permission != "search-quality.read" {
		t.Fatalf("search: %q %v", permission, err)
	}
	permission, err = QueryReadPermission("read-operation-object", Object{"kind": "content-tag", "id": "cb34525f-01ce-4ee2-811a-262dbf174121"})
	if err != nil || permission != "content.tags.read" {
		t.Fatalf("tag: %q %v", permission, err)
	}
	if _, err = QueryReadPermission("inspect-operations", Object{}); err == nil {
		t.Fatal("composite reader was reduced to one permission")
	}
	if _, err = QueryReadPermission("query-operations", Object{"module": "jobs", "view": "list"}); err == nil {
		t.Fatal("invalid route arguments accepted")
	}
}
