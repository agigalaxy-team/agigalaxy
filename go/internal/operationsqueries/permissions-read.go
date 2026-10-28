package operationsqueries

import "context"

func roleItem(x Object) Object {
	return object(project(x, merge(shape("id name createdAt updatedAt", "s"), Object{"enabled": "b", "version": "n", "permissions": []any{"s"}})))
}
func (s *Service) permissionsRead(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if s.Permissions == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	view := args.view
	if args.kind == "role" {
		view = "role"
	}
	value, e := s.Permissions.QueryRead(ctx, a, view, args.id)
	if e != nil {
		return queryResult{}, e
	}
	if args.kind != "" {
		value, e = queryWireSource(value)
		if e != nil {
			return queryResult{}, e
		}
		row := object(value["role"])
		return queryResult{source: value, data: roleItem(row), refs: []reference{{kind: "role", id: args.id, row: row, filters: args.filters}}}, nil
	}
	projector := roleItem
	var kind func(Object) string = fixedKind("role")
	if view == "personnel" {
		kind = nil
		projector = func(x Object) Object {
			return object(project(x, Object{"operatorId": "s", "displayName": "s", "identityState": "s", "authorizationState": "s", "assignments": []any{merge(shape("id operatorId roleId createdAt updatedAt", "s"), Object{"enabled": "b", "version": "n"})}, "effective": Object{"version": "s", "source": "s", "permissions": []any{"s"}}}))
		}
	} else if view == "automation" {
		kind = nil
		projector = func(x Object) Object {
			return object(project(x, merge(shape("id name executorKind mode executionState createdAt updatedAt", "s"), shape("enabled executionAvailable", "b"), Object{"version": "n", "permissions": []any{"s"}, "resourceIds": []any{"s"}})))
		}
	}
	return typedList(args, value, projector, kind)
}
