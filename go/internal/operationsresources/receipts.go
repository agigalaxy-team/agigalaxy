package operationsresources

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) CommandResult(ctx context.Context, a Actor, kind, id, operation string) (Object, error) {
	resource, e := resourceKind(kind)
	if e != nil {
		return nil, e
	}
	if !validID(id) || !validID(operation) {
		return nil, fail("invalid_operations_command_receipt", 400)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		current, e := s.domain().Operation(ctx, tx, a, "resource-read", Object{})
		if e != nil {
			return nil, e
		}
		if s.domain().IsDuty(current) || s.domain().IsExecution(current) {
			return nil, fail("business_admin_denied", 403)
		}
		r, missing, e := s.domain().OperationRecordWithin(ctx, tx, operation)
		if e != nil {
			return nil, e
		}
		state := "not-recorded"
		var name, result any
		if missing {
			state = "unknown"
		} else if r != nil {
			if str(r, "operator_id") != a.ID {
				return nil, fail("operations_command_receipt_not_found", 404)
			}
			state = "unknown"
			selection, original := obj(r, "selection"), obj(r, "result")
			command, visibility, target := obj(selection, "command"), obj(original, "visibility"), obj(original, "target")
			hide := str(command, "kind") == "hide"
			var until any
			if hide {
				until = iso(timeStamp(num(command, "until")))
			}
			_, hiddenOK := visibility["hidden"].(bool)
			valid := str(r, "actor_kind") == "business-operator" && str(r, "action") == "resource-visibility" && str(selection, "operationId") == operation && str(original, "operationId") == operation && iso(original["recordedAt"]) != nil && str(selection, "kind") == kind && str(selection, "id") == id && str(target, "kind") == resource && str(target, "id") == id && integer(original["sourceVersion"], 0, 9007199254740991) && num(original, "sourceVersion") == num(command, "expectedVersion") && integer(visibility["version"], 1, 9007199254740991) && num(visibility, "version") == num(command, "expectedVisibilityVersion")+1 && str(visibility, "operationId") == operation && hiddenOK && yes(visibility, "hidden") == hide && visibility["until"] == until && original["sourcePermissionChanged"] == false
			if valid {
				wire, e := identity.Canonical(Object{"action": "resource-visibility", "selection": selection})
				if e != nil {
					return nil, e
				}
				result = Object{"target": Object{"kind": target["kind"], "id": target["id"]}, "sourceVersion": original["sourceVersion"], "visibility": Object{"version": visibility["version"], "hidden": visibility["hidden"], "until": visibility["until"], "operationId": visibility["operationId"]}, "sourcePermissionChanged": false, "recordedAt": original["recordedAt"], "intentHash": identity.Digest(wire)}
				name, state = "resource-visibility", "recorded"
			}
		}
		if _, e = s.domain().Operation(ctx, tx, current, "resource-read", Object{}); e != nil {
			return nil, e
		}
		return Object{"state": state, "operationId": operation, "kind": name, "result": result, "checkedAt": s.now(), "readExpiresAt": s.now() + 30, "metadataOnly": true}, nil
	})
}
