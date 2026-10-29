package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"slices"
	"unicode/utf8"
)

func parseStrategyRuleRequest(x Object) (Object, error) {
	kind := str(x["kind"])
	if kind == "strategy-draft" || kind == "strategy-rehearsal" || kind == "strategy-publish" {
		method := map[string]string{"strategy-draft": "prepared-draft", "strategy-rehearsal": "rehearsal", "strategy-publish": "publish"}[kind]
		command := clone(x)
		delete(command, "kind")
		command["operationId"] = "00000000-0000-0000-0000-000000000000"
		if kind == "strategy-draft" && command["expectedDraftId"] == nil {
			command["expectedDraftId"] = nil
		}
		if kind != "strategy-rehearsal" {
			command["expectedRevision"] = 0
		}
		normalized, e := operationsstrategies.ParseCommand(method, command)
		if e != nil {
			return nil, e
		}
		delete(normalized, "operationId")
		delete(normalized, "expectedRevision")
		if kind == "strategy-draft" && normalized["expectedDraftId"] == nil {
			delete(normalized, "expectedDraftId")
		}
		normalized["kind"] = kind
		return normalized, nil
	}
	if kind == "ordinary-strategy-create-draft" {
		command := clone(x)
		delete(command, "kind")
		command["operationId"] = "00000000-0000-0000-0000-000000000000"
		normalized, e := operationsstrategies.ParseCommand("ordinary-create-draft", command)
		if e != nil {
			return nil, e
		}
		delete(normalized, "operationId")
		normalized["kind"] = kind
		return normalized, nil
	}
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
	if kind == "strategy-draft" || kind == "strategy-rehearsal" || kind == "strategy-publish" {
		item, e := source.Get(ctx, a)
		if e != nil {
			return e
		}
		p.expiry(item["readExpiresAt"])
		p.target = Object{"kind": "strategy-configuration", "label": "策略配置", "href": "/admin/operations/strategy"}
		p.command = clone(x)
		delete(p.command, "kind")
		if kind != "strategy-rehearsal" {
			p.command["expectedRevision"] = item["revision"]
		}
		p.basis = []any{basis("当前管理版本", fmt.Sprint(item["revision"]))}
		if kind == "strategy-draft" {
			if e = capability(obj(item["capabilities"])["canConfigure"]); e != nil {
				return e
			}
			p.title = "保存完整策略草稿"
			draft := obj(item["draft"])
			if draft != nil && (draft["id"] != x["expectedDraftId"] || draft["createdBy"] != a.ID || draft["ordinaryExecutionId"] != nil || draft["ordinaryStrategyId"] != nil) || draft == nil && x["expectedDraftId"] != nil {
				return fail("p13_existing_draft_requires_human", 409)
			}
			p.command["expectedDraftId"] = x["expectedDraftId"]
			p.target["id"] = draft["id"]
			p.impact = append(p.impact, "只保存草稿，不改变已发布策略。")
		} else {
			draft := obj(item["draft"])
			if draft == nil || draft["id"] != x["versionId"] {
				return fail("p13_strategy_draft_changed", 409)
			}
			p.target["id"] = x["versionId"]
			if kind == "strategy-rehearsal" {
				p.title = "预演已保存策略草稿"
				p.impact = append(p.impact, "检查所选样本及当前消费者资格；不执行策略动作，也不调用模型。")
			} else {
				if e = capability(obj(item["capabilities"])["canPublish"]); e != nil {
					return e
				}
				rehearsal, e := source.RehearsalOperation(ctx, a, str(x["rehearsalId"]))
				if e != nil {
					return e
				}
				if rehearsal["state"] != "recorded" || rehearsal["versionId"] != x["versionId"] || obj(rehearsal["result"])["valid"] != true {
					return fail("p13_rehearsal_required", 409)
				}
				p.expiry(rehearsal["readExpiresAt"])
				p.title = "发布已预演策略草稿"
				p.impact = append(p.impact, "仅用于新事项；在办事项继续使用原版本。发布前重新核对预演和当前条件。")
			}
		}
		configuration := obj(x["configuration"])
		before := obj(item["configuration"])
		if kind == "strategy-draft" && item["draft"] != nil {
			before = obj(obj(item["draft"])["configuration"])
		}
		if kind != "strategy-draft" {
			configuration = obj(obj(item["draft"])["configuration"])
		}
		changes, e := strategyDifference(before, configuration)
		if e != nil {
			return e
		}
		for _, change := range changes {
			p.impact = append(p.impact, change)
		}
		if len(changes) == 0 {
			p.impact = append(p.impact, "策略配置与当前比较版本相同。")
		}
		for _, entry := range []struct {
			label string
			value Object
		}{{"变更前完整配置", before}, {"变更后完整配置", configuration}} {
			raw, e := json.Marshal(entry.value)
			if e != nil {
				return e
			}
			parts := strategyReviewChunks(string(raw), 4000)
			for i, part := range parts {
				p.impact = append(p.impact, fmt.Sprintf("%s（%d/%d）：%s", entry.label, i+1, len(parts), part))
			}
		}
		if x["reason"] != nil {
			p.impact = append(p.impact, "变更说明："+str(x["reason"]))
		}
		total := 0
		for _, v := range p.impact {
			n := jsLength(str(v))
			total += n
			if n > 5000 {
				return fail("operations_agentos_strategy_review_required", 409)
			}
		}
		if len(p.impact) > 80 || total > 20000 {
			return fail("operations_agentos_strategy_review_required", 409)
		}
		return nil
	}
	if kind == "ordinary-strategy-draft" || kind == "ordinary-strategy-create-draft" || kind == "ordinary-strategy-publish" {
		mode := "draft"
		if kind == "ordinary-strategy-create-draft" {
			mode = "create-draft"
		}
		if kind == "ordinary-strategy-publish" {
			mode = "publish"
		}
		prepared, e := source.PrepareOrdinary(ctx, a, mode, x)
		if e != nil {
			return e
		}
		p.expiry(prepared["readExpiresAt"])
		p.command = obj(prepared["command"])
		selected := x["strategyId"]
		if kind == "ordinary-strategy-create-draft" {
			selected = x["sourceStrategyId"]
		}
		p.target = Object{"kind": "strategy", "id": selected, "label": label(obj(prepared["strategy"])["name"], "日常策略"), "href": "/admin/operations/strategies?strategy=" + str(selected)}
		p.title = "调整已批准边界内的日常策略"
		impact := "保存一份受限草稿，后续仍需通过当前消费者预演。"
		if mode == "create-draft" {
			p.title = "基于已批准模板新建日常策略草稿"
			impact = "沿用模板业务和授权边界，新增策略不会替代来源；仅保存草稿。"
		}
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

func strategyReviewChunks(value string, limit int) []string {
	out, chunk, width := []string{}, []rune{}, 0
	for _, r := range value {
		n := 1
		if r > 0xffff {
			n = 2
		}
		if width+n > limit {
			out = append(out, string(chunk))
			chunk, width = nil, 0
		}
		chunk, width = append(chunk, r), width+n
	}
	if len(chunk) != 0 {
		out = append(out, string(chunk))
	}
	return out
}

// strategyDifference includes every changed field, keeping nested conditions,
// scopes, grants, bounds and recovery values intact for the human reviewer.
func strategyDifference(before, after Object) ([]string, error) {
	lines := []string{}
	add := func(label string, old, next any) error {
		if same(old, next) {
			return nil
		}
		a, e := json.Marshal(old)
		if e != nil {
			return e
		}
		b, e := json.Marshal(next)
		if e != nil {
			return e
		}
		lines = append(lines, label+"："+string(a)+" → "+string(b))
		return nil
	}
	if e := add("共同目标与自动执行", before["common"], after["common"]); e != nil {
		return nil, e
	}
	for _, v := range items(after["domains"]) {
		next := obj(v)
		var old Object
		for _, v := range items(before["domains"]) {
			if obj(v)["key"] == next["key"] {
				old = obj(v)
				break
			}
		}
		if e := add("领域 "+str(next["key"]), old, next); e != nil {
			return nil, e
		}
	}
	oldByID, nextByID := map[string]Object{}, map[string]Object{}
	ids := []string{}
	oldOrder, nextOrder := []string{}, []string{}
	for _, v := range items(before["strategies"]) {
		s := obj(v)
		id := str(s["id"])
		oldByID[id] = s
		ids = append(ids, id)
		oldOrder = append(oldOrder, id)
	}
	for _, v := range items(after["strategies"]) {
		s := obj(v)
		id := str(s["id"])
		nextByID[id] = s
		nextOrder = append(nextOrder, id)
		if oldByID[id] == nil {
			ids = append(ids, id)
		}
	}
	if e := add("策略顺序", oldOrder, nextOrder); e != nil {
		return nil, e
	}
	fields := []string{"name", "domain", "objective", "enabled", "mode", "template", "judgment", "instructions", "condition", "execution", "ordinaryBounds", "recovery"}
	for _, id := range ids {
		old, next := oldByID[id], nextByID[id]
		if old == nil || next == nil {
			if e := add("策略 "+id+" 增删", old, next); e != nil {
				return nil, e
			}
			continue
		}
		for _, field := range fields {
			if e := add("策略 "+id+" "+field, old[field], next[field]); e != nil {
				return nil, e
			}
		}
	}
	return lines, nil
}
