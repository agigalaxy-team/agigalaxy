package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

const BoundaryPrompt = "只处理本任务的用途与获准资料；当前角色、授权、对象条件和人工要求由服务逐次核对。模型结束不等于业务完成。未知结果查询原操作；停止或人工接管后不得继续写入。不得更改模型、凭据、人员授权或绕过人工批准。"

func (s *Service) toolsWithin(ctx context.Context, tx pgx.Tx, row Object, actor Actor) ([]string, error) {
	if s.AIWork == nil {
		return nil, dutyFail("operations_ai_work_unavailable")
	}
	id := str(row["ai_account_id"])
	role, e := s.AIWork.AuthorizationWithin(ctx, tx, str(row["domain"]), &id)
	if e != nil {
		return nil, e
	}
	caps := operationsai.Capabilities(str(row["domain"]), role.Permissions)
	tools := []string{"assess-task", "reconcile-task-operations"}
	if len(texts(caps["queryPermissions"])) > 0 {
		tools = append(tools, "current-summary")
		if s.QueryTool != nil {
			tools = append(tools, "query-operations", "read-operation-object")
		}
	}
	plan := obj(obj(row["configuration"])["plan"])
	if s.ExecuteDutyOperation != nil && has([]string{"ai", "code"}, str(row["mode"])) && s.ActionReady != nil {
		for _, code := range texts(plan["actions"]) {
			definition := operationsai.Definition(code)
			if has(role.Permissions, code) && definition["autonomous"] == true && definition["query"] != true && s.ActionReady(code) {
				tools = append(tools, "execute-operation")
				break
			}
		}
	}
	if s.Permissions != nil {
		d, e := s.Permissions.DelegationAvailabilityWithin(ctx, tx, actor)
		if e != nil {
			return nil, e
		}
		if d["canReadRoles"] == true || d["canReadPrompts"] == true || d["canRead"] == true {
			tools = append(tools, "read-ai-delegation")
		}
		if has([]string{"ai", "code"}, str(row["mode"])) {
			for _, a := range texts(d["managementActions"]) {
				if has(texts(plan["actions"]), "ai.roles."+a) {
					tools = append(tools, "manage-ai-role")
					break
				}
			}
			if has(texts(d["promptActions"]), "update") && has(texts(plan["actions"]), "ai.prompts.update") {
				tools = append(tools, "manage-ai-prompt")
			}
		}
	}
	return tools, nil
}
func (s *Service) Authorize(ctx context.Context, input Object) (Object, error) {
	if !closed(input, []string{"taskId", "operation"}, nil) || !schemaUUID.MatchString(str(input["taskId"])) || !has([]string{"read", "run", "tool"}, str(input["operation"])) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, e := s.taskWithin(ctx, tx, str(input["taskId"]), "")
		if e != nil {
			return nil, e
		}
		tools := []string{}
		var roleVersion any
		var dutyActor Actor
		if input["operation"] != "read" {
			actor, e := s.DutyForTaskWithin(ctx, tx, str(row["id"]), "query")
			if e != nil {
				return nil, e
			}
			dutyActor = actor
			roleVersion = actor.Version
			tools, e = s.toolsWithin(ctx, tx, row, actor)
			if e != nil {
				return nil, e
			}
		} else if row["dispatch_started_at"] == nil {
			return nil, fail("operations_autonomy_task_inactive")
		}
		sources := Object{"sourceTargets": []Object{}, "sourceCoverage": "unavailable", "basis": "task-event-locators-not-current-source-authorization"}
		if input["operation"] != "read" {
			sources, e = s.taskEventSourcesWithin(ctx, tx, row, dutyActor)
			if e != nil {
				return nil, e
			}
		}
		cfg := obj(row["configuration"])
		plan := obj(cfg["plan"])
		continuation, e := s.TaskContinuationWithin(ctx, tx, str(row["id"]))
		if e != nil {
			return nil, e
		}
		round := obj(cfg["runtime"])["roundSeconds"]
		if round == nil {
			round = s.defaultNumber("roundSeconds")
		}
		completion, e := s.completionWithin(ctx, tx, row, row["mode"] != "code")
		if e != nil {
			return nil, e
		}
		task := Object{"completion": completion, "taskId": row["id"], "operationId": row["id"], "planId": row["config_id"], "planVersion": row["plan_version"], "promptVersion": row["prompt_version"], "delegationVersion": row["delegation_version"], "domain": row["domain"], "aiAccountId": row["ai_account_id"], "mode": row["mode"], "source": row["source"], "purpose": cfg["purpose"], "sessionId": row["session_id"], "roleVersion": roleVersion, "scopeVersion": row["plan_version"], "state": row["state"], "businessState": row["business_state"], "effectiveCheck": row["effective_check"], "roundSeconds": round, "continuation": continuation, "prompt": Object{"boundary": BoundaryPrompt, "role": cfg["prompt"], "context": Object{"title": row["title"], "source": row["source"], "sourceTargets": sources["sourceTargets"], "sourceCoverage": sources["sourceCoverage"], "sourceBasis": sources["basis"], "goal": cfg["goal"]}}, "plan": plan, "scope": Object{"actions": plan["actions"], "resourceIds": plan["resourceIds"]}, "modelBinding": Object{"domain": row["domain"], "source": "current-manual-model-settings"}, "tools": tools}
		if v, ok := cfg["runtime"]; ok {
			task["runtime"] = v
		}
		return Object{"allowed": true, "task": task, "readExpiresAt": s.now().Unix() + 30}, nil
	})
}
