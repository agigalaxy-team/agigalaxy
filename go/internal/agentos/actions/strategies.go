package actions

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"slices"
	"unicode/utf8"
)

func parseStrategyRuleRequest(x Object) (Object, error) {
	kind := str(x["kind"])
	if kind == "ordinary-strategy-draft" || kind == "ordinary-strategy-publish" {
		command := pick(x, "strategyId", "parameterEdits", "mode", "enabled", "versionId")
		command["operationId"], command["expectedRevision"] = "00000000-0000-0000-0000-000000000000", 0
		mode := "ordinary-draft"
		if kind == "ordinary-strategy-publish" {
			mode = "ordinary-publish"
		}
		normalized, e := operationsstrategies.ParseCommand(mode, command)
		if e != nil {
			return nil, e
		}
		out := pick(normalized, "strategyId", "parameterEdits", "mode", "enabled", "versionId")
		out["kind"] = kind
		return out, nil
	}
	if kind == "strategy-continue" {
		if !validID(x["runId"]) || !slices.Contains([]string{"proceed", "no-action"}, str(x["decision"])) {
			return nil, invalid()
		}
		return x, nil
	}
	if kind == "strategy-control" {
		if !slices.Contains([]string{"pause", "resume"}, str(x["action"])) {
			return nil, invalid()
		}
		reason, ok := x["reason"].(string)
		reason = trim(reason)
		if !ok || utf8.RuneCountInString(reason) < 3 || utf8.RuneCountInString(reason) > 1600 {
			return nil, invalid()
		}
		x["reason"] = reason
		return x, nil
	}
	if !slices.Contains(operationsrules.Keys, str(x["key"])) || kind == "rule-restore" && !validID(x["versionId"]) {
		return nil, invalid()
	}
	command := Object{"operationId": "11111111-1111-4111-8111-111111111111", "expectedRevision": 0, "versionId": "11111111-1111-4111-8111-111111111111", "reason": x["reason"]}
	normalized, e := operationsrules.ParsePublishCommand(command)
	if e != nil {
		return nil, e
	}
	x["reason"] = normalized["reason"]
	return x, nil
}
func (s *Service) strategies(a Actor) (*operationsstrategies.Service, error) {
	if s.Strategies == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	return s.Strategies.WithAuthority(s.authority(a)), nil
}
func (s *Service) prepareStrategy(ctx context.Context, a Actor, x Object, p *preparation) error {
	source, e := s.strategies(a)
	if e != nil {
		return e
	}
	kind := str(x["kind"])
	if kind == "ordinary-strategy-draft" || kind == "ordinary-strategy-publish" {
		mode := "draft"
		if kind == "ordinary-strategy-publish" {
			mode = "publish"
		}
		prepared, e := source.PrepareOrdinary(ctx, a, mode, x)
		if e != nil {
			return e
		}
		p.expiry(prepared["readExpiresAt"])
		p.command = obj(prepared["command"])
		p.target = Object{"kind": "strategy", "id": x["strategyId"], "label": label(obj(prepared["strategy"])["name"], "日常策略"), "href": "/admin/operations/strategies?strategy=" + str(x["strategyId"])}
		p.title = "调整已批准边界内的日常策略"
		impact := "保存一份受限草稿，后续仍需通过当前消费者预演。"
		if mode == "publish" {
			p.title = "发布已保存的日常策略调整"
			impact = "对新事项使用已预演的受限策略版本。"
		}
		p.basis = []any{basis("授权范围", "仅包含已批准的参数、启停及领导方式边界")}
		p.impact = []any{impact}
		return nil
	}
	if kind == "strategy-control" {
		item, e := source.Get(ctx, a)
		if e != nil {
			return e
		}
		if e = capability(obj(item["capabilities"])["canControl"]); e != nil {
			return e
		}
		if item["active"] == nil || item["paused"] == (x["action"] == "pause") {
			return fail("operations_agentos_operation_unavailable", 409)
		}
		p.expiry(item["readExpiresAt"])
		p.target = Object{"kind": "strategy-configuration", "id": obj(item["active"])["id"], "label": "当前已发布策略", "href": "/admin/operations/strategy"}
		p.title = "恢复策略执行"
		impact := "恢复整套已发布策略的后续步骤；已经完成的处理不会再次执行。"
		if x["action"] == "pause" {
			p.title = "暂停策略执行"
			impact = "暂停整套已发布策略的后续步骤；已经完成的处理不撤销。"
		}
		p.command = Object{"expectedRevision": item["revision"], "kind": x["action"], "reason": x["reason"]}
		state := "已启用"
		if item["paused"] == true {
			state = "已暂停"
		}
		p.basis = []any{basis("当前执行", state)}
		p.impact = []any{impact}
		return nil
	}
	item, e := source.RunDetail(ctx, a, str(x["runId"]))
	if e != nil {
		return e
	}
	p.expiry(item["readExpiresAt"])
	run := obj(item["run"])
	native := obj(run["native"])
	if native["status"] != "PAUSED" || native["awaitingHuman"] != true {
		return fail("p13_run_not_paused", 409)
	}
	if e = capability(run["canContinue"]); e != nil {
		return e
	}
	p.target = Object{"kind": "strategy-run", "id": x["runId"], "label": label(obj(run["strategy"])["name"], "策略事项"), "href": "/admin/operations/strategy?tab=runs&run=" + str(x["runId"])}
	p.title = "不执行这项处理"
	impact := "结束本次处理，不执行待确认动作。"
	if x["decision"] == "proceed" {
		p.title = "同意推进这项处理"
		impact = "按原计划继续这项处理。若权限或内容状态已有变化，系统会停止相应动作。"
	}
	if native["pauseKind"] == "input" {
		p.command = Object{"inputDecision": x["decision"]}
	} else {
		p.command = Object{"confirmed": x["decision"] == "proceed"}
	}
	p.basis = []any{basis("当前步骤", label(native["currentStep"], "等待本次人工决定"))}
	p.impact = []any{impact}
	return nil
}
