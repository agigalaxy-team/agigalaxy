package operationspermissions

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type mutation struct {
	Result          Object
	ResourceID      string
	Version         int64
	Changed         []string
	Enabled         bool
	PermissionCount *int
	Delta           Object
}

func (s *Service) command(ctx context.Context, actor Actor, action, kind string, x Object, operation func(pgx.Tx, Actor) (mutation, error)) (Object, error) {
	if s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	if _, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.require(ctx, tx, actor, action) }); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))", s.Endpoint); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, "INSERT INTO operations_permission_authority_v1(endpoint,version) VALUES($1,0) ON CONFLICT DO NOTHING", s.Endpoint); e != nil {
			return nil, e
		}
		var authorityVersion int64
		if e := tx.QueryRow(ctx, "SELECT version FROM operations_permission_authority_v1 WHERE endpoint=$1 FOR UPDATE", s.Endpoint).Scan(&authorityVersion); e != nil {
			return nil, e
		}
		fresh, e := s.require(ctx, tx, actor, action)
		if e != nil {
			return nil, e
		}
		if fresh.ID != actor.ID {
			return nil, fail("business_admin_denied", 403)
		}
		old, e := one(ctx, tx, "SELECT to_jsonb(e) FROM operations_permission_events_v1 e WHERE endpoint=$1 AND id=$2", s.Endpoint, x["operationId"])
		if e == nil {
			if old["operator_id"] != fresh.ID || old["kind"] != kind || !same(old["input"], x) {
				return nil, fail("operations_permissions_operation_conflict", 409)
			}
			out := obj(clone(old["result"]))
			out["replayed"] = true
			return out, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		saved, e := operation(tx, fresh)
		if e != nil {
			return nil, e
		}
		current, e := s.Authority.EffectiveWithin(ctx, tx, actor)
		if e != nil {
			return nil, e
		}
		if current.ID != actor.ID || current.Endpoint != s.Endpoint {
			return nil, fail("business_admin_denied", 403)
		}
		if _, e = tx.Exec(ctx, "UPDATE operations_permission_authority_v1 SET version=version+1 WHERE endpoint=$1", s.Endpoint); e != nil {
			return nil, e
		}
		at := time.Unix(s.now(), 0).UTC().Format("2006-01-02T15:04:05.000Z")
		receipt := saved.Result
		receipt["delta"], receipt["operationId"], receipt["recordedAt"], receipt["replayed"] = saved.Delta, x["operationId"], at, false
		_, e = tx.Exec(ctx, `INSERT INTO operations_permission_events_v1(id,endpoint,operator_id,kind,resource_id,version,changed_fields,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, x["operationId"], s.Endpoint, fresh.ID, kind, saved.ResourceID, saved.Version, saved.Changed, jsonText(x), jsonText(receipt), at)
		if e != nil {
			return nil, e
		}
		result := Object{"version": saved.Version, "enabled": saved.Enabled}
		if saved.PermissionCount != nil {
			result["permissionCount"] = *saved.PermissionCount
		}
		_, e = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,http_request_id,selection,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, uuid.NewString(), s.Endpoint, fresh.ID, fresh.Role, "permission-"+kind, x["operationId"], actor.RequestID, jsonText(Object{"resourceId": saved.ResourceID, "expectedVersion": x["expectedVersion"], "changedFields": arrayOf(saved.Changed)}), jsonText(result), at)
		if e != nil {
			return nil, e
		}
		return receipt, nil
	})
}
func subset(a Actor, permissions []string) error {
	for _, p := range permissions {
		if !contains(a.Permissions, p) {
			return fail("operations_permission_grant_exceeds_authority", 403)
		}
	}
	return nil
}
func optionalRow(o Object, e error) (Object, error) {
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return o, e
}
func (s *Service) SaveRole(ctx context.Context, a Actor, input Object) (Object, error) {
	x, e := parseCommand("role-save", input)
	if e != nil {
		return nil, e
	}
	return s.command(ctx, a, "permissions.roles.write", "role-save", x, func(tx pgx.Tx, actor Actor) (mutation, error) {
		var old Object
		if x["id"] != nil {
			old, e = one(ctx, tx, "SELECT to_jsonb(r) FROM operations_business_roles_v1 r WHERE endpoint=$1 AND id=$2 FOR UPDATE", s.Endpoint, x["id"])
			old, e = optionalRow(old, e)
			if e != nil {
				return mutation{}, e
			}
			if old == nil {
				return mutation{}, fail("operations_role_not_found", 404)
			}
		}
		if num(old["version"]) != num(x["expectedVersion"]) {
			return mutation{}, fail("operations_permissions_version_changed", 409)
		}
		scope := x["subjectScope"]
		if scope == nil {
			scope = old["subject_scope"]
		}
		if scope == nil {
			scope = "shared"
		}
		oldScope := old["subject_scope"]
		if oldScope == nil {
			oldScope = "shared"
		}
		if old != nil && oldScope != scope {
			return mutation{}, fail("operations_role_scope_immutable", 409)
		}
		if e = subset(actor, stringsOf(x["permissions"])); e != nil {
			return mutation{}, e
		}
		id := str(old["id"])
		if id == "" {
			id = uuid.NewString()
		}
		version := num(old["version"]) + 1
		at := time.Unix(s.now(), 0)
		conflict, e := exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM operations_business_roles_v1 WHERE endpoint=$1 AND name=$2 AND id<>$3)", s.Endpoint, x["name"], id)
		if e != nil {
			return mutation{}, e
		}
		if conflict {
			return mutation{}, fail("operations_role_name_conflict", 409)
		}
		row, e := one(ctx, tx, `INSERT INTO operations_business_roles_v1(id,endpoint,name,description,enabled,version,permissions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$9) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,enabled=EXCLUDED.enabled,version=EXCLUDED.version,permissions=EXCLUDED.permissions,updated_by=EXCLUDED.updated_by,updated_by_ai_account_id=NULL,updated_at=EXCLUDED.updated_at RETURNING to_jsonb(operations_business_roles_v1)`, id, s.Endpoint, x["name"], x["description"], x["enabled"], version, stringsOf(x["permissions"]), actor.ID, at)
		if e != nil {
			return mutation{}, e
		}
		if old == nil && scope == "ai-only" {
			if _, e = tx.Exec(ctx, "UPDATE operations_business_roles_v1 SET subject_scope='ai-only' WHERE endpoint=$1 AND id=$2", s.Endpoint, id); e != nil {
				return mutation{}, e
			}
			row["subject_scope"] = "ai-only"
		}
		fields := []string{}
		for _, key := range []string{"name", "description", "enabled", "permissions"} {
			changed := !same(old[key], x[key])
			if key == "permissions" {
				changed = !sameSet(old[key], x[key])
			}
			if old == nil || changed {
				fields = append(fields, key)
			}
		}
		count := len(arr(x["permissions"]))
		return mutation{Object{"role": roleView(row)}, id, version, fields, x["enabled"].(bool), &count, Object{"kind": "role", "permissions": codesChanged(old["permissions"], x["permissions"]), "enabled": Object{"before": old["enabled"], "after": x["enabled"]}}}, nil
	})
}
func (s *Service) SaveAssignment(ctx context.Context, a Actor, input Object) (Object, error) {
	return s.SaveAssignmentWithTarget(ctx, a, input, nil)
}

// SaveAssignmentWithTarget preserves the original management-account target
// recheck inside the permission command transaction and lock sequence.
func (s *Service) SaveAssignmentWithTarget(ctx context.Context, a Actor, input Object, authorizeTarget func(context.Context, pgx.Tx, Actor) error) (Object, error) {
	x, e := parseCommand("assignment-save", input)
	if e != nil {
		return nil, e
	}
	return s.command(ctx, a, "permissions.assignments.write", "assignment-save", x, func(tx pgx.Tx, actor Actor) (mutation, error) {
		if authorizeTarget != nil {
			if e := authorizeTarget(ctx, tx, actor); e != nil {
				return mutation{}, e
			}
		}
		person, e := exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2)", s.Endpoint, x["operatorId"])
		if e != nil {
			return mutation{}, e
		}
		if !person {
			return mutation{}, fail("operations_person_not_found", 404)
		}
		role, e := one(ctx, tx, "SELECT to_jsonb(r) FROM operations_business_roles_v1 r WHERE endpoint=$1 AND id=$2 FOR SHARE", s.Endpoint, x["roleId"])
		if errors.Is(e, pgx.ErrNoRows) {
			return mutation{}, fail("operations_role_not_found", 404)
		}
		if e != nil {
			return mutation{}, e
		}
		if x["enabled"] == true {
			if role["enabled"] != true {
				return mutation{}, fail("operations_permissions_target_changed", 409)
			}
			if role["subject_scope"] == "ai-only" {
				return mutation{}, fail("operations_ai_role_human_assignment_denied", 403)
			}
			if e = subset(actor, stringsOf(role["permissions"])); e != nil {
				return mutation{}, e
			}
		}
		var old Object
		if x["id"] != nil {
			old, e = one(ctx, tx, "SELECT to_jsonb(a) FROM operations_role_assignments_v1 a WHERE endpoint=$1 AND id=$2 FOR UPDATE", s.Endpoint, x["id"])
			old, e = optionalRow(old, e)
			if e != nil {
				return mutation{}, e
			}
			if old == nil {
				return mutation{}, fail("operations_assignment_not_found", 404)
			}
		}
		if num(old["version"]) != num(x["expectedVersion"]) {
			return mutation{}, fail("operations_permissions_version_changed", 409)
		}
		if old != nil && (old["operator_id"] != x["operatorId"] || old["role_id"] != x["roleId"]) {
			return mutation{}, fail("operations_permissions_target_changed", 409)
		}
		if old == nil {
			found, e := exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM operations_role_assignments_v1 WHERE endpoint=$1 AND operator_id=$2 AND role_id=$3)", s.Endpoint, x["operatorId"], x["roleId"])
			if e != nil {
				return mutation{}, e
			}
			if found {
				return mutation{}, fail("operations_assignment_exists", 409)
			}
		}
		id := str(old["id"])
		if id == "" {
			id = uuid.NewString()
		}
		version := num(old["version"]) + 1
		row, e := one(ctx, tx, `INSERT INTO operations_role_assignments_v1(id,endpoint,operator_id,role_id,enabled,version,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$8) ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at RETURNING to_jsonb(operations_role_assignments_v1)`, id, s.Endpoint, x["operatorId"], x["roleId"], x["enabled"], version, actor.ID, time.Unix(s.now(), 0))
		if e != nil {
			return mutation{}, e
		}
		fields := []string{}
		if old == nil {
			fields = []string{"operatorId", "roleId", "enabled"}
		} else if old["enabled"] != x["enabled"] {
			fields = []string{"enabled"}
		}
		return mutation{Object{"assignment": assignmentView(row)}, id, version, fields, x["enabled"].(bool), nil, Object{"kind": "assignment", "operatorId": row["operator_id"], "roleId": row["role_id"], "enabled": Object{"before": old["enabled"], "after": x["enabled"]}}}, nil
	})
}

// Operation returns the original typed selection and saved projection, never a
// replacement constructed from today's role or assignment state.
func (s *Service) Operation(ctx context.Context, a Actor, id string) (Object, error) {
	if !receiptUUID.MatchString(id) {
		return nil, invalid()
	}
	return s.read(ctx, a, func(tx pgx.Tx, actor Actor) (Object, error) {
		row, e := one(ctx, tx, "SELECT to_jsonb(e) FROM operations_permission_events_v1 e WHERE endpoint=$1 AND id=$2", s.Endpoint, id)
		if errors.Is(e, pgx.ErrNoRows) {
			return Object{"state": "not-recorded", "operationId": id}, nil
		}
		if e != nil {
			return nil, e
		}
		if row["operator_id"] != actor.ID {
			return nil, fail("operations_permissions_operation_not_found", 404)
		}
		return operationReceipt(row)
	})
}
func operationReceipt(row Object) (Object, error) {
	if row["kind"] == "automation-save" {
		return automationReceipt(row)
	}
	unavailable := func() (Object, error) { return nil, fail("operations_permissions_receipt_unavailable", 503) }
	kind := str(row["kind"])
	x, e := parseCommand(kind, obj(row["input"]))
	if e != nil {
		return unavailable()
	}
	selection := Object{"id": x["id"], "expectedVersion": x["expectedVersion"]}
	saved := obj(obj(row["result"])["role"])
	fields := []string{"id", "name", "enabled", "version", "permissions", "createdAt", "updatedAt", "description"}
	key := "role"
	if kind == "role-save" {
		for _, k := range []string{"name", "description", "enabled", "permissions"} {
			selection[k] = x[k]
		}
		if v, ok := x["subjectScope"]; ok {
			selection["subjectScope"] = v
		}
	} else if kind == "assignment-save" {
		key = "assignment"
		saved = obj(obj(row["result"])[key])
		fields = []string{"id", "operatorId", "roleId", "enabled", "version", "createdAt", "updatedAt"}
		for _, k := range []string{"operatorId", "roleId", "enabled"} {
			selection[k] = x[k]
		}
	} else {
		return unavailable()
	}
	projected := Object{}
	for _, k := range fields {
		v, present := saved[k]
		if !present {
			return unavailable()
		}
		switch k {
		case "enabled":
			if _, ok := v.(bool); !ok {
				return unavailable()
			}
		case "version":
			if !intOK(v, 0) {
				return unavailable()
			}
		case "permissions":
			a, ok := v.([]any)
			if !ok {
				return unavailable()
			}
			for _, v := range a {
				if _, ok := v.(string); !ok {
					return unavailable()
				}
			}
		default:
			if _, ok := v.(string); !ok {
				return unavailable()
			}
		}
		projected[k] = v
	}
	if kind == "role-save" {
		if v, ok := saved["subjectScope"]; ok {
			projected["subjectScope"] = v
		}
	}
	return Object{"state": "recorded", "operationId": row["id"], "operatorId": row["operator_id"], "kind": kind, "selection": selection, "result": Object{key: projected, "operationId": row["id"], "recordedAt": stamp(row["created_at"]), "replayed": true}}, nil
}
