package agentos

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"slices"
)

type ExecutionAuthorize func(context.Context, pgx.Tx) (operationspermissions.Actor, error)

func (r *ExecutionRecord) View() Object {
	var operator any
	if r.OperatorID != nil {
		operator = *r.OperatorID
	}
	return Object{"id": r.ID, "domain": r.Domain, "grantId": r.GrantID, "grantVersion": r.GrantVersion, "executorKind": r.ExecutorKind, "mode": r.Mode, "operatorId": operator, "createdBy": r.CreatedBy, "actions": append([]string{}, r.Actions...), "resourceIds": append([]string{}, r.ResourceIDs...), "state": r.State, "revision": r.Revision, "sessionId": r.SessionID, "hasPreparedCommand": r.PreparedCommand != nil, "createdAt": r.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"), "updatedAt": r.UpdatedAt.UTC().Format("2006-01-02T15:04:05.000Z")}
}
func (s *Executions) humanWithin(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, authorize ExecutionAuthorize) (operationspermissions.Actor, error) {
	if s.AcceptsExecution(a) || s.Permissions.Authority == nil {
		return operationspermissions.Actor{}, fail("business_admin_denied", 403)
	}
	if authorize != nil {
		fresh, e := authorize(ctx, tx)
		if e != nil {
			return fresh, e
		}
		if fresh.ID != a.ID || fresh.Endpoint != s.Endpoint {
			return operationspermissions.Actor{}, fail("business_admin_denied", 403)
		}
		if a.AIProof != nil {
			scope, e := s.Permissions.AIWorkContext(a)
			if e != nil {
				return fresh, e
			}
			return s.Permissions.HumanAIAccountWithin(ctx, tx, fresh, text(scope, "domain"), text(scope, "accountId"), text(scope, "purpose"), "workbench.read")
		}
		a = fresh
	}
	if a.AIProof != nil {
		scope, e := s.Permissions.AIWorkContext(a)
		if e != nil {
			return operationspermissions.Actor{}, e
		}
		return s.Permissions.HumanAIWithin(ctx, tx, a, text(scope, "domain"), text(scope, "purpose"), "workbench.read")
	}
	return s.Permissions.Authority.RequireWithin(ctx, tx, a, "workbench.read")
}
func (s *Executions) Create(ctx context.Context, a operationspermissions.Actor, input Object, authorize ExecutionAuthorize) (Object, error) {
	x, e := parseExecutionCreate(input)
	if e != nil {
		return nil, e
	}
	if e = s.ready(); e != nil {
		return nil, e
	}
	if authorize == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.humanWithin(ctx, tx, a, authorize)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912410))`, s.Endpoint); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))`, s.Endpoint+":"+text(x, "operationId")); e != nil {
			return nil, e
		}
		var operator, kind, id string
		var oldInput, result Object
		e = tx.QueryRow(ctx, `SELECT operator_id,kind,execution_id::text,input,result FROM operations_agentos_commands_v1 WHERE endpoint=$1 AND id=$2`, s.Endpoint, x["operationId"]).Scan(&operator, &kind, &id, &oldInput, &result)
		if e == nil {
			if operator != actor.ID || kind != "create" || !sameConversationJSON(oldInput, x) {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
			if _, _, e = s.ownedWithin(ctx, tx, actor, id); e != nil {
				return nil, e
			}
			result["operationId"], result["kind"], result["executionId"], result["preparedAction"], result["replayed"] = x["operationId"], "create", id, oldInput["preparedCommand"], true
			return result, nil
		}
		if e != pgx.ErrNoRows {
			return nil, e
		}
		var grant Object
		e = tx.QueryRow(ctx, `SELECT to_jsonb(g) FROM operations_automation_grants_v1 g WHERE endpoint=$1 AND id=$2`, s.Endpoint, x["grantId"]).Scan(&grant)
		if e != nil && e != pgx.ErrNoRows {
			return nil, e
		}
		if grant == nil || grant["enabled"] != true || executionNumber(grant, "version") != executionNumber(x, "expectedGrantVersion") {
			return nil, fail("operations_agentos_authority_changed", 409)
		}
		domain := text(x, "domain")
		actions, ids := executionStrings(x["actions"]), executionStrings(x["resourceIds"])
		if grant["executor_kind"] == "ai" {
			actor, e = s.Permissions.HumanAIWithin(ctx, tx, actor, domain, "execution", "workbench.read")
			if e != nil {
				return nil, e
			}
			scope, e := s.Permissions.AIWorkContext(actor)
			if e != nil {
				return nil, e
			}
			if grant["ai_account_id"] == nil || scope["accountId"] != grant["ai_account_id"] {
				return nil, fail("operations_ai_work_unassigned", 403)
			}
			if _, e = s.Permissions.AIWork.ExecutionRoleWithin(ctx, tx, domain, text(scope, "accountId"), actions); e != nil {
				return nil, e
			}
		}
		if grant["mode"] == "automatic" {
			if _, e = s.Permissions.Authority.RequireWithin(ctx, tx, a, "permissions.automation.write"); e != nil {
				return nil, e
			}
		}
		scope := operationspermissions.AutomationResourceScope(grant)
		if scope["kind"] == "unresolved" && len(actions) > 0 {
			return nil, fail("operations_agentos_scope_unresolved", 403)
		}
		if scope["kind"] == "selected" && !executionSubset(ids, executionStrings(scope["resourceIds"])) || !executionSubset(actions, executionStrings(grant["permissions"])) {
			return nil, fail("operations_agentos_scope_denied", 403)
		}
		for _, code := range actions {
			if !s.supported(code) || executionHumanOnly(code) {
				return nil, fail("operations_agentos_scope_denied", 403)
			}
			var e error
			if actor.AIProof != nil {
				actor, e = s.Permissions.HumanAIWithin(ctx, tx, actor, domain, "execution", code)
			} else {
				actor, e = s.Permissions.Authority.RequireWithin(ctx, tx, actor, code)
			}
			if e != nil {
				return nil, e
			}
		}
		if len(actions) > 0 && len(ids) == 0 {
			return nil, fail("operations_agentos_scope_required", 400)
		}
		if len(actions) > 0 && domain != "governance" {
			return nil, fail("operations_agentos_domain_mismatch", 400)
		}
		if command := object(x["preparedCommand"]); command != nil {
			permission := "content.restore"
			if object(command["input"])["kind"] == "hide" {
				permission = "content.hide"
			}
			if !slices.Contains(ids, text(command, "targetId")) || !slices.Contains(actions, "content.read") || !slices.Contains(actions, permission) {
				return nil, fail("operations_agentos_scope_denied", 403)
			}
		}
		refs := []ExecutionSourceRef{}
		if scope["kind"] == "eligible" && len(actions) > 0 {
			if s.QualifyWithin == nil {
				return nil, fail("operations_agentos_scope_unavailable", 503)
			}
			refs, e = s.QualifyWithin(ctx, tx, domain, actions, ids)
			if e != nil {
				return nil, e
			}
		}
		id, at := uuid.NewString(), s.now()
		var onBehalf, account any
		if grant["mode"] == "assisted" {
			onBehalf = actor.ID
		}
		if grant["executor_kind"] == "ai" {
			account = grant["ai_account_id"]
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_agentos_executions_v1(id,endpoint,grant_id,grant_version,domain,executor_kind,mode,operator_id,created_by,actions,resource_ids,state,revision,session_id,prepared_command,created_at,updated_at,ai_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',1,$12,$13,$14,$14,$15)`, id, s.Endpoint, grant["id"], executionNumber(grant, "version"), domain, grant["executor_kind"], grant["mode"], onBehalf, actor.ID, actions, ids, uuid.NewString(), x["preparedCommand"], at, account); e != nil {
			return nil, e
		}
		for _, ref := range refs {
			if _, e = tx.Exec(ctx, `INSERT INTO operations_agentos_source_refs_v1(execution_id,target_kind,target_id,source_version) VALUES($1,$2,$3,$4)`, id, ref.Kind, ref.ID, ref.Version); e != nil {
				return nil, e
			}
		}
		row, e := s.read(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		result = Object{"operationId": x["operationId"], "kind": "create", "executionId": id, "execution": row.View(), "preparedAction": x["preparedCommand"], "replayed": false}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_agentos_commands_v1(id,endpoint,execution_id,kind,operator_id,input,result,created_at) VALUES($1,$2,$3,'create',$4,$5,$6,$7)`, x["operationId"], s.Endpoint, id, actor.ID, x, result, at); e != nil {
			return nil, e
		}
		return result, nil
	})
}
func (s *Executions) ownedWithin(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, id string) (*ExecutionRecord, operationspermissions.Actor, error) {
	actor, e := s.humanWithin(ctx, tx, a, nil)
	if e != nil {
		return nil, actor, e
	}
	row, e := s.read(ctx, tx, id, false)
	if e != nil {
		return nil, actor, e
	}
	if row == nil || row.CreatedBy != actor.ID {
		return nil, actor, fail("operations_agentos_execution_not_found", 404)
	}
	if row.ExecutorKind == "ai" {
		actor, e = s.Permissions.HumanAIWithin(ctx, tx, actor, row.Domain, "execution", "workbench.read")
		if e != nil {
			return nil, actor, e
		}
		scope, e := s.Permissions.AIWorkContext(actor)
		if e != nil {
			return nil, actor, e
		}
		if row.AIAccountID == nil || scope["accountId"] != *row.AIAccountID {
			return nil, actor, fail("operations_ai_work_unassigned", 403)
		}
		if _, e = s.Permissions.AIWork.ExecutionRoleWithin(ctx, tx, row.Domain, *row.AIAccountID, row.Actions); e != nil {
			return nil, actor, e
		}
		if !executionSubset(row.Actions, actor.Permissions) {
			return nil, actor, fail("operations_permission_denied", 403)
		}
	}
	return row, actor, nil
}
func (s *Executions) Get(ctx context.Context, a operationspermissions.Actor, id string) (Object, error) {
	if e := s.ready(); e != nil {
		return nil, e
	}
	if !validOperationID(id) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, _, e := s.ownedWithin(ctx, tx, a, id)
		if e != nil {
			return nil, e
		}
		at := s.now().Unix()
		return Object{"execution": row.View(), "preparedAction": row.PreparedCommand, "checkedAt": at, "readExpiresAt": at + 30}, nil
	})
}
func (s *Executions) List(ctx context.Context, a operationspermissions.Actor) (Object, error) {
	if e := s.ready(); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.humanWithin(ctx, tx, a, nil)
		if e != nil {
			return nil, e
		}
		rows, e := tx.Query(ctx, `SELECT id::text FROM operations_agentos_executions_v1 WHERE endpoint=$1 AND created_by=$2 ORDER BY created_at DESC,id DESC LIMIT 100`, s.Endpoint, actor.ID)
		if e != nil {
			return nil, e
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return nil, e
			}
			ids = append(ids, id)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, id := range ids {
			row, _, e := s.ownedWithin(ctx, tx, actor, id)
			if e != nil {
				if slices.Contains([]int{403, 409}, fault.Status(e)) {
					continue
				}
				return nil, e
			}
			items = append(items, row.View())
		}
		at := s.now().Unix()
		return Object{"items": items, "checkedAt": at, "readExpiresAt": at + 30}, nil
	})
}
func (s *Executions) Change(ctx context.Context, a operationspermissions.Actor, id string, input Object, authorize ExecutionAuthorize) (Object, error) {
	x, e := parseExecutionState(input)
	if e != nil {
		return nil, e
	}
	if e = s.ready(); e != nil {
		return nil, e
	}
	if !validOperationID(id) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	if authorize == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e = s.humanWithin(ctx, tx, a, authorize); e != nil {
			return nil, e
		}
		_, actor, e := s.ownedWithin(ctx, tx, a, id)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))`, s.Endpoint+":"+text(x, "operationId")); e != nil {
			return nil, e
		}
		var owner, execution string
		var oldInput, result Object
		e = tx.QueryRow(ctx, `SELECT operator_id,execution_id::text,input,result FROM operations_agentos_commands_v1 WHERE endpoint=$1 AND id=$2`, s.Endpoint, x["operationId"]).Scan(&owner, &execution, &oldInput, &result)
		if e == nil {
			if owner != actor.ID || execution != id || !sameConversationJSON(oldInput, x) {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
			result["operationId"], result["kind"], result["executionId"], result["replayed"] = x["operationId"], x["kind"], id, true
			return result, nil
		}
		if e != pgx.ErrNoRows {
			return nil, e
		}
		var revision int64
		var state string
		e = tx.QueryRow(ctx, `SELECT revision,state FROM operations_agentos_executions_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE`, s.Endpoint, id).Scan(&revision, &state)
		if e != nil {
			return nil, e
		}
		if revision != executionNumber(x, "expectedRevision") || state == "stopped" {
			return nil, fail("operations_agentos_execution_changed", 409)
		}
		if x["kind"] == "resume" {
			if _, _, _, e = s.currentWithin(ctx, tx, id, ExecutionActorOptions{InactiveRead: true}); e != nil {
				return nil, e
			}
		}
		next := map[string]string{"pause": "paused", "stop": "stopped", "resume": "active"}[text(x, "kind")]
		at := s.now()
		if _, e = tx.Exec(ctx, `UPDATE operations_agentos_executions_v1 SET state=$3,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, id, next, at); e != nil {
			return nil, e
		}
		row, e := s.read(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		result = Object{"operationId": x["operationId"], "kind": x["kind"], "executionId": id, "execution": row.View(), "replayed": false}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_agentos_commands_v1(id,endpoint,execution_id,kind,operator_id,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, x["operationId"], s.Endpoint, id, x["kind"], actor.ID, x, result, at); e != nil {
			return nil, e
		}
		return result, nil
	})
}
