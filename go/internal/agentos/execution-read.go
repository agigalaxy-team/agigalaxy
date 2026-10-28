package agentos

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"slices"
)

func (s *Executions) Operation(ctx context.Context, a operationspermissions.Actor, id string) (Object, error) {
	if e := s.ready(); e != nil {
		return nil, e
	}
	if !validOperationID(id) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.humanWithin(ctx, tx, a, nil)
		if e != nil {
			return nil, e
		}
		var operator, kind, execution string
		var result Object
		e = tx.QueryRow(ctx, `SELECT operator_id,kind,execution_id::text,result FROM operations_agentos_commands_v1 WHERE endpoint=$1 AND id=$2`, s.Endpoint, id).Scan(&operator, &kind, &execution, &result)
		at := s.now().Unix()
		if e == pgx.ErrNoRows {
			return Object{"operationId": id, "state": "not-recorded", "kind": nil, "checkedAt": at, "readExpiresAt": at + 30}, nil
		}
		if e != nil {
			return nil, e
		}
		if operator != actor.ID {
			return nil, fail("operations_agentos_operation_not_found", 404)
		}
		row, _, e := s.ownedWithin(ctx, tx, actor, execution)
		if e != nil {
			return nil, e
		}
		if _, e = s.humanWithin(ctx, tx, a, nil); e != nil {
			return nil, e
		}
		var run, state any
		if v, ok := result["runId"].(string); ok {
			run = v
		}
		if slices.Contains([]string{"dispatching", "accepted", "unknown", "not-started"}, text(result, "state")) {
			state = result["state"]
		}
		return Object{"operationId": id, "state": "recorded", "kind": kind, "executionId": row.ID, "execution": row.View(), "preparedAction": row.PreparedCommand, "runId": run, "commandState": state, "checkedAt": at, "readExpiresAt": at + 30}, nil
	})
}
func (s *Executions) Options(ctx context.Context, a operationspermissions.Actor) (Object, error) {
	if e := s.ready(); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.humanWithin(ctx, tx, a, nil)
		if e != nil {
			return nil, e
		}
		positions := []operationspermissions.Actor{}
		for _, domain := range operationsai.Domains {
			if !slices.Contains(actor.Permissions, "ai.use."+domain) {
				continue
			}
			person, e := s.Permissions.HumanAIWithin(ctx, tx, actor, domain, "execution", "workbench.read")
			if e != nil {
				if slices.Contains([]int{403, 409}, fault.Status(e)) {
					continue
				}
				return nil, e
			}
			positions = append(positions, person)
		}
		items := []any{}
		at := s.now().Unix()
		if len(positions) == 0 {
			return Object{"items": items, "checkedAt": at, "readExpiresAt": at + 30}, nil
		}
		rows, e := tx.Query(ctx, `SELECT to_jsonb(g) FROM operations_automation_grants_v1 g WHERE endpoint=$1 AND enabled AND mode='assisted' AND executor_kind='ai' ORDER BY created_at,id`, s.Endpoint)
		if e != nil {
			return nil, e
		}
		grants := []Object{}
		for rows.Next() {
			var g Object
			if e = rows.Scan(&g); e != nil {
				rows.Close()
				return nil, e
			}
			grants = append(grants, g)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		for _, g := range grants {
			for _, person := range positions {
				context, e := s.Permissions.AIWorkContext(person)
				if e != nil {
					return nil, e
				}
				if context["accountId"] != g["ai_account_id"] {
					continue
				}
				actions := []string{}
				for _, code := range executionStrings(g["permissions"]) {
					if s.supported(code) && slices.Contains(person.Permissions, code) {
						actions = append(actions, code)
					}
				}
				if len(actions) > 0 {
					scope := operationspermissions.AutomationResourceScope(g)
					supported := []string{}
					for _, code := range executionStrings(g["permissions"]) {
						if operationsai.Autonomous(code) {
							supported = append(supported, code)
						}
					}
					var reason any
					if scope["kind"] == "unresolved" {
						reason = "operations_automation_scope_unresolved"
					} else if len(supported) == 0 {
						reason = "operations_agentos_action_unavailable"
					}
					items = append(items, Object{"id": g["id"], "name": g["name"], "version": g["version"], "domain": context["domain"], "mode": g["mode"], "resourceIds": g["resource_ids"], "resourceScope": scope, "scopeCapability": Object{"state": scope["kind"], "canBindObjects": reason == nil, "reason": reason, "supportedActions": supported}, "actions": actions})
				}
				break
			}
		}
		return Object{"items": items, "checkedAt": at, "readExpiresAt": at + 30}, nil
	})
}
