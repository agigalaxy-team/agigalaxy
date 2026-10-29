package operationspermissions

import (
	"encoding/json"
	"testing"
)

func TestStaticCatalogMatchesGeneratedDefinitionsAndReturnsCopies(t *testing.T) {
	var items []Object
	if err := json.Unmarshal([]byte(catalogJSON), &items); err != nil {
		t.Fatal(err)
	}
	var maintainers []string
	if err := json.Unmarshal([]byte(maintainerJSON), &maintainers); err != nil {
		t.Fatal(err)
	}
	codes := PermissionCodes()
	if len(codes) != len(items) || len(codes) == 0 {
		t.Fatalf("catalog length = %d, generated length = %d", len(codes), len(items))
	}
	for i, item := range items {
		code, ok := item["code"].(string)
		if !ok || codes[i] != code || !known(code) {
			t.Fatalf("catalog entry %d differs from generated definition", i)
		}
		if RequiresManagementMaintainer(code) != contains(maintainers, code) {
			t.Fatalf("maintainer requirement differs for %q", code)
		}
	}
	for _, code := range maintainers {
		if !RequiresManagementMaintainer(code) {
			t.Fatalf("generated maintainer requirement missing for %q", code)
		}
	}
	if known("not-a-generated-permission") || RequiresManagementMaintainer("not-a-generated-permission") {
		t.Fatal("unknown permission appeared in static index")
	}
	if !permissionList([]any{codes[0]}) || permissionList([]any{codes[0], codes[0]}) || permissionList([]any{"not-a-generated-permission"}) {
		t.Fatal("permission list validation changed")
	}
	first := codes[0]
	codes[0] = "changed"
	metadata := CatalogMetadata()
	metadata[0]["code"] = "changed"
	rows := catalogItems()
	obj(rows[0])["code"] = "changed"
	if PermissionCodes()[0] != first || !known(first) || str(CatalogMetadata()[0]["code"]) != first || str(obj(catalogItems()[0])["code"]) != first {
		t.Fatal("mutating returned catalog data changed the static index or later results")
	}
}
