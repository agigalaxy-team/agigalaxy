package actions

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"slices"
)

func normalizeStrategyRuleCommand(x, command Object) (Object, error) {
	kind := str(x["kind"])
	if kind == "rule-publish" || kind == "rule-restore" {
		out, e := operationsrules.ParsePublishCommand(command)
		if e != nil {
			return nil, e
		}
		if out["reason"] != x["reason"] || kind == "rule-restore" && out["versionId"] != x["versionId"] {
			return nil, invalid()
		}
		return out, nil
	}
	method := map[string]string{"strategy-draft": "prepared-draft", "strategy-rehearsal": "rehearsal", "strategy-publish": "publish", "ordinary-strategy-draft": "ordinary-draft", "ordinary-strategy-create-draft": "ordinary-create-draft", "ordinary-strategy-publish": "ordinary-publish", "strategy-control": "control", "strategy-continue": "continue"}[kind]
	out, e := operationsstrategies.ParseCommand(method, command)
	if e != nil {
		return nil, e
	}
	if kind == "strategy-draft" && !same(x["expectedDraftId"], out["expectedDraftId"]) {
		return nil, invalid()
	}
	for _, key := range []string{"configuration", "executionIds", "rehearsalId", "expectedDraftId", "strategyId", "sourceStrategyId", "sourceVersionId", "expectedRevision", "name", "parameterEdits", "mode", "enabled", "reason", "versionId"} {
		if v, ok := x[key]; ok && !same(v, out[key]) {
			return nil, invalid()
		}
	}
	if kind == "strategy-control" && out["kind"] != x["action"] {
		return nil, invalid()
	}
	return out, nil
}
func (s *Service) executeStrategyRule(ctx context.Context, a Actor, x, command Object, fresh Authorize) (Object, error) {
	kind := str(x["kind"])
	if kind == "rule-publish" || kind == "rule-restore" {
		if s.Rules == nil {
			return nil, fail("operations_agentos_action_not_connected", 503)
		}
		source := s.Rules.WithAuthorize(s.authority(a), fresh)
		current := func() (Actor, error) { return a, nil }
		if kind == "rule-publish" {
			return source.Publish(ctx, a, str(x["key"]), command, current)
		}
		return source.Restore(ctx, a, str(x["key"]), command, current)
	}
	if s.Strategies == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	source := s.Strategies.WithAuthorize(s.authority(a), fresh)
	current := func() (Actor, error) { return a, nil }
	switch kind {
	case "strategy-draft":
		return source.SavePreparedDraft(ctx, a, command, current)
	case "strategy-rehearsal":
		return source.Rehearsal(ctx, a, command)
	case "strategy-publish":
		return source.Publish(ctx, a, command, current)
	}
	if kind == "ordinary-strategy-draft" || kind == "ordinary-strategy-create-draft" || kind == "ordinary-strategy-publish" {
		method := "draft"
		if kind == "ordinary-strategy-create-draft" {
			method = "create-draft"
		}
		if kind == "ordinary-strategy-publish" {
			method = "publish"
		}
		return source.CommandOrdinary(ctx, a, method, command)
	}
	if kind == "strategy-control" {
		return source.Control(ctx, a, command, current)
	}
	return source.Continue(ctx, a, str(x["runId"]), command, current)
}
func (s *Service) recoverStrategyRule(ctx context.Context, a Actor, x, command Object, operation string) (Object, Object, error) {
	kind := str(x["kind"])
	if kind == "rule-publish" || kind == "rule-restore" {
		source, e := s.rules(a)
		if e != nil {
			return nil, nil, e
		}
		row, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return source.CommandRecordWithin(ctx, tx, operation) })
		if e != nil || row == nil {
			return nil, nil, e
		}
		method := "publish"
		if kind == "rule-restore" {
			method = "restore"
		}
		if row["operator_id"] != a.ID || row["policy_key"] != x["key"] || row["kind"] != method || !same(row["input"], command) {
			return nil, nil, fail("operations_agentos_operation_conflict", 409)
		}
		result, e := source.Operation(ctx, a, operation)
		if e != nil {
			return nil, nil, e
		}
		if result["state"] != "recorded" {
			return nil, nil, nil
		}
		return result, nil, nil
	}
	source, e := s.strategies(a)
	if e != nil {
		return nil, nil, e
	}
	if kind == "strategy-rehearsal" {
		saved, e := source.RehearsalOperation(ctx, a, operation)
		if e != nil || saved["state"] == "not-recorded" {
			return nil, nil, e
		}
		if saved["versionId"] != command["versionId"] || !same(saved["executionIds"], command["executionIds"]) {
			return nil, nil, fail("operations_agentos_operation_conflict", 409)
		}
		return obj(saved["result"]), nil, nil
	}
	if kind == "strategy-draft" || kind == "strategy-publish" {
		method := "draft"
		if kind == "strategy-publish" {
			method = "publish"
		}
		saved, e := source.OriginalCommand(ctx, a, operation, method, command)
		if e != nil || saved["state"] == "not-recorded" {
			return nil, nil, e
		}
		return obj(saved["result"]), nil, nil
	}
	if kind == "ordinary-strategy-draft" || kind == "ordinary-strategy-create-draft" || kind == "ordinary-strategy-publish" {
		selected := x["strategyId"]
		if kind == "ordinary-strategy-create-draft" {
			selected = x["sourceStrategyId"]
		}
		saved, e := source.OrdinaryOperation(ctx, a, str(selected), operation)
		if e != nil {
			return nil, nil, e
		}
		if saved["state"] == "not-recorded" {
			return nil, nil, nil
		}
		method := "ordinary-draft"
		if kind == "ordinary-strategy-create-draft" {
			method = "ordinary-create-draft"
		}
		if kind == "ordinary-strategy-publish" {
			method = "ordinary-publish"
		}
		if saved["kind"] != method || !same(saved["input"], command) {
			return nil, nil, fail("operations_agentos_operation_conflict", 409)
		}
		return obj(saved["result"]), nil, nil
	}
	saved, e := source.Operation(ctx, a, operation)
	if e != nil {
		return nil, nil, e
	}
	if saved["state"] == "not-recorded" {
		return nil, nil, nil
	}
	expected := "control"
	if kind == "strategy-draft" {
		expected = "draft"
	}
	if kind == "strategy-publish" {
		expected = "publish"
	}
	if kind == "strategy-continue" {
		expected = "continue"
	}
	if saved["kind"] != expected {
		return nil, nil, fail("operations_agentos_operation_conflict", 409)
	}
	result := obj(saved["result"])
	if kind == "strategy-continue" {
		if result["runId"] != x["runId"] {
			return nil, nil, fail("operations_agentos_operation_conflict", 409)
		}
		current, e := source.RunDetail(ctx, a, str(x["runId"]))
		if e != nil {
			return nil, nil, e
		}
		result = clone(current)
		result["operationId"] = operation
		if obj(obj(current["run"])["native"])["awaitingHuman"] == true {
			if obj(saved["continuation"])["state"] == "accepted" {
				return result, Object{"operationId": operation, "state": "processing", "summary": "本次决定已受理，正在读取处理进展。", "receipt": safeReceipt(result)}, nil
			}
			run := clone(obj(result["run"]))
			run["state"] = "unknown"
			result["run"] = run
		}
	}
	return result, nil, nil
}
func strategyRuleResult(kind string, result Object, operation string, x Object) (Object, error) {
	if kind == "strategy-draft" || kind == "strategy-publish" || kind == "strategy-rehearsal" {
		if kind == "strategy-rehearsal" {
			if result["rehearsalId"] != operation || result["versionId"] != x["versionId"] {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
			summary := "预演未通过，请查看检查结果。"
			if result["valid"] == true {
				summary = "策略预演通过，可提交发布。"
			}
			return Object{"operationId": operation, "state": "completed", "summary": summary, "receipt": result}, nil
		}
		state, summary := "saved", "策略草稿已保存。"
		if kind == "strategy-publish" {
			state, summary = "active-for-new-matters", "策略已发布，仅用于新事项。"
		}
		if result["operationId"] != operation || result["state"] != state || !validID(result["versionId"]) || (kind == "strategy-publish" && result["versionId"] != x["versionId"]) {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return Object{"operationId": operation, "state": "completed", "summary": summary, "receipt": pick(result, "operationId", "versionId", "version", "revision", "state", "replayed")}, nil
	}
	if kind == "ordinary-strategy-draft" || kind == "ordinary-strategy-create-draft" || kind == "ordinary-strategy-publish" {
		state := "saved"
		summary := "日常策略调整已保存为草稿。"
		selected := x["strategyId"]
		if kind == "ordinary-strategy-create-draft" {
			selected = x["sourceStrategyId"]
			summary = "已根据批准的模板保存新策略草稿。"
			if result["sourceStrategyId"] != selected || result["sourceVersionId"] != x["sourceVersionId"] || !validID(result["newStrategyId"]) {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
		}
		if kind == "ordinary-strategy-publish" {
			state = "active-for-new-matters"
			summary = "日常策略调整已发布，仅用于新事项。"
		}
		if result["operationId"] != operation || result["strategyId"] != selected || !validID(result["versionId"]) || count(result["version"]) == nil || count(result["revision"]) == nil || result["state"] != state || x["versionId"] != nil && result["versionId"] != x["versionId"] {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return Object{"operationId": operation, "state": "completed", "summary": summary, "receipt": pick(result, "operationId", "strategyId", "sourceStrategyId", "sourceVersionId", "newStrategyId", "versionId", "version", "revision", "state", "replayed")}, nil
	}
	receipt := safeReceipt(result)
	if kind == "rule-publish" || kind == "rule-restore" {
		state, summary := "unknown", "正在取得规则的发布结果。"
		if num(receipt["publishedVersion"]) > 0 {
			state = "completed"
			summary = "这份规则已发布。"
			if kind == "rule-restore" {
				summary = "已将所选历史内容发布为新的规则版本。"
			}
		}
		return Object{"operationId": operation, "state": state, "summary": summary, "receipt": receipt}, nil
	}
	if kind == "strategy-continue" {
		state, summary := "processing", "本次决定已记录，事项正在继续。"
		switch receipt["state"] {
		case "unknown":
			state, summary = "unknown", "本次决定已记录，正在读取处理进展。"
		case "completed":
			state, summary = "completed", "这项处理已完成。"
		case "no-action":
			state, summary = "completed", "本次决定已记录，未执行处理。"
		case "blocked":
			state, summary = "completed", "当前条件不满足，事项已停止。"
		}
		return Object{"operationId": operation, "state": state, "summary": summary, "receipt": receipt}, nil
	}
	return Object{"operationId": operation, "state": "completed", "summary": "本次处理已完成。", "receipt": receipt}, nil
}
func strategyRuleKind(kind string) bool {
	return slices.Contains([]string{"strategy-draft", "strategy-rehearsal", "strategy-publish", "ordinary-strategy-draft", "ordinary-strategy-create-draft", "ordinary-strategy-publish", "strategy-control", "strategy-continue", "rule-publish", "rule-restore"}, kind)
}
