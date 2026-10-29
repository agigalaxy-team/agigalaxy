package operationspermissions

import "encoding/json"

// The generated catalogs describe static permission definitions, not current
// grants. Build private lookup indexes once; public catalog results remain
// independent copies.
var staticCatalog = compileStaticCatalog()

func compileStaticCatalog() struct {
	codes      []string
	known      map[string]bool
	maintainer map[string]bool
	count      int
} {
	items := catalogItems()
	index := struct {
		codes      []string
		known      map[string]bool
		maintainer map[string]bool
		count      int
	}{
		codes:      make([]string, 0, len(items)),
		known:      make(map[string]bool, len(items)),
		maintainer: map[string]bool{},
		count:      len(items),
	}
	for _, item := range items {
		value := obj(item)["code"]
		index.codes = append(index.codes, str(value))
		if code, ok := value.(string); ok {
			index.known[code] = true
		}
	}
	var maintainers []string
	json.Unmarshal([]byte(maintainerJSON), &maintainers)
	for _, code := range maintainers {
		index.maintainer[code] = true
	}
	return index
}

// PermissionCodes and RequiresManagementMaintainer expose the same generated
// source used by current authorization; consumers must not maintain another ACL.
func PermissionCodes() []string {
	return append([]string{}, staticCatalog.codes...)
}
func RequiresManagementMaintainer(code string) bool {
	return staticCatalog.maintainer[code]
}
func CatalogMetadata() []Object {
	var rows []Object
	json.Unmarshal([]byte(catalogJSON), &rows)
	return rows
}
