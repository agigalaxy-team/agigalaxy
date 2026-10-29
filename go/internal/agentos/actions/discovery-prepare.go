package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"net/url"
)

var recommendationDirectionNames = map[string]string{"increase": "增加", "keep": "保持", "decrease": "减少"}

func (s *Service) prepareDiscovery(ctx context.Context, a Actor, x Object, operationID string, p *preparation) error {
	if str(x["kind"]) == "recommendation-direction" {
		return s.prepareRecommendation(ctx, a, x, p)
	}
	service, e := s.searchQuality(a, nil)
	if e != nil {
		return e
	}
	item, e := service.Overview(ctx, a, Object{"days": 7, "limit": 1})
	if e != nil {
		return e
	}
	item, e = wire(item)
	if e != nil {
		return e
	}
	p.expiry(item["readExpiresAt"])
	configuration := obj(item["configuration"])
	if x["kind"] == "search-draft-save" {
		if e = capability(obj(item["capabilities"])["canConfigure"]); e != nil {
			return e
		}
		draft := obj(configuration["draft"])
		if draft != nil && (draft["id"] != x["expectedDraftId"] || draft["operatorId"] != a.ID) || draft == nil && x["expectedDraftId"] != nil {
			return fail("search_quality_draft_changed", 409)
		}
		target := x["expectedDraftId"]
		if target == nil {
			target = operationID
		}
		if !validID(target) {
			return invalid()
		}
		p.target = Object{"kind": "search-configuration", "id": target, "label": "搜索配置草稿", "href": "/admin/operations/search-quality?tab=versions"}
		p.title = "保存搜索配置草稿"
		p.command = Object{"expectedRevision": configuration["revision"], "expectedDraftId": x["expectedDraftId"], "settings": x["settings"], "reason": x["reason"]}
		p.basis = []any{basis("管理版本", fmt.Sprint(configuration["revision"]))}
		before := obj(configuration["active"])["settings"]
		if draft != nil {
			before = draft["settings"]
		}
		if before == nil {
			before = obj(configuration["native"])["settings"]
		}
		if before == nil {
			return fail("operations_agentos_search_review_required", 409)
		}
		return searchReview(p, before, x["settings"], "仅保存草稿，不改变当前搜索。")
	}
	version := obj(configuration["draft"])
	restore := x["kind"] == "search-restore"
	if restore {
		history, e := service.History(ctx, a, Object{"limit": 50})
		if e != nil {
			return e
		}
		candidates := append([]any{configuration["active"]}, items(history["versions"])...)
		version = nil
		for _, v := range candidates {
			if obj(v)["id"] == x["versionId"] {
				version = obj(v)
				break
			}
		}
		if e = capability(version["restorable"]); e != nil {
			return e
		}
	}
	capabilityKey := "canPublish"
	if restore {
		capabilityKey = "canRestore"
	}
	if e = capability(obj(item["capabilities"])[capabilityKey]); e != nil {
		return e
	}
	if version == nil {
		return fail("search_quality_version_unavailable", 409)
	}
	p.target = Object{"kind": "search-configuration", "id": version["id"], "label": fmt.Sprintf("搜索配置版本 %v", version["version"]), "href": "/admin/operations/search-quality?tab=versions"}
	p.title = "应用已保存的搜索草稿"
	first := "将这份草稿的同义词和排序设置用于后续搜索。"
	if restore {
		p.title = "恢复这份搜索配置"
		first = "将后续搜索恢复为所选历史版本的设置。"
	}
	p.command = Object{"expectedRevision": configuration["revision"], "versionId": version["id"], "reason": x["reason"]}
	p.basis = []any{basis("可见范围", "已下架、到期、非公开或无权阅读的内容仍不进入搜索结果")}
	return searchReview(p, obj(configuration["active"])["settings"], version["settings"], first)
}

func searchReview(p *preparation, before, after any, impact string) error {
	before, e := discovery.QuerySearchSettings(obj(before))
	if e != nil {
		return fail("operations_agentos_search_review_required", 409)
	}
	after, e = discovery.QuerySearchSettings(obj(after))
	if e != nil {
		return fail("operations_agentos_search_review_required", 409)
	}
	p.impact = []any{impact, "设置完成后才会显示为已生效；结果暂未取得时，系统会继续查询。", "固定可见性约束保持不变，已下架、到期、非公开或无权阅读的内容不进入结果。"}
	for _, item := range []struct {
		label string
		value any
	}{{"当前设置", before}, {"目标设置", after}} {
		raw, e := json.Marshal(item.value)
		if e != nil {
			return e
		}
		parts := strategyReviewChunks(string(raw), 4000)
		for i, part := range parts {
			p.impact = append(p.impact, fmt.Sprintf("%s（%d/%d）：%s", item.label, i+1, len(parts), part))
		}
	}
	total := 0
	for _, line := range p.impact {
		n := jsLength(str(line))
		total += n
		if n > 5000 {
			return fail("operations_agentos_search_review_required", 409)
		}
	}
	if len(p.impact) > 80 || total > 20000 {
		return fail("operations_agentos_search_review_required", 409)
	}
	return nil
}
func (s *Service) prepareRecommendation(ctx context.Context, a Actor, x Object, p *preparation) error {
	service, e := s.recommendations(a, nil)
	if e != nil {
		return e
	}
	item, e := service.Overview(ctx, a, Object{"days": 7})
	if e != nil {
		return e
	}
	item, e = wire(item)
	if e != nil {
		return e
	}
	p.expiry(item["readExpiresAt"])
	if e = capability(obj(item["capabilities"])["canConfigure"]); e != nil {
		return e
	}
	policy := obj(item["policy"])
	var theme Object
	for _, v := range items(obj(item["catalog"])["items"]) {
		if obj(v)["key"] == x["themeKey"] {
			theme = obj(v)
			break
		}
	}
	if theme == nil || items(policy["directions"]) == nil {
		return fail("operations_agentos_operation_unavailable", 409)
	}
	command := Object{"operationId": "00000000-0000-0000-0000-000000000000", "expectedVersion": policy["version"], "enabled": policy["enabled"], "themeKey": x["themeKey"], "direction": x["direction"], "controls": policy["controls"], "reason": x["reason"], "beforeDirections": policy["directions"], "themeVersion": theme["version"], "themeEnabled": theme["enabled"]}
	command, e = normalizeDiscoveryCommand(x, command, nil)
	if e != nil {
		return e
	}
	delete(command, "operationId")
	before := "keep"
	for _, v := range items(command["beforeDirections"]) {
		if obj(v)["key"] == x["themeKey"] {
			before = str(obj(v)["direction"])
			break
		}
	}
	if before == x["direction"] || (theme["enabled"] != true && policy["enabled"] == true && x["direction"] != "keep") {
		return fail("operations_agentos_operation_unavailable", 409)
	}
	name := label(theme["label"], "推荐主题")
	p.target = Object{"kind": "recommendation-theme", "id": x["themeKey"], "label": name, "href": "/admin/operations/recommendation?tab=strategy&id=" + url.QueryEscape(str(x["themeKey"]))}
	p.title = "调整「" + name + "」的推荐方向"
	p.command = command
	enabled, state := "未启用", "已停用"
	if policy["enabled"] == true {
		enabled = "已启用"
	}
	if theme["enabled"] == true {
		state = "已启用"
	}
	p.basis = []any{basis("当前方向", recommendationDirectionNames[before]), basis("方向调控", enabled), basis("主题状态", state)}
	detail := "后续推荐按这一软性方向处理，个人需求、合格供给和负反馈仍参与排序。"
	if policy["enabled"] != true {
		detail = "方向调控当前关闭，本次仅保存方向，不改变当前推荐排序。"
	} else if theme["enabled"] != true {
		detail = "此主题仍停用，本次不启用主题。"
	}
	p.impact = []any{"展示机会：" + recommendationDirectionNames[before] + "改为" + recommendationDirectionNames[str(x["direction"])] + "。", detail, "保留当前开关、重复与集中控制、其它主题方向及映射。", "需要撤销时，可按最新配置恢复原方向。"}
	return nil
}
