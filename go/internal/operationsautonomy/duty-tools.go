package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

func (s *Service) dutyTool(ctx context.Context, task Object, actor Actor, operationID, tool string, args Object, reconcile bool) (result Object, err error) {
	defer func() {
		if err != nil && has([]string{"operations_agentos_human_review_required", "operations_autonomy_human_required", "operations_ai_human_required"}, fault.Code(err)) {
			result = Object{"state": "waiting-human", "reason": fault.Code(err), "operationId": operationID, "effectState": "not-confirmed"}
			err = nil
		}
	}()
	metadata, e := s.DutyMetadata(actor)
	if e != nil || metadata["taskId"] != task["id"] || metadata["aiAccountId"] != task["ai_account_id"] {
		return nil, dutyFail("operations_ai_duty_operation_denied")
	}
	if operationID == "" || args == nil {
		return nil, invalid()
	}
	for _, k := range []string{"operationId", "actor", "role"} {
		if _, ok := args[k]; ok {
			return nil, invalid()
		}
	}
	notConfigured := func() error { return fault.New("operations_autonomy_tool_not_configured", 503) }
	if tool == "read-ai-delegation" {
		if s.Permissions == nil {
			return nil, notConfigured()
		}
		if len(args) == 1 && str(args["aiAccountId"]) != "" {
			return s.Permissions.DelegatedPrompt(ctx, actor, args)
		}
		if len(args) != 0 {
			return nil, invalid()
		}
		return s.Permissions.DelegatedDirectory(ctx, actor)
	}
	if tool == "manage-ai-role" || tool == "manage-ai-prompt" {
		if s.Permissions == nil {
			return nil, notConfigured()
		}
		input := obj(clone(args))
		input["operationId"] = operationID
		kind := str(args["kind"])
		action, targetType, targetID := "ai-role-management", "ai-role", str(args["id"])
		if targetID == "" {
			targetID = operationID
		}
		if kind == "assignment-save" {
			targetType = "ai-role-assignment"
		}
		if tool == "manage-ai-prompt" {
			kind, action, targetType, targetID = "prompt-save", "ai-prompt-management", "ai-work-account", str(args["aiAccountId"])
		}
		var saved Object
		if reconcile {
			original, e := s.Permissions.DelegatedManagementOperation(ctx, actor, operationID, &kind, input)
			if e != nil {
				return nil, e
			}
			if original["state"] != "recorded" {
				return Object{"operationId": operationID, "state": "unknown", "effectState": "unknown", "basis": "original-operation-query", "businessReceipt": Object{"operationId": operationID, "action": action, "targetType": targetType, "targetId": targetID, "state": "unknown", "basis": "original-ai-management-operation-query"}}, nil
			}
			saved = obj(original["result"])
		} else if tool == "manage-ai-role" {
			saved, e = s.Permissions.DelegatedRoleSave(ctx, actor, input, perms.DelegatedOptions{})
			if e != nil {
				return nil, e
			}
		} else {
			saved, e = s.Permissions.DelegatedPromptSave(ctx, actor, input, perms.DelegatedOptions{})
			if e != nil {
				return nil, e
			}
		}
		unknown := func() (Object, error) { return nil, fault.New("operations_autonomy_original_receipt_unknown", 503) }
		if saved["operationId"] != operationID || str(saved["recordedAt"]) == "" || !integer(saved["delegationVersion"], -9007199254740991, 9007199254740991) {
			return unknown()
		}
		receipt := Object{"operationId": operationID, "delegationVersion": saved["delegationVersion"], "recordedAt": saved["recordedAt"]}
		basis := "persisted-ai-role-delegation-event"
		if tool == "manage-ai-role" {
			role, assignment := obj(saved["role"]), obj(saved["assignment"])
			if str(role["id"]) == "" && str(assignment["id"]) == "" {
				return unknown()
			}
			if role != nil {
				targetType, targetID = "ai-role", str(role["id"])
				receipt["roleId"], receipt["version"] = role["id"], role["version"]
			} else {
				targetType, targetID = "ai-role-assignment", str(assignment["id"])
				receipt["assignmentId"], receipt["aiAccountId"], receipt["version"] = assignment["id"], assignment["aiAccountId"], assignment["version"]
			}
			value := obj(clone(saved))
			value["state"], value["effectState"], value["receipt"] = "completed", "completed", receipt
			value["businessReceipt"] = Object{"operationId": operationID, "action": action, "targetType": targetType, "targetId": targetID, "state": "completed", "basis": basis}
			return value, nil
		}
		prompt := obj(saved["prompt"])
		if prompt["aiAccountId"] != args["aiAccountId"] || str(prompt["configId"]) == "" || num(prompt["revision"]) != num(args["expectedRevision"])+1 || num(prompt["promptVersion"]) != num(args["expectedPromptVersion"])+1 {
			return unknown()
		}
		for _, k := range []string{"aiAccountId", "configId", "revision", "promptVersion"} {
			receipt[k] = prompt[k]
		}
		return Object{"operationId": operationID, "state": "completed", "effectState": "completed", "receipt": receipt, "businessReceipt": Object{"operationId": operationID, "action": action, "targetType": targetType, "targetId": targetID, "state": "completed", "basis": "persisted-domain-operation-receipt"}}, nil
	}
	if tool != "execute-operation" || s.ExecuteDutyOperation == nil {
		return nil, notConfigured()
	}
	result, e = s.ExecuteDutyOperation(ctx, actor, operationID, args, reconcile)
	if e != nil {
		return nil, e
	}
	if result["operationId"] != operationID {
		return nil, fault.New("operations_autonomy_original_receipt_unknown", 503)
	}
	if result["state"] == "waiting-human" {
		return result, nil
	}
	state := str(result["effectState"])
	batch := args["kind"] == "public-content-batch"
	var details Object
	if batch {
		details = OriginalBatchReceiptDetails(obj(result["receipt"]))
	}
	receiptObject := false
	switch result["receipt"].(type) {
	case map[string]any, []any:
		receiptObject = result["receipt"] != nil
	}
	recorded := has([]string{"completed", "failed", "unknown"}, state) && has([]string{"persisted-domain-operation-receipt", "original-operation-query"}, str(result["basis"])) && (state != "completed" || receiptObject) && (!batch || details != nil)
	if recorded {
		target := Object{"targetType": nil, "targetId": nil}
		if !batch {
			target = OriginalOperationTarget(obj(result["target"]), args)
		}
		r := Object{"operationId": operationID, "action": args["kind"], "targetType": target["targetType"], "targetId": target["targetId"], "state": state, "basis": result["basis"]}
		if details != nil {
			r["details"] = details
		}
		result = obj(clone(result))
		result["businessReceipt"] = r
	}
	return result, nil
}
