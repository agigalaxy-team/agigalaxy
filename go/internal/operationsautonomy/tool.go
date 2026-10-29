package operationsautonomy

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsquerycontract"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var toolNames = []string{"current-summary", "query-operations", "read-operation-object", "execute-operation", "manage-ai-role", "manage-ai-prompt", "read-ai-delegation", "assess-task", "reconcile-task-operations"}

func parseTool(input Object) (Object, error) {
	if !closed(input, []string{"taskId", "callId", "tool", "arguments"}, []string{"nativeRunId", "validationFailure"}) || !schemaUUID.MatchString(str(input["taskId"])) || !schemaUUID.MatchString(str(input["callId"])) || !has(toolNames, str(input["tool"])) || obj(input["arguments"]) == nil {
		return nil, invalid()
	}
	if v, ok := input["validationFailure"]; ok {
		f := obj(v)
		if !has([]string{"query-operations", "read-operation-object", "read-ai-delegation"}, str(input["tool"])) || !closed(f, []string{"ambiguous"}, nil) {
			return nil, invalid()
		}
		if _, ok := f["ambiguous"].(bool); !ok {
			return nil, invalid()
		}
	}
	if v, ok := input["nativeRunId"]; ok && !nativeRunPattern.MatchString(str(v)) {
		return nil, invalid()
	}
	return obj(clone(input)), nil
}

type toolBinding struct {
	row, prior    Object
	actor         Actor
	operationID   string
	localRecorded bool
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
	sources, e := s.taskEventSourcesWithin(ctx, tx, current, actor)
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
	out := Object{"tool": "current-summary", "availability": "available", "basis": "capability-discovery-not-business-inspection", "inspectionChecked": false, "taskVersionBasis": "persisted-task-snapshot-with-current-authority", "task": Object{"taskId": current["id"], "aiAccountId": current["ai_account_id"], "domain": current["domain"], "source": current["source"], "mode": current["mode"], "state": current["state"], "planId": current["config_id"], "configRevision": current["config_revision"], "planVersion": current["plan_version"], "promptVersion": current["prompt_version"], "delegationVersion": current["delegation_version"], "roleVersion": actor.Version}, "sourceTargets": sources["sourceTargets"], "sourceCoverage": sources["sourceCoverage"], "sourceBasis": sources["basis"], "queryAccess": operationsai.QueryAccess(actor.Permissions), "managementCapabilities": management, "managementAvailability": state}
	return s.stamp(out), nil
}
func (s *Service) Tool(ctx context.Context, input Object, ruleSource bool) (Object, error) {
	x, e := parseTool(input)
	if e != nil {
		return nil, e
	}
	binding, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (toolBinding, error) {
		row, e := s.taskWithin(ctx, tx, str(x["taskId"]), " FOR UPDATE")
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
		if x["validationFailure"] != nil {
			args := obj(x["arguments"])
			safe := Object{}
			ambiguous := obj(x["validationFailure"])["ambiguous"] == true
			if x["tool"] != "read-ai-delegation" {
				scope := operationsquerycontract.QueryCoverageScope(str(x["tool"]), args)
				for _, key := range []string{"module", "view", "kind", "id"} {
					if scope[key] != nil {
						safe[key] = scope[key]
					}
				}
				safe["filters"] = scope["filters"]
				ambiguous = ambiguous || scope["invalidRoute"] == true || scope["invalidFilters"] == true || scope["unknownTopLevel"] == true || scope["unknownFilterFields"] == true && len(texts(scope["allowedFilterKeys"])) > 0 || len(list(scope["invalidFilterKeys"])) > 0 || len(list(scope["missingRequired"])) > 0
				for _, key := range []string{"after", "limit", "page", "pageSize"} {
					if value, ok := obj(args["filters"])[key]; ok && has(texts(scope["allowedFilterKeys"]), key) && !has(texts(scope["invalidFilterKeys"]), key) {
						obj(safe["filters"])[key] = value
					}
				}
			} else {
				ambiguous = true
			}
			if prior != nil {
				matched := !ambiguous && (sameValue(prior["arguments"], args) || sameReadScope(str(x["tool"]), obj(prior["arguments"]), safe))
				if prior["tool"] != x["tool"] || !has([]string{"failed", "unknown", "invalid-request"}, str(prior["state"])) || !matched {
					return toolBinding{}, fail("operations_autonomy_operation_conflict")
				}
				return toolBinding{row: row, prior: prior, actor: actor, localRecorded: true}, nil
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET code='task-assessment-stale' WHERE endpoint=$1 AND task_id=$2 AND tool='assess-task' AND (code='task-assessment-current' OR state='started' AND code IS NULL)`, s.Endpoint, row["id"]); e != nil {
				return toolBinding{}, e
			}
			code := "local-validation-failed"
			if ambiguous {
				code = "local-validation-ambiguous"
			}
			if _, e = tx.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,code,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'invalid-request',$7,$8,$8)`, s.Endpoint, row["id"], x["callId"], x["tool"], jsonText(safe), uuid.NewString(), code, s.now()); e != nil {
				return toolBinding{}, e
			}
			return toolBinding{row: row, actor: actor, localRecorded: true}, nil
		}
		if prior != nil && x["tool"] == "assess-task" && prior["code"] != "task-assessment-current" {
			return toolBinding{}, fail("operations_autonomy_assessment_stale")
		}
		if prior != nil && (prior["tool"] != x["tool"] || !sameValue(prior["arguments"], x["arguments"])) {
			return toolBinding{}, fail("operations_autonomy_operation_conflict")
		}
		operationID := str(prior["operation_id"])
		if prior == nil {
			if x["tool"] != "assess-task" {
				if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET code='task-assessment-stale' WHERE endpoint=$1 AND task_id=$2 AND tool='assess-task' AND (code='task-assessment-current' OR state='started' AND code IS NULL)`, s.Endpoint, row["id"]); e != nil {
					return toolBinding{}, e
				}
			} else if e = parseAssessment(obj(x["arguments"])); e != nil {
				return toolBinding{}, e
			}
			operationID = uuid.NewString()
			if _, e = tx.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'started',$7,$7)`, s.Endpoint, row["id"], x["callId"], x["tool"], jsonText(x["arguments"]), operationID, s.now()); e != nil {
				return toolBinding{}, e
			}
		}
		actor, e = s.BindDutyAuditSourceWithin(ctx, tx, actor, str(x["callId"]), operationID, ptr(x["nativeRunId"]), ruleSource)
		return toolBinding{row: row, prior: prior, actor: actor, operationID: operationID}, e
	})
	if e != nil {
		return nil, e
	}
	if binding.localRecorded {
		return Object{"state": "recorded"}, nil
	}
	result, e := func() (Object, error) {
		row, actor, operationID := binding.row, binding.actor, binding.operationID
		tool, args := str(x["tool"]), obj(x["arguments"])
		if tool == "assess-task" {
			return Object{"availability": "available"}, nil
		}
		if tool == "reconcile-task-operations" {
			if len(args) != 0 {
				return nil, invalid()
			}
			return s.reconcileTaskOperations(ctx, str(row["id"]), str(x["nativeRunId"]))
		}
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
			current, e := s.taskWithin(ctx, tx, str(x["taskId"]), " FOR UPDATE")
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
			if tool == "assess-task" {
				if _, e = s.DutyForTaskWithin(ctx, tx, str(current["id"]), "query"); e != nil {
					return false, e
				}
				var assessmentCode *string
				if e = tx.QueryRow(ctx, `SELECT code FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, s.Endpoint, x["taskId"], x["callId"]).Scan(&assessmentCode); e != nil {
					return false, e
				}
				if assessmentCode == nil || *assessmentCode == "task-assessment-current" {
					if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET code='task-assessment-superseded' WHERE endpoint=$1 AND task_id=$2 AND tool='assess-task' AND code='task-assessment-current' AND call_id<>$3`, s.Endpoint, x["taskId"], x["callId"]); e != nil {
						return false, e
					}
					code = "task-assessment-current"
				} else {
					code = *assessmentCode
				}
			} else {
				if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET code='task-assessment-stale' WHERE endpoint=$1 AND task_id=$2 AND tool='assess-task' AND (code='task-assessment-current' OR state='started' AND code IS NULL)`, s.Endpoint, x["taskId"]); e != nil {
					return false, e
				}
			}
			if tool == "query-operations" || tool == "read-operation-object" {
				state, code = readResultStatus(result)
			}
			if tool == "read-ai-delegation" {
				if obj(result["prompt"]) != nil || obj(result["delegation"]) != nil && result["targetAiAccounts"] != nil {
					code = "read-success-complete"
				} else {
					state, code = "failed", "read-unavailable"
				}
			}
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
			if tool == "assess-task" {
				result, e = s.completionWithin(ctx, tx, current, true)
				if e != nil {
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
