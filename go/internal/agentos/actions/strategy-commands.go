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
	method := map[string]string{"ordinary-strategy-draft": "ordinary-draft", "ordinary-strategy-publish": "ordinary-publish", "strategy-control": "control", "strategy-continue": "continue"}[kind]
	out, e := operationsstrategies.ParseCommand(method, command)
	if e != nil {
		return nil, e
	}
	for _, key := range []string{"strategyId", "parameterEdits", "mode", "enabled", "reason", "versionId"} {
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
	if kind == "ordinary-strategy-draft" || kind == "ordinary-strategy-publish" {
		method := "draft"
		if kind == "ordinary-strategy-publish" {
			method = "publish"
		}
		return source.CommandOrdinary(ctx, a, method, command)
	}
	current := func() (Actor, error) { return a, nil }
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
	if kind == "ordinary-strategy-draft" || kind == "ordinary-strategy-publish" {
		saved, e := source.OrdinaryOperation(ctx, a, str(x["strategyId"]), operation)
		if e != nil {
			return nil, nil, e
		}
		if saved["state"] == "not-recorded" {
			return nil, nil, nil
		}
		method := "ordinary-draft"
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
	if kind == "ordinary-strategy-draft" || kind == "ordinary-strategy-publish" {
		state := "saved"
		summary := "日常策略调整已保存为草稿。"
		if kind == "ordinary-strategy-publish" {
			state = "active-for-new-matters"
			summary = "日常策略调整已发布，仅用于新事项。"
		}
		if result["operationId"] != operation || result["strategyId"] != x["strategyId"] || !validID(result["versionId"]) || count(result["version"]) == nil || count(result["revision"]) == nil || result["state"] != state || x["versionId"] != nil && result["versionId"] != x["versionId"] {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return Object{"operationId": operation, "state": "completed", "summary": summary, "receipt": pick(result, "operationId", "strategyId", "versionId", "version", "revision", "state", "replayed")}, nil
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
	return slices.Contains([]string{"ordinary-strategy-draft", "ordinary-strategy-publish", "strategy-control", "strategy-continue", "rule-publish", "rule-restore"}, kind)
}
