package operationspermissions

import "encoding/json"

// PermissionCodes and RequiresManagementMaintainer expose the same generated
// source used by current authorization; consumers must not maintain another ACL.
func PermissionCodes() []string {
	out := []string{}
	for _, v := range catalogItems() {
		out = append(out, str(obj(v)["code"]))
	}
	return out
}
func RequiresManagementMaintainer(code string) bool {
	var a []string
	json.Unmarshal([]byte(maintainerJSON), &a)
	return contains(a, code)
}
func CatalogMetadata() []Object {
	var rows []Object
	json.Unmarshal([]byte(catalogJSON), &rows)
	return rows
}
