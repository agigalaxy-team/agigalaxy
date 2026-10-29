package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"time"
)

// OriginalAIReceipt is a human-authorized read of a task's original operation.
// It never obtains a Duty execution actor, changes the task or retries a writer.
func (s *Service) OriginalAIReceipt(ctx context.Context, a Actor, taskID, operationID string) (Object, error) {
	if !schemaUUID.MatchString(taskID) || !schemaUUID.MatchString(operationID) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.read", nil)
		if e != nil {
			return nil, e
		}
		task, e := s.taskWithin(ctx, tx, taskID, "")
		if e != nil {
			return nil, e
		}
		if e = s.checkTargetWithin(ctx, tx, actor, task, true); e != nil {
			return nil, e
		}
		calls, e := many(ctx, tx, `SELECT to_jsonb(c) FROM (SELECT call_id,operation_id,tool,arguments FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3) c`, s.Endpoint, taskID, operationID)
		if e != nil {
			return nil, e
		}
		if len(calls) != 1 || calls[0]["tool"] != "execute-operation" {
			return nil, fault.New("operations_autonomy_operation_not_found", 404)
		}
		call := calls[0]
		args := obj(call["arguments"])
		kind := str(args["kind"])
		target := str(args["targetId"])
		if !schemaUUID.MatchString(target) {
			return nil, fault.New("operations_autonomy_operation_not_found", 404)
		}
		targetType, permission := "", ""
		switch kind {
		case "feedback-update":
			targetType, permission = "feedback", "feedback.update"
		case "content-visibility":
			if !has([]string{"hide", "restore"}, str(args["action"])) {
				return nil, fault.New("operations_autonomy_operation_not_found", 404)
			}
			targetType, permission = map[string]string{"post": "content-post", "reply": "content-reply"}[str(args["targetKind"])], "content."+str(args["action"])
		}
		if targetType == "" {
			return nil, fault.New("operations_autonomy_operation_not_found", 404)
		}
		if e = s.checkTargetWithin(ctx, tx, actor, Object{"target_type": targetType, "target_id": target, "domain": task["domain"]}, false); e != nil {
			return nil, e
		}
		original, e := optional(ctx, tx, `SELECT to_jsonb(o) FROM operations_ai_duty_operations_v1 o WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3`, s.Endpoint, taskID, operationID)
		if e != nil {
			return nil, e
		}
		src := businessadmin.OriginalAIReceiptSource{TaskID: taskID, AIAccountID: str(task["ai_account_id"]), Domain: str(task["domain"]), CallID: str(call["call_id"]), OperationID: operationID, PlanID: str(task["config_id"]), PlanVersion: num(task["plan_version"]), Request: args, CallArguments: args}
		if original != nil {
			proposal := obj(original["proposal"])
			request := obj(original["request"])
			binding := obj(original["binding"])
			if original["ai_account_id"] != task["ai_account_id"] || original["kind"] != kind || request["kind"] != kind || request["targetId"] != target || proposal["kind"] != kind || proposal["domain"] != task["domain"] || obj(proposal["target"]) != nil && obj(proposal["target"])["id"] != target || obj(binding["operation"])["targetId"] != target || obj(binding["operation"])["permission"] != permission || !sameValue(proposal["request"], request) {
				return nil, fault.New("operations_autonomy_operation_not_found", 404)
			}
			proposalTarget := obj(proposal["target"])
			if proposalTarget != nil {
				expectedKind := "feedback"
				if kind == "content-visibility" {
					expectedKind = str(request["targetKind"])
				}
				if proposalTarget["kind"] != expectedKind {
					return nil, fault.New("operations_autonomy_operation_not_found", 404)
				}
			}
			if kind == "content-visibility" && (request["targetKind"] != args["targetKind"] || request["action"] != args["action"]) {
				return nil, fault.New("operations_autonomy_operation_not_found", 404)
			}
			src.Request, src.Command, src.Binding = request, obj(proposal["command"]), binding
		}
		if s.OriginalAIReceiptWithin == nil {
			return nil, fault.New("operations_autonomy_receipt_unavailable", 503)
		}
		result, e := s.OriginalAIReceiptWithin(ctx, tx, actor, src)
		if e != nil {
			return nil, e
		}
		state := str(result["state"])
		if !has([]string{"recorded", "not-recorded", "unknown"}, state) || result["operationId"] != operationID || result["metadataOnly"] != true {
			return nil, fault.New("operations_autonomy_receipt_unavailable", 503)
		}
		projected := Object{"state": state, "operationId": operationID, "metadataOnly": true}
		if state == "recorded" {
			action := "feedback.update"
			if kind == "content-visibility" {
				action = "content." + str(args["action"])
			}
			if result["action"] != action || result["targetType"] != targetType || result["targetId"] != target || !integer(result["version"], 1, 9007199254740991) {
				return nil, fault.New("operations_autonomy_receipt_unavailable", 503)
			}
			recordedAt, ok := result["recordedAt"].(string)
			if !ok {
				return nil, fault.New("operations_autonomy_receipt_unavailable", 503)
			}
			if _, err := time.Parse(time.RFC3339Nano, recordedAt); err != nil {
				return nil, fault.New("operations_autonomy_receipt_unavailable", 503)
			}
			for _, key := range []string{"action", "targetType", "targetId", "version", "recordedAt"} {
				projected[key] = result[key]
			}
		}
		if _, e = s.actor(ctx, tx, a, "autonomy.read", nil); e != nil {
			return nil, e
		}
		if e = s.checkTargetWithin(ctx, tx, actor, Object{"target_type": targetType, "target_id": target, "domain": task["domain"]}, false); e != nil {
			return nil, e
		}
		return s.stamp(Object{"taskId": taskID, "operationId": operationID, "receipt": projected}), nil
	})
}
