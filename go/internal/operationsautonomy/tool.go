package operationsautonomy

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var toolNames = []string{"current-summary", "query-operations", "read-operation-object", "execute-operation", "manage-ai-role", "manage-ai-prompt", "read-ai-delegation"}

func parseTool(input Object) (Object, error) {
	if !closed(input, []string{"taskId", "callId", "tool", "arguments"}, []string{"nativeRunId"}) || !schemaUUID.MatchString(str(input["taskId"])) || !schemaUUID.MatchString(str(input["callId"])) || !has(toolNames, str(input["tool"])) || obj(input["arguments"]) == nil {
		return nil, invalid()
	}
	if v, ok := input["nativeRunId"]; ok && !nativeRunPattern.MatchString(str(v)) {
		return nil, invalid()
	}
	return obj(clone(input)), nil
}

type toolBinding struct {
	row, prior  Object
	actor       Actor
	operationID string
}

func errorCode(e error) string {
	var f *fault.Error
	if errors.As(e, &f) && safeCode.MatchString(f.Code) {
		return f.Code
	}
	return "operations_autonomy_unavailable"
}
func (s *Service) taskSummaryWithin(ctx context.Context, tx pgx.Tx, row Object) (Object, error) {
	current, e := s.taskWithin(ctx, tx, str(row["id"]), "")
	if e != nil {
		return nil, e
	}
	actor, e := s.DutyForTaskWithin(ctx, tx, str(current["id"]), "query")
	if e != nil {
		return nil, e
	}
	var management Object
	state := "not-configured"
	if s.Permissions != nil {
		management, e = s.Permissions.ManagementCapabilitiesWithin(ctx, tx, actor)
		if e != nil {
			return nil, e
		}
		state = "available"
	}
	out := Object{"tool": "current-summary", "availability": "available", "basis": "capability-discovery-not-business-inspection", "inspectionChecked": false, "taskVersionBasis": "persisted-task-snapshot-with-current-authority", "task": Object{"taskId": current["id"], "aiAccountId": current["ai_account_id"], "domain": current["domain"], "source": current["source"], "mode": current["mode"], "state": current["state"], "planId": current["config_id"], "configRevision": current["config_revision"], "planVersion": current["plan_version"], "promptVersion": current["prompt_version"], "delegationVersion": current["delegation_version"], "roleVersion": actor.Version}, "queryAccess": operationsai.QueryAccess(actor.Permissions), "managementCapabilities": management, "managementAvailability": state}
	return s.stamp(out), nil
}
func (s *Service) Tool(ctx context.Context, input Object, ruleSource bool) (Object, error) {
	x, e := parseTool(input)
	if e != nil {
		return nil, e
	}
	binding, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (toolBinding, error) {
		row, e := s.taskWithin(ctx, tx, str(x["taskId"]), "")
		if e != nil {
			return toolBinding{}, e
		}
		actor, e := s.DutyForTaskWithin(ctx, tx, str(row["id"]), "query")
		if e != nil {
			return toolBinding{}, e
		}
		if str(row["native_run_id"]) != "" && row["native_run_id"] != x["nativeRunId"] {
			return toolBinding{}, fault.New("operations_autonomy_scope_denied", 403)
		}
		tools, e := s.toolsWithin(ctx, tx, row, actor)
		if e != nil {
			return toolBinding{}, e
		}
		if !has(tools, str(x["tool"])) {
			return toolBinding{}, fault.New("operations_permission_denied", 403)
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912481))`, str(row["id"])+":"+str(x["callId"])); e != nil {
			return toolBinding{}, e
		}
		prior, e := optional(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_tool_calls_v1 c WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, s.Endpoint, row["id"], x["callId"])
		if e != nil {
			return toolBinding{}, e
		}
		if prior != nil && (prior["tool"] != x["tool"] || !sameValue(prior["arguments"], x["arguments"])) {
			return toolBinding{}, fail("operations_autonomy_operation_conflict")
		}
		operationID := str(prior["operation_id"])
		if prior == nil {
			operationID = uuid.NewString()
			if _, e = tx.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'started',$7,$7)`, s.Endpoint, row["id"], x["callId"], x["tool"], jsonText(x["arguments"]), operationID, s.now()); e != nil {
				return toolBinding{}, e
			}
		}
		actor, e = s.BindDutyAuditSourceWithin(ctx, tx, actor, str(x["callId"]), operationID, ptr(x["nativeRunId"]), ruleSource)
		return toolBinding{row, prior, actor, operationID}, e
	})
	if e != nil {
		return nil, e
	}
	result, e := func() (Object, error) {
		row, actor, operationID := binding.row, binding.actor, binding.operationID
		tool, args := str(x["tool"]), obj(x["arguments"])
		if tool == "query-operations" || tool == "read-operation-object" {
			if s.QueryTool == nil {
				return nil, fault.New("operations_autonomy_tool_not_configured", 503)
			}
			return s.QueryTool(ctx, actor, str(row["domain"]), tool, args)
		}
		if tool == "current-summary" {
			if len(args) != 0 {
				return nil, invalid()
			}
			if s.SummaryForTask != nil {
				return s.SummaryForTask(ctx, actor, row)
			}
			return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.taskSummaryWithin(ctx, tx, row) })
		}
		if !has([]string{"ai", "code"}, str(row["mode"])) && has([]string{"execute-operation", "manage-ai-role", "manage-ai-prompt"}, tool) {
			return nil, fail("operations_autonomy_human_required")
		}
		plan := obj(obj(row["configuration"])["plan"])
		if tool == "manage-ai-role" {
			action := "revoke"
			if args["kind"] == "role-create" {
				action = "create"
			} else if args["kind"] == "role-update" {
				action = "update"
			} else if args["enabled"] == true {
				action = "assign"
			}
			if !has(texts(plan["actions"]), "ai.roles."+action) {
				return nil, fault.New("operations_autonomy_scope_denied", 403)
			}
		}
		if tool == "manage-ai-prompt" && !has(texts(plan["actions"]), "ai.prompts.update") {
			return nil, fault.New("operations_autonomy_scope_denied", 403)
		}
		return s.dutyTool(ctx, row, actor, operationID, tool, args, binding.prior != nil)
	}()
	if e == nil {
		_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
			current, e := s.taskWithin(ctx, tx, str(x["taskId"]), "")
			if e != nil {
				return false, e
			}
			tool := str(x["tool"])
			if has([]string{"current-summary", "query-operations", "read-operation-object"}, tool) {
				if _, e = s.DutyForTaskWithin(ctx, tx, str(current["id"]), "query"); e != nil {
					return false, e
				}
			}
			state := "completed"
			var code any
			if result["state"] == "waiting-human" {
				state = "waiting-human"
				code = result["reason"]
				if code == nil {
					code = result["code"]
				}
				if code == nil {
					code = "operations_autonomy_human_required"
				}
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET state=$5,code=$6,updated_at=$4 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, s.Endpoint, x["taskId"], x["callId"], s.now(), state, code); e != nil {
				return false, e
			}
			if result["availability"] == "available" && (has([]string{"query-operations", "read-operation-object"}, tool) || tool == "current-summary" && result["inspectionChecked"] == true) {
				if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET effective_check=true,updated_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, x["taskId"], s.now()); e != nil {
					return false, e
				}
			}
			if receipt := obj(result["businessReceipt"]); receipt != nil {
				if result["operationId"] != binding.operationID {
					return false, fail("operations_autonomy_operation_conflict")
				}
				if e = s.RecordBusinessReceiptWithin(ctx, tx, BusinessReceipt{TaskID: str(x["taskId"]), OperationID: binding.operationID, Action: str(receipt["action"]), TargetType: ptr(receipt["targetType"]), TargetID: ptr(receipt["targetId"]), State: str(receipt["state"]), Basis: str(receipt["basis"]), Details: obj(receipt["details"])}); e != nil {
					return false, e
				}
			}
			if result["state"] == "waiting-human" {
				code := str(result["reason"])
				if code == "" {
					code = "operations_autonomy_human_required"
				}
				if e = s.WaitForHumanWithin(ctx, tx, str(x["taskId"]), binding.operationID, code); e != nil {
					return false, e
				}
			}
			return true, nil
		})
	}
	if e != nil {
		if _, save := s.Pool.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET state='unknown',code=$4,updated_at=$5 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, s.Endpoint, x["taskId"], x["callId"], errorCode(e), s.now()); save != nil {
			return nil, save
		}
		return nil, e
	}
	return result, nil
}
