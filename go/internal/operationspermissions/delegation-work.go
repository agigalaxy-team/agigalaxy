package operationspermissions

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type DelegatedOptions struct{ ExpectedDelegationVersion *int64 }
type delegatedCurrent struct {
	Actor  Actor
	Row    Object
	Source string
}

func (s *Service) delegatedCurrentWithin(ctx context.Context, tx pgx.Tx, actor Actor, action string, expected *int64) (delegatedCurrent, error) {
	var out delegatedCurrent
	read := action == "read" || action == "prompt-read"
	permission := "ai.roles." + action
	if action == "prompt-read" {
		permission = "ai.prompts.read"
	}
	if action == "prompt-update" {
		permission = "ai.prompts.update"
	}
	purpose := "prepare"
	if read {
		purpose = "query"
	}
	fresh, domain, accountID, metadata, e := s.delegatedIdentityWithin(ctx, tx, actor, permission, purpose)
	if e != nil {
		return out, e
	}
	if domain != "overview" {
		return out, fail("operations_ai_delegation_source_denied", 403)
	}
	row, e := s.delegationCurrent(ctx, tx, accountID)
	if e != nil {
		return out, e
	}
	if row == nil || row["enabled"] != true || !contains(stringsOf(row["allowed_management_actions"]), action) {
		return out, fail("operations_ai_delegation_denied", 403)
	}
	if expected != nil && num(row["version"]) != *expected || metadata["delegationVersion"] != nil && num(metadata["delegationVersion"]) != num(row["version"]) {
		return out, fail("operations_ai_delegation_version_changed", 409)
	}
	if contains(stringsOf(row["target_ai_account_ids"]), accountID) || !safeCeiling(stringsOf(row["grantable_permissions"])) {
		return out, fail("operations_ai_delegation_ceiling_denied", 403)
	}
	if metadata != nil && action == "prompt-update" {
		task, e := one(ctx, tx, "SELECT to_jsonb(t) FROM(SELECT configuration FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2)t", s.Endpoint, metadata["taskId"])
		if e != nil {
			return out, e
		}
		if !contains(stringsOf(obj(obj(task["configuration"])["plan"])["actions"]), permission) {
			return out, fail("operations_autonomy_scope_denied", 403)
		}
	}
	return delegatedCurrent{fresh, row, accountID}, nil
}
func parseDelegated(input Object, prepare bool) (Object, error) {
	x := obj(clone(input))
	kind := str(x["kind"])
	required := []string{"kind", "expectedVersion", "enabled"}
	optional := []string{}
	if !prepare {
		required = append(required, "operationId")
	}
	if kind == "assignment-save" {
		required = append(required, "aiAccountId", "roleId")
		optional = append(optional, "id")
	} else if kind == "role-create" || kind == "role-update" {
		required = append(required, "name", "description", "permissions", "targetAiAccountIds")
		if kind == "role-update" {
			required = append(required, "id")
		}
	} else {
		return nil, invalid()
	}
	if !exact(x, required, optional) || !intOK(x["expectedVersion"], 0) {
		return nil, invalid()
	}
	if !prepare && !validUUID(x["operationId"]) {
		return nil, invalid()
	}
	if _, ok := x["enabled"].(bool); !ok {
		return nil, invalid()
	}
	if v, ok := x["id"]; ok && !validUUID(v) {
		return nil, invalid()
	}
	if kind == "assignment-save" {
		if !validUUID(x["aiAccountId"]) || !validUUID(x["roleId"]) {
			return nil, invalid()
		}
	} else {
		name, ok := text(x["name"], 1, 120, true)
		if !ok {
			return nil, invalid()
		}
		description, ok := text(x["description"], 0, 1000, false)
		if !ok || !permissionList(x["permissions"]) || !idsOK(x["targetAiAccountIds"], 4, true) {
			return nil, invalid()
		}
		x["name"], x["description"] = name, description
	}
	return x, nil
}
func delegatedAction(x Object) string {
	switch x["kind"] {
	case "role-create":
		return "create"
	case "role-update":
		return "update"
	default:
		if x["enabled"] == true {
			return "assign"
		}
		return "revoke"
	}
}
func allSubset(values, allowed []string) bool {
	for _, v := range values {
		if !contains(allowed, v) {
			return false
		}
	}
	return true
}
func (s *Service) delegatedRoleWithin(ctx context.Context, tx pgx.Tx, delegation Object, id string) (Object, error) {
	role, e := one(ctx, tx, "SELECT to_jsonb(r) FROM operations_business_roles_v1 r WHERE endpoint=$1 AND id=$2 FOR UPDATE", s.Endpoint, id)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fail("operations_role_not_found", 404)
	}
	if e != nil {
		return nil, e
	}
	if role["subject_scope"] != "ai-only" || !allSubset(stringsOf(role["permissions"]), stringsOf(delegation["grantable_permissions"])) || !allSubset(stringsOf(role["managed_ai_account_ids"]), stringsOf(delegation["target_ai_account_ids"])) {
		return nil, fail("operations_ai_delegation_role_denied", 403)
	}
	human, e := exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM operations_role_assignments_v1 WHERE endpoint=$1 AND role_id=$2 AND enabled)", s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if human {
		return nil, fail("operations_ai_role_human_assignment_denied", 403)
	}
	assignments, e := many(ctx, tx, "SELECT jsonb_build_object('ai_account_id',ai_account_id) FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND role_id=$2 AND enabled", s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	for _, v := range assignments {
		account := obj(v)["ai_account_id"]
		if account == delegation["source_ai_account_id"] || !contains(stringsOf(delegation["target_ai_account_ids"]), str(account)) {
			return nil, fail("operations_ai_delegation_self_expansion_denied", 403)
		}
	}
	source, e := exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND role_id=$2 AND ai_account_id=$3)", s.Endpoint, id, delegation["source_ai_account_id"])
	if e != nil {
		return nil, e
	}
	if source {
		return nil, fail("operations_ai_delegation_self_expansion_denied", 403)
	}
	return role, nil
}
func (s *Service) delegatedAvailability(ctx context.Context, tx pgx.Tx, actor Actor) (Object, error) {
	query, domain, accountID, metadata, e := s.delegatedIdentityWithin(ctx, tx, actor, "workbench.read", "query")
	if e != nil {
		return nil, e
	}
	execution, _, _, _, e := s.delegatedIdentityWithin(ctx, tx, actor, "workbench.read", "prepare")
	if e != nil {
		return nil, e
	}
	empty := Object{"canRead": false, "canReadRoles": false, "canReadPrompts": false, "managementActions": []any{}, "promptActions": []any{}, "targetAiAccountIds": []any{}, "delegationId": nil, "version": nil}
	if domain != "overview" {
		return empty, nil
	}
	row, e := s.delegationCurrent(ctx, tx, accountID)
	if e != nil {
		return nil, e
	}
	if row == nil || row["enabled"] != true || metadata["delegationVersion"] != nil && num(metadata["delegationVersion"]) != num(row["version"]) || contains(stringsOf(row["target_ai_account_ids"]), accountID) || !safeCeiling(stringsOf(row["grantable_permissions"])) {
		return empty, nil
	}
	allowed := stringsOf(row["allowed_management_actions"])
	canRoles := contains(allowed, "read") && contains(query.Permissions, "ai.roles.read")
	canPrompts := contains(allowed, "prompt-read") && contains(query.Permissions, "ai.prompts.read")
	actions, prompts := []string{}, []string{}
	for _, action := range []string{"create", "update", "assign", "revoke"} {
		if contains(allowed, action) && contains(execution.Permissions, "ai.roles."+action) {
			actions = append(actions, action)
		}
	}
	if canPrompts {
		prompts = append(prompts, "read")
	}
	if contains(allowed, "prompt-update") && contains(execution.Permissions, "ai.prompts.update") {
		prompts = append(prompts, "update")
	}
	return Object{"canRead": canRoles, "canReadRoles": canRoles, "canReadPrompts": canPrompts, "managementActions": arrayOf(actions), "promptActions": arrayOf(prompts), "targetAiAccountIds": row["target_ai_account_ids"], "delegationId": row["id"], "version": row["version"]}, nil
}
func (s *Service) DelegatedDirectory(ctx context.Context, actor Actor) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		availability, e := s.delegatedAvailability(ctx, tx, actor)
		if e != nil {
			return nil, e
		}
		if availability["canReadRoles"] != true && availability["canReadPrompts"] != true {
			return nil, fail("operations_ai_delegation_denied", 403)
		}
		action := "read"
		if availability["canReadRoles"] != true {
			action = "prompt-read"
		}
		current, e := s.delegatedCurrentWithin(ctx, tx, actor, action, nil)
		if e != nil {
			return nil, e
		}
		roles := []any{}
		roleIDs := []string{}
		if availability["canReadRoles"] == true {
			rows, e := many(ctx, tx, "SELECT jsonb_build_object('id',id) FROM operations_business_roles_v1 WHERE endpoint=$1 AND subject_scope='ai-only' ORDER BY name,id", s.Endpoint)
			if e != nil {
				return nil, e
			}
			for _, v := range rows {
				r, e := s.delegatedRoleWithin(ctx, tx, current.Row, str(obj(v)["id"]))
				if e != nil {
					if fault.Status(e) == 403 {
						continue
					}
					return nil, e
				}
				role := roleView(r)
				usage, e := s.roleUsage(ctx, tx, str(r["id"]))
				if e != nil {
					return nil, e
				}
				for k, v := range usage {
					role[k] = v
				}
				roles = append(roles, role)
				roleIDs = append(roleIDs, str(r["id"]))
			}
		}
		targets := []any{}
		for _, id := range stringsOf(current.Row["target_ai_account_ids"]) {
			a, e := s.aiAccount(ctx, tx, id)
			if e != nil {
				return nil, e
			}
			targets = append(targets, a)
		}
		assignments := []any{}
		if availability["canReadRoles"] == true {
			assignments, e = many(ctx, tx, "SELECT jsonb_build_object('id',id,'aiAccountId',ai_account_id,'roleId',role_id,'enabled',enabled,'version',version) FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND ai_account_id=ANY($2::uuid[]) AND role_id=ANY($3::uuid[]) ORDER BY ai_account_id,id", s.Endpoint, stringsOf(current.Row["target_ai_account_ids"]), roleIDs)
			if e != nil {
				return nil, e
			}
		}
		if _, e = s.delegatedCurrentWithin(ctx, tx, actor, action, nil); e != nil {
			return nil, e
		}
		return Object{"delegation": delegationView(current.Row), "targetAiAccounts": targets, "roles": roles, "assignments": assignments, "availability": availability, "checkedAt": s.now(), "readExpiresAt": s.now() + 30}, nil
	})
}
func (s *Service) delegatedReplay(ctx context.Context, tx pgx.Tx, actor Actor, id, kind string, selection Object) (Object, error) {
	r, e := one(ctx, tx, "SELECT to_jsonb(e) FROM operations_ai_role_delegation_events_v1 e WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, id)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if r["actor_kind"] != s.delegatedActorKind(actor) || r["actor_id"] != actor.ID || r["kind"] != kind || !same(r["selection"], selection) {
		return nil, fail("operations_ai_delegation_operation_conflict", 409)
	}
	result := obj(clone(r["result"]))
	result["replayed"] = true
	return result, nil
}
func (s *Service) delegatedRecord(ctx context.Context, tx pgx.Tx, current delegatedCurrent, operationID, kind string, selection, result Object) (Object, error) {
	row, actor := current.Row, current.Actor
	at := time.Unix(s.now(), 0)
	result["operationId"], result["delegationVersion"], result["recordedAt"], result["replayed"] = operationID, row["version"], stamp(at), false
	actorKind := s.delegatedActorKind(actor)
	auditRole, audit, e := s.delegatedAudit(actor)
	if e != nil {
		return nil, e
	}
	_, e = tx.Exec(ctx, `INSERT INTO operations_ai_role_delegation_events_v1(endpoint,operation_id,delegation_id,version,actor_kind,actor_id,kind,selection,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, s.Endpoint, operationID, row["id"], row["version"], actorKind, actor.ID, kind, jsonText(selection), jsonText(result), at)
	if e != nil {
		return nil, e
	}
	action := map[string]string{"role-create": "ai-role-create", "role-update": "ai-role-update", "assignment-save": "ai-role-assignment-save", "prompt-save": "ai-prompt-save"}[kind]
	role, assignment := obj(result["role"]), obj(result["assignment"])
	roleID := role["id"]
	if roleID == nil {
		roleID = selection["roleId"]
	}
	enabled := role["enabled"]
	if enabled == nil {
		enabled = assignment["enabled"]
	}
	if enabled == nil {
		enabled = row["enabled"]
	}
	version := role["version"]
	if version == nil {
		version = assignment["version"]
	}
	if version == nil {
		version = row["version"]
	}
	permissionCount := len(arr(row["grantable_permissions"]))
	if role["permissions"] != nil {
		permissionCount = len(arr(role["permissions"]))
	}
	auditResult := Object{"enabled": enabled, "version": version, "permissionCount": permissionCount, "targetCount": len(arr(row["target_ai_account_ids"]))}
	if kind == "prompt-save" {
		prompt := obj(result["prompt"])
		auditResult = Object{"revision": prompt["revision"], "promptVersion": prompt["promptVersion"]}
	}
	_, e = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,selection,result,created_at,actor_kind,execution_id,grant_id,actor_context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11)`, uuid.NewString(), s.Endpoint, actor.ID, auditRole, action, operationID, jsonText(Object{"delegationId": row["id"], "delegationVersion": row["version"], "sourceAiAccountId": row["source_ai_account_id"], "roleId": roleID, "aiAccountId": selection["aiAccountId"]}), jsonText(auditResult), at, actorKind, audit)
	if e != nil {
		return nil, e
	}
	return result, nil
}
func (s *Service) delegatedPrepareWithin(ctx context.Context, tx pgx.Tx, current delegatedCurrent, x Object) (any, error) {
	d := current.Row
	if x["kind"] == "assignment-save" {
		id := str(x["aiAccountId"])
		if id == current.Source || !contains(stringsOf(d["target_ai_account_ids"]), id) {
			return nil, fail("operations_ai_delegation_target_denied", 403)
		}
		role, e := s.delegatedRoleWithin(ctx, tx, d, str(x["roleId"]))
		if e != nil {
			return nil, e
		}
		target, e := s.aiAccount(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		if x["enabled"] == true && (role["enabled"] != true || target["enabled"] != true || !contains(stringsOf(role["managed_ai_account_ids"]), id)) {
			return nil, fail("operations_ai_delegation_role_denied", 403)
		}
		old, e := one(ctx, tx, "SELECT to_jsonb(a) FROM operations_ai_work_assignments_v1 a WHERE endpoint=$1 AND ai_account_id=$2 AND role_id=$3", s.Endpoint, id, x["roleId"])
		old, e = optionalRow(old, e)
		if e != nil {
			return nil, e
		}
		if x["id"] != nil {
			if old == nil || old["id"] != x["id"] || num(old["version"]) != num(x["expectedVersion"]) {
				return nil, fail("operations_ai_work_assignment_changed", 409)
			}
		} else if old != nil || num(x["expectedVersion"]) != 0 || x["enabled"] != true {
			return nil, fail("operations_ai_work_assignment_changed", 409)
		}
		if old != nil {
			return Object{"id": old["id"], "enabled": old["enabled"], "version": old["version"]}, nil
		}
		return nil, nil
	}
	if !allSubset(stringsOf(x["targetAiAccountIds"]), stringsOf(d["target_ai_account_ids"])) || contains(stringsOf(x["targetAiAccountIds"]), current.Source) || !allSubset(stringsOf(x["permissions"]), stringsOf(d["grantable_permissions"])) || !safeCeiling(stringsOf(x["permissions"])) {
		return nil, fail("operations_ai_delegation_ceiling_denied", 403)
	}
	for _, id := range stringsOf(x["targetAiAccountIds"]) {
		if _, e := s.aiAccount(ctx, tx, id); e != nil {
			return nil, e
		}
	}
	var old Object
	if x["kind"] == "role-update" {
		r, e := s.delegatedRoleWithin(ctx, tx, d, str(x["id"]))
		if e != nil {
			return nil, e
		}
		old = r
	}
	if num(old["version"]) != num(x["expectedVersion"]) {
		return nil, fail("operations_permissions_version_changed", 409)
	}
	if old != nil {
		assignments, e := many(ctx, tx, "SELECT jsonb_build_object('ai_account_id',ai_account_id) FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND role_id=$2 AND enabled", s.Endpoint, old["id"])
		if e != nil {
			return nil, e
		}
		for _, v := range assignments {
			if !contains(stringsOf(x["targetAiAccountIds"]), str(obj(v)["ai_account_id"])) {
				return nil, fail("operations_ai_delegation_target_denied", 403)
			}
		}
		return roleView(old), nil
	}
	return nil, nil
}
func (s *Service) DelegatedRolePreparation(ctx context.Context, actor Actor, input Object) (Object, error) {
	x, e := parseDelegated(input, true)
	if e != nil {
		return nil, e
	}
	action := delegatedAction(x)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		current, e := s.delegatedCurrentWithin(ctx, tx, actor, action, nil)
		if e != nil {
			return nil, e
		}
		before, e := s.delegatedPrepareWithin(ctx, tx, current, x)
		if e != nil {
			return nil, e
		}
		v := num(current.Row["version"])
		if _, e = s.delegatedCurrentWithin(ctx, tx, actor, action, &v); e != nil {
			return nil, e
		}
		return Object{"command": x, "before": before, "delegationVersion": current.Row["version"], "checkedAt": s.now(), "readExpiresAt": s.now() + 30}, nil
	})
}
func (s *Service) DelegatedRoleSave(ctx context.Context, actor Actor, input Object, options DelegatedOptions) (Object, error) {
	x, e := parseDelegated(input, false)
	if e != nil {
		return nil, e
	}
	action := delegatedAction(x)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))", s.Endpoint); e != nil {
			return nil, e
		}
		current, e := s.delegatedCurrentWithin(ctx, tx, actor, action, options.ExpectedDelegationVersion)
		if e != nil {
			return nil, e
		}
		if replay, e := s.delegatedReplay(ctx, tx, current.Actor, str(x["operationId"]), str(x["kind"]), x); e != nil || replay != nil {
			return replay, e
		}
		if _, e = s.delegatedPrepareWithin(ctx, tx, current, x); e != nil {
			return nil, e
		}
		at := time.Unix(s.now(), 0)
		result := Object{}
		if x["kind"] == "assignment-save" {
			old, e := one(ctx, tx, "SELECT to_jsonb(a) FROM operations_ai_work_assignments_v1 a WHERE endpoint=$1 AND ai_account_id=$2 AND role_id=$3 FOR UPDATE", s.Endpoint, x["aiAccountId"], x["roleId"])
			old, e = optionalRow(old, e)
			if e != nil {
				return nil, e
			}
			if x["id"] != nil {
				if old == nil || old["id"] != x["id"] || num(old["version"]) != num(x["expectedVersion"]) {
					return nil, fail("operations_ai_work_assignment_changed", 409)
				}
			} else if old != nil || num(x["expectedVersion"]) != 0 || x["enabled"] != true {
				return nil, fail("operations_ai_work_assignment_changed", 409)
			}
			id := old["id"]
			if id == nil {
				id = x["operationId"]
			}
			saved, e := one(ctx, tx, `INSERT INTO operations_ai_work_assignments_v1(id,endpoint,ai_account_id,role_id,enabled,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at WHERE $8::boolean AND operations_ai_work_assignments_v1.endpoint=EXCLUDED.endpoint AND operations_ai_work_assignments_v1.ai_account_id=EXCLUDED.ai_account_id AND operations_ai_work_assignments_v1.role_id=EXCLUDED.role_id RETURNING to_jsonb(operations_ai_work_assignments_v1)`, id, s.Endpoint, x["aiAccountId"], x["roleId"], x["enabled"], num(old["version"])+1, at, old != nil)
			if errors.Is(e, pgx.ErrNoRows) {
				return nil, fail("operations_ai_work_assignment_changed", 409)
			}
			if e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE operations_ai_work_accounts_v1 SET version=version+1,authorization_version=authorization_version+1,updated_at=$3 WHERE endpoint=$1 AND id=$2", s.Endpoint, x["aiAccountId"], at); e != nil {
				return nil, e
			}
			result["assignment"] = Object{"id": saved["id"], "aiAccountId": saved["ai_account_id"], "roleId": saved["role_id"], "enabled": saved["enabled"], "version": saved["version"]}
		} else {
			var old Object
			if x["kind"] == "role-update" {
				old, e = s.delegatedRoleWithin(ctx, tx, current.Row, str(x["id"]))
				if e != nil {
					return nil, e
				}
			}
			id := old["id"]
			if id == nil {
				id = x["operationId"]
			}
			conflict, e := exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM operations_business_roles_v1 WHERE endpoint=$1 AND name=$2 AND id<>$3)", s.Endpoint, x["name"], id)
			if e != nil {
				return nil, e
			}
			if conflict {
				return nil, fail("operations_role_name_conflict", 409)
			}
			humanWriter, aiWriter := s.delegatedWriters(current)
			role, e := one(ctx, tx, `INSERT INTO operations_business_roles_v1(id,endpoint,name,description,enabled,version,permissions,subject_scope,managed_ai_account_ids,created_by,updated_by,created_by_ai_account_id,updated_by_ai_account_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'ai-only',$8,$9,$9,$10,$10,$11,$11) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,enabled=EXCLUDED.enabled,version=EXCLUDED.version,permissions=EXCLUDED.permissions,managed_ai_account_ids=EXCLUDED.managed_ai_account_ids,updated_by=EXCLUDED.updated_by,updated_by_ai_account_id=EXCLUDED.updated_by_ai_account_id,updated_at=EXCLUDED.updated_at WHERE $12::boolean AND operations_business_roles_v1.endpoint=EXCLUDED.endpoint AND operations_business_roles_v1.subject_scope='ai-only' RETURNING to_jsonb(operations_business_roles_v1)`, id, s.Endpoint, x["name"], x["description"], x["enabled"], num(old["version"])+1, stringsOf(x["permissions"]), stringsOf(x["targetAiAccountIds"]), humanWriter, aiWriter, at, old != nil)
			if errors.Is(e, pgx.ErrNoRows) {
				return nil, fail("operations_permissions_version_changed", 409)
			}
			if e != nil {
				return nil, e
			}
			result["role"] = roleView(role)
		}
		if _, e = s.delegatedCurrentWithin(ctx, tx, current.Actor, action, options.ExpectedDelegationVersion); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE operations_permission_authority_v1 SET version=version+1 WHERE endpoint=$1", s.Endpoint); e != nil {
			return nil, e
		}
		return s.delegatedRecord(ctx, tx, current, str(x["operationId"]), str(x["kind"]), x, result)
	})
}
func (s *Service) DelegatedManagementOperation(ctx context.Context, actor Actor, id string, kind *string, input Object) (Object, error) {
	if !validUUID(id) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, e := one(ctx, tx, "SELECT to_jsonb(e) FROM operations_ai_role_delegation_events_v1 e WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, id)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		action := "read"
		if row["kind"] == "prompt-save" || row == nil && kind != nil && *kind == "prompt-save" {
			action = "prompt-read"
		}
		current, e := s.delegatedCurrentWithin(ctx, tx, actor, action, nil)
		if e != nil {
			return nil, e
		}
		if row == nil {
			return Object{"state": "not-recorded", "operationId": id}, nil
		}
		if !contains([]string{"prompt-save", "role-create", "role-update", "assignment-save"}, str(row["kind"])) || row["actor_kind"] != s.delegatedActorKind(current.Actor) || row["actor_id"] != current.Actor.ID || row["delegation_id"] != current.Row["id"] || kind != nil && row["kind"] != *kind || input != nil && !same(row["selection"], input) {
			return nil, fail("operations_ai_delegation_operation_not_found", 404)
		}
		selection := obj(row["selection"])
		targets := stringsOf(selection["targetAiAccountIds"])
		if row["kind"] == "prompt-save" || row["kind"] == "assignment-save" {
			targets = []string{str(selection["aiAccountId"])}
		}
		if !allSubset(targets, stringsOf(current.Row["target_ai_account_ids"])) || contains(targets, current.Source) {
			return nil, fail("operations_ai_delegation_target_denied", 403)
		}
		result := obj(clone(row["result"]))
		result["replayed"] = true
		return Object{"state": "recorded", "operationId": id, "kind": row["kind"], "selection": selection, "result": result}, nil
	})
}
