package operationsqueries

// QueryReadPermission exposes the same closed route contract used by Query to
// historical-fact consumers. Composite readers have per-section permissions
// and deliberately cannot be reduced to one permission here.
func QueryReadPermission(tool string, input Object) (string, error) {
	if tool != "query-operations" && tool != "read-operation-object" {
		return "", invalid()
	}
	args, err := parse(tool, input)
	if err != nil {
		return "", err
	}
	permission := readAction(args)
	if permission == "" {
		return "", invalid()
	}
	return permission, nil
}
