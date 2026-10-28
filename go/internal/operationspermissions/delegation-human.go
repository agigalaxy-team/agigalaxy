package operationspermissions

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var managementActions = []string{"read", "create", "update", "assign", "revoke", "prompt-read", "prompt-update"}

func parseDelegation(input Object) (Object, error) {
	x := obj(clone(input))
	if !exact(x, []string{"operationId", "expectedVersion", "enabled", "targetAiAccountIds", "grantablePermissions", "allowedManagementActions"}, nil) || !validUUID(x["operationId"]) || !intOK(x["expectedVersion"], 0) || !idsOK(x["targetAiAccountIds"], 4, false) || !permissionList(x["grantablePermissions"]) {
		return nil, invalid()
	}
	if _, ok := x["enabled"].(bool); !ok {
		return nil, invalid()
	}
	a, ok := x["allowedManagementActions"].([]any)
	if !ok || len(a) > 7 {
		return nil, invalid()
	}
	seen := map[string]bool{}
	for _, v := range a {
		p := str(v)
		if !contains(managementActions, p) || seen[p] {
			return nil, invalid()
		}
		seen[p] = true
	}
	return x, nil
}
func safeCeiling(permissions []string) bool {
	for _, p := range permissions {
		for _, prefix := range []string{"ai.roles.", "ai.prompts.", "ai.delegation.", "ai.accounts.", "ai.use."} {
			if len(p) >= len(prefix) && p[:len(prefix)] == prefix {
				return false
			}
		}
		for _, v := range catalogItems() {
			row := obj(v)
			if row["code"] == p && row["humanOnly"] == true {
				return false
			}
		}
	}
	return true
}
func delegationView(r Object) any {
	if r == nil {
		return nil
	}
	return Object{"id": r["id"], "sourceAiAccountId": r["source_ai_account_id"], "version": r["version"], "enabled": r["enabled"], "targetAiAccountIds": r["target_ai_account_ids"], "grantablePermissions": r["grantable_permissions"], "allowedManagementActions": r["allowed_management_actions"], "updatedAt": stamp(r["updated_at"])}
}
func (s *Service) delegationSource(ctx context.Context, tx pgx.Tx) (Object, error) {
	r, e := one(ctx, tx, "SELECT jsonb_build_object('id',id,'domain',domain,'name',name,'enabled',enabled) FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain='overview'", s.Endpoint)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fail("operations_ai_work_not_initialized", 409)
	}
	return r, e
}
func (s *Service) aiAccount(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	r, e := one(ctx, tx, "SELECT jsonb_build_object('id',id,'domain',domain,'name',name,'enabled',enabled) FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND id=$2", s.Endpoint, id)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fail("operations_ai_work_not_initialized", 409)
	}
	return r, e
}
func (s *Service) delegationCurrent(ctx context.Context, tx pgx.Tx, source string) (Object, error) {
	r, e := one(ctx, tx, "SELECT to_jsonb(d) FROM operations_ai_role_delegations_v1 d WHERE endpoint=$1 AND source_ai_account_id=$2", s.Endpoint, source)
	return optionalRow(r, e)
}
func (s *Service) Delegation(ctx context.Context, actor Actor) (Object, error) {
	if s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		fresh, e := s.require(ctx, tx, actor, "ai.delegation.read")
		if e != nil {
			return nil, e
		}
		source, e := s.delegationSource(ctx, tx)
		if e != nil {
			return nil, e
		}
		row, e := s.delegationCurrent(ctx, tx, str(source["id"]))
		if e != nil {
			return nil, e
		}
		targets, e := many(ctx, tx, "SELECT jsonb_build_object('id',id,'domain',domain,'name',name,'enabled',enabled) FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain<>'overview' ORDER BY domain", s.Endpoint)
		if e != nil {
			return nil, e
		}
		if _, e = s.require(ctx, tx, fresh, "ai.delegation.read"); e != nil {
			return nil, e
		}
		return Object{"delegation": delegationView(row), "sourceAiAccount": source, "targetAiAccounts": targets, "checkedAt": s.now(), "readExpiresAt": s.now() + 30}, nil
	})
}
func (s *Service) DelegationOperation(ctx context.Context, actor Actor, id string) (Object, error) {
	if !validUUID(id) {
		return nil, invalid()
	}
	if s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		fresh, e := s.require(ctx, tx, actor, "ai.delegation.read")
		if e != nil {
			return nil, e
		}
		r, e := one(ctx, tx, "SELECT to_jsonb(e) FROM operations_ai_role_delegation_events_v1 e WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, id)
		if errors.Is(e, pgx.ErrNoRows) {
			return Object{"state": "not-recorded", "operationId": id}, nil
		}
		if e != nil {
			return nil, e
		}
		if r["actor_kind"] != "business-operator" || r["actor_id"] != fresh.ID || r["kind"] != "config-save" {
			return nil, fail("operations_ai_delegation_operation_not_found", 404)
		}
		result := obj(clone(r["result"]))
		result["replayed"] = true
		return Object{"state": "recorded", "operationId": id, "selection": r["selection"], "result": result}, nil
	})
}
func (s *Service) SaveDelegation(ctx context.Context, actor Actor, input Object) (Object, error) {
	x, e := parseDelegation(input)
	if e != nil {
		return nil, e
	}
	if s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.require(ctx, tx, actor, "ai.delegation.configure") }); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))", s.Endpoint); e != nil {
			return nil, e
		}
		fresh, e := s.require(ctx, tx, actor, "ai.delegation.configure")
		if e != nil {
			return nil, e
		}
		source, e := s.delegationSource(ctx, tx)
		if e != nil {
			return nil, e
		}
		old, e := s.delegationCurrent(ctx, tx, str(source["id"]))
		if e != nil {
			return nil, e
		}
		replay, e := one(ctx, tx, "SELECT to_jsonb(e) FROM operations_ai_role_delegation_events_v1 e WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, x["operationId"])
		if e == nil {
			if replay["actor_kind"] != "business-operator" || replay["actor_id"] != fresh.ID || replay["kind"] != "config-save" || !same(replay["selection"], x) {
				return nil, fail("operations_ai_delegation_operation_conflict", 409)
			}
			result := obj(clone(replay["result"]))
			result["replayed"] = true
			return result, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		if num(old["version"]) != num(x["expectedVersion"]) {
			return nil, fail("operations_ai_delegation_version_changed", 409)
		}
		if contains(stringsOf(x["targetAiAccountIds"]), str(source["id"])) || !safeCeiling(stringsOf(x["grantablePermissions"])) || subset(fresh, stringsOf(x["grantablePermissions"])) != nil {
			return nil, fail("operations_ai_delegation_ceiling_denied", 403)
		}
		for _, id := range stringsOf(x["targetAiAccountIds"]) {
			if _, e = s.aiAccount(ctx, tx, id); e != nil {
				return nil, e
			}
		}
		at := time.Unix(s.now(), 0)
		id := str(old["id"])
		if id == "" {
			id = uuid.NewString()
		}
		row, e := one(ctx, tx, `INSERT INTO operations_ai_role_delegations_v1(id,endpoint,source_ai_account_id,version,enabled,target_ai_account_ids,grantable_permissions,allowed_management_actions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$10) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,enabled=EXCLUDED.enabled,target_ai_account_ids=EXCLUDED.target_ai_account_ids,grantable_permissions=EXCLUDED.grantable_permissions,allowed_management_actions=EXCLUDED.allowed_management_actions,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at RETURNING to_jsonb(operations_ai_role_delegations_v1)`, id, s.Endpoint, source["id"], num(old["version"])+1, x["enabled"], stringsOf(x["targetAiAccountIds"]), stringsOf(x["grantablePermissions"]), stringsOf(x["allowedManagementActions"]), fresh.ID, at)
		if e != nil {
			return nil, e
		}
		if _, e = s.require(ctx, tx, fresh, "ai.delegation.configure"); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE operations_permission_authority_v1 SET version=version+1 WHERE endpoint=$1", s.Endpoint); e != nil {
			return nil, e
		}
		result := Object{"delegation": delegationView(row), "operationId": x["operationId"], "delegationVersion": row["version"], "recordedAt": stamp(at), "replayed": false}
		_, e = tx.Exec(ctx, `INSERT INTO operations_ai_role_delegation_events_v1(endpoint,operation_id,delegation_id,version,actor_kind,actor_id,kind,selection,result,created_at) VALUES($1,$2,$3,$4,'business-operator',$5,'config-save',$6,$7,$8)`, s.Endpoint, x["operationId"], row["id"], row["version"], fresh.ID, jsonText(x), jsonText(result), at)
		if e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,selection,result,created_at,actor_kind,execution_id,grant_id,actor_context) VALUES($1,$2,$3,$4,'ai-delegation-save',$5,$6,$7,$8,'business-operator',NULL,NULL,NULL)`, uuid.NewString(), s.Endpoint, fresh.ID, fresh.Role, x["operationId"], jsonText(Object{"delegationId": row["id"], "delegationVersion": row["version"], "sourceAiAccountId": row["source_ai_account_id"], "roleId": nil, "aiAccountId": nil}), jsonText(Object{"enabled": row["enabled"], "version": row["version"], "permissionCount": len(arr(row["grantable_permissions"])), "targetCount": len(arr(row["target_ai_account_ids"]))}), at)
		if e != nil {
			return nil, e
		}
		return result, nil
	})
}
