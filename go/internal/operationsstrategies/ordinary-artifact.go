package operationsstrategies

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// OriginalCreationArtifactWithin identifies only a verified, original Duty
// creation result. The caller owns current human/AI read authorization and
// the surrounding transaction; this method does not confer execution rights.
func (s *Service) OriginalCreationArtifactWithin(ctx context.Context, tx pgx.Tx, taskID, aiAccountID, operationID string) (Object, error) {
	if tx == nil || !uuidPattern.MatchString(taskID) || !uuidPattern.MatchString(aiAccountID) || !uuidPattern.MatchString(operationID) {
		return nil, invalid()
	}
	duty, err := one(ctx, tx, `SELECT to_jsonb(o) FROM operations_ai_duty_operations_v1 o WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, operationID)
	if err != nil || duty == nil {
		return nil, err
	}
	if duty["task_id"] != taskID || duty["ai_account_id"] != aiAccountID || duty["kind"] != "ordinary-strategy-create-draft" || duty["state"] != "completed" {
		return nil, nil
	}
	request, proposal := obj(duty["request"]), obj(duty["proposal"])
	if request["kind"] != duty["kind"] || proposal["kind"] != duty["kind"] || proposal["requiredAction"] != "strategies.ordinary.configure" || !same(proposal["request"], request) {
		return nil, nil
	}
	expected := clone(obj(proposal["command"]))
	expected["operationId"] = operationID
	expected, err = ParseCommand("ordinary-create-draft", expected)
	if err != nil {
		return nil, nil
	}
	fromRequest := clone(request)
	delete(fromRequest, "kind")
	fromRequest["operationId"] = operationID
	fromRequest, err = ParseCommand("ordinary-create-draft", fromRequest)
	if err != nil || !same(fromRequest, expected) || obj(proposal["target"])["id"] != expected["sourceStrategyId"] {
		return nil, nil
	}
	command, err := one(ctx, tx, `SELECT to_jsonb(c) FROM operations_p13_strategy_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, operationID)
	if err != nil || command == nil {
		return nil, err
	}
	result := obj(command["result"])
	if command["operator_id"] != "ai:"+aiAccountID || command["kind"] != "ordinary-create-draft" || !same(command["input"], expected) || result["operationId"] != operationID || result["state"] != "saved" || result["sourceStrategyId"] != expected["sourceStrategyId"] || result["sourceVersionId"] != expected["sourceVersionId"] || !uuidPattern.MatchString(str(result["newStrategyId"])) || !uuidPattern.MatchString(str(result["versionId"])) {
		return nil, nil
	}
	dutyResult := obj(duty["result"])
	receipt := obj(dutyResult["receipt"])
	if dutyResult["operationId"] != operationID || dutyResult["state"] != "completed" || dutyResult["effectState"] != "completed" {
		return nil, nil
	}
	for _, key := range []string{"operationId", "sourceStrategyId", "sourceVersionId", "newStrategyId", "versionId"} {
		if receipt[key] != result[key] {
			return nil, nil
		}
	}
	version, err := s.version(ctx, tx, result["versionId"])
	if err != nil || version == nil {
		return nil, err
	}
	if version["ordinary_task_id"] != taskID || version["ordinary_ai_account_id"] != aiAccountID || version["ordinary_strategy_id"] != expected["sourceStrategyId"] || version["parent_id"] != expected["sourceVersionId"] || version["created_by"] != "ai:"+aiAccountID || findStrategy(obj(version["configuration"]), result["newStrategyId"]) == nil {
		return nil, nil
	}
	source, err := s.version(ctx, tx, expected["sourceVersionId"])
	if err != nil || source == nil {
		return nil, err
	}
	reconstructed, err := OrdinaryCreation(obj(source["configuration"]), expected, str(result["newStrategyId"]))
	if err != nil || !same(reconstructed, version["configuration"]) {
		return nil, nil
	}
	return Object{"operationId": operationID, "sourceStrategyId": expected["sourceStrategyId"], "sourceVersionId": expected["sourceVersionId"], "newStrategyId": result["newStrategyId"], "versionId": result["versionId"]}, nil
}
