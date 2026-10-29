package operationsquerycontract

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMissingRequiredAndSafeScope(t *testing.T) {
	jobs := QueryCoverageScope("query-operations", Object{"module": "jobs", "view": "list", "filters": Object{}})
	if jobs["valid"] != false || !strings.Contains(encode(jobs["missingRequired"]), "queue") || !strings.Contains(encode(jobs["filterEnums"]), "messaging-delivery") {
		t.Fatalf("jobs: %#v", jobs)
	}
	message := QueryCoverageScope("query-operations", Object{"module": "messaging", "view": "history", "filters": Object{}})
	if message["valid"] != false || !strings.Contains(encode(message["missingRequired"]), "planId") || obj(message["filterFormats"])["planId"] != "uuid" {
		t.Fatalf("message: %#v", message)
	}
	maintenance := QueryCoverageScope("query-operations", Object{"module": "maintenance", "view": "overview", "filters": Object{}})
	if maintenance["valid"] != true || len(maintenance["allowedFilterKeys"].([]string)) != 0 {
		t.Fatalf("maintenance: %#v", maintenance)
	}
	unknown := QueryCoverageScope("query-operations", Object{"module": "jobs", "view": "list", "filters": Object{"queue": "search-recovery", "SECRET_FIELD": "SECRET_VALUE"}})
	if unknown["unknownFields"] != true || strings.Contains(encode(unknown), "SECRET_") {
		t.Fatalf("unsafe unknown: %#v", unknown)
	}
	bad := QueryCoverageScope("query-operations", Object{"module": "jobs", "view": "list", "filters": Object{"queue": "secret-invalid"}})
	if !strings.Contains(encode(bad["invalidFilterKeys"]), "queue") || strings.Contains(encode(bad), "secret-invalid") {
		t.Fatalf("unsafe invalid: %#v", bad)
	}
}
func TestScopeKeepsFiltersAndExcludesPagination(t *testing.T) {
	first := QueryCoverageScope("query-operations", Object{"module": "feedback", "view": "list", "filters": Object{"days": 7, "limit": 1}})
	second := QueryCoverageScope("query-operations", Object{"module": "feedback", "view": "list", "filters": Object{"days": 7, "limit": 50}})
	if first["valid"] != true || second["valid"] != true || encode(first["filters"]) != encode(second["filters"]) {
		t.Fatalf("pagination: %#v %#v", first, second)
	}
	third := QueryCoverageScope("query-operations", Object{"module": "feedback", "view": "list", "filters": Object{"days": 28}})
	if encode(first["filters"]) == encode(third["filters"]) {
		t.Fatal("distinct day scopes collapsed")
	}
}

func TestEveryGeneratedRouteHasSchemaMetadata(t *testing.T) {
	once.Do(initContract)
	for route := range contract.Filters {
		parts := strings.SplitN(route, ":", 2)
		input := Object{"module": parts[0], "view": parts[1]}
		tool := "query-operations"
		if parts[0] == "read" {
			tool = "read-operation-object"
			input = Object{"kind": parts[1], "id": "11111111-1111-4111-8111-111111111111"}
		}
		scope := QueryCoverageScope(tool, input)
		if _, ok := scope["allowedFilterKeys"]; !ok {
			t.Fatalf("route %s missing metadata: %#v", route, scope)
		}
		if FilterSchema(route) == nil {
			t.Fatalf("route %s failed schema resolution", route)
		}
	}
}
func encode(v any) string { b, _ := json.Marshal(v); return string(b) }
