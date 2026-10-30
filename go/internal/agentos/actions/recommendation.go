package actions

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func recommendationExtended(kind string) bool {
	return kind == "recommendation-policy-save" || kind == "recommendation-theme-update"
}
func parseRecommendationExtended(x Object) (Object, error) {
	kind := str(x["kind"])
	keys := []string{"kind", "expectedVersion", "enabled", "reason"}
	method := "policy"
	command := Object{"operationId": "00000000-0000-0000-0000-000000000000", "expectedVersion": x["expectedVersion"], "enabled": x["enabled"], "reason": x["reason"]}
	if kind == "recommendation-policy-save" {
		keys = append(keys, "controls")
		command["themeKey"] = "category:technology"
		command["direction"] = "keep"
		command["controls"] = x["controls"]
	} else if kind == "recommendation-theme-update" {
		method = "theme"
		keys = append(keys, "themeId", "label", "mapping")
		command["themeId"] = x["themeId"]
		command["label"] = x["label"]
		command["mapping"] = x["mapping"]
		if !validID(x["themeId"]) || num(x["expectedVersion"]) < 1 {
			return nil, invalid()
		}
	} else {
		return nil, invalid()
	}
	if !exact(x, keys, nil) {
		return nil, invalid()
	}
	parsed, e := discovery.ParseRecommendationCommand(method, command)
	if e != nil {
		return nil, e
	}
	for _, k := range keys {
		if k != "kind" {
			x[k] = parsed[k]
		}
	}
	return x, nil
}
func reviewObject(p *preparation, label string, v any) error {
	raw, e := json.Marshal(v)
	if e != nil {
		return e
	}
	parts := strategyReviewChunks(string(raw), 4000)
	for i, part := range parts {
		p.impact = append(p.impact, fmt.Sprintf("%s（%d/%d）：%s", label, i+1, len(parts), part))
	}
	return nil
}
func (s *Service) prepareRecommendationExtended(ctx context.Context, a Actor, x Object, p *preparation) error {
	service, e := s.recommendations(a, nil)
	if e != nil {
		return e
	}
	kind := str(x["kind"])
	p.basis = []any{basis("当前版本", fmt.Sprint(x["expectedVersion"]))}
	p.impact = []any{"仅保存经确认的现有推荐配置，其他设置保持不变。"}
	if kind == "recommendation-theme-update" {
		value, e := service.ReadTheme(ctx, a, str(x["themeId"]))
		if e != nil {
			return e
		}
		p.expiry(value["readExpiresAt"])
		before := obj(value["theme"])
		if num(before["version"]) != num(x["expectedVersion"]) {
			return fail("recommendation_theme_changed", 409)
		}
		command := pick(x, "themeId", "expectedVersion", "label", "enabled", "mapping", "reason")
		p.command = command
		p.title = "调整已有推荐主题"
		p.target = Object{"kind": "recommendation-theme", "id": x["themeId"], "label": label(before["label"], "推荐主题"), "href": "/admin/operations/recommendation?tab=themes"}
		if e = reviewObject(p, "当前主题", before); e != nil {
			return e
		}
		if e = reviewObject(p, "目标主题", pick(x, "themeId", "label", "enabled", "mapping")); e != nil {
			return e
		}
	} else {
		value, e := service.ReadPolicyWithCatalog(ctx, a)
		if e != nil {
			return e
		}
		value, e = wire(value)
		if e != nil {
			return e
		}
		p.expiry(value["readExpiresAt"])
		policy := obj(value["policy"])
		if num(policy["version"]) != num(x["expectedVersion"]) {
			return fail("recommendation_policy_changed", 409)
		}
		directions := items(policy["directions"])
		catalog := items(obj(value["catalog"])["items"])
		p.presentationNames = Object{}
		for _, v := range catalog {
			entry := obj(v)
			if key, name := str(entry["key"]), str(entry["label"]); key != "" && name != "" {
				p.presentationNames[key] = name
			}
		}
		var anchor, theme Object
		for _, d := range directions {
			for _, t := range catalog {
				if obj(d)["key"] == obj(t)["key"] {
					anchor = obj(d)
					theme = obj(t)
					break
				}
			}
			if anchor != nil {
				break
			}
		}
		if anchor == nil || theme == nil {
			return fail("recommendation_policy_anchor_unavailable", 409)
		}
		command := Object{"expectedVersion": x["expectedVersion"], "enabled": x["enabled"], "controls": x["controls"], "reason": x["reason"], "themeKey": anchor["key"], "direction": anchor["direction"], "beforeDirections": directions, "themeVersion": theme["version"], "themeEnabled": theme["enabled"]}
		p.command = command
		p.title = "调整推荐策略开关与控制"
		p.target = Object{"kind": "recommendation-theme", "id": anchor["key"], "label": label(theme["label"], "推荐策略"), "href": "/admin/operations/recommendation?tab=strategy"}
		if e = reviewObject(p, "当前策略", policy); e != nil {
			return e
		}
		if e = reviewObject(p, "目标开关与控制", pick(x, "enabled", "controls")); e != nil {
			return e
		}
		if e = reviewObject(p, "保留全部主题方向", directions); e != nil {
			return e
		}
	}
	return noticeReviewLimit(p)
}
func normalizeRecommendationExtended(x, command, proposal Object) (Object, error) {
	kind := str(x["kind"])
	method := "policy"
	keys := []string{"operationId", "expectedVersion", "enabled", "controls", "reason", "themeKey", "direction", "beforeDirections", "themeVersion", "themeEnabled"}
	if kind == "recommendation-theme-update" {
		method = "theme"
		keys = []string{"operationId", "themeId", "expectedVersion", "label", "enabled", "mapping", "reason"}
	}
	if !exact(command, keys, nil) {
		return nil, invalid()
	}
	raw := pick(command, "operationId", "expectedVersion", "enabled", "controls", "reason", "themeKey", "direction")
	if method == "theme" {
		raw = pick(command, "operationId", "themeId", "expectedVersion", "label", "enabled", "mapping", "reason")
	}
	parsed, e := discovery.ParseRecommendationCommand(method, raw)
	if e != nil {
		return nil, e
	}
	for k, v := range parsed {
		if k != "operationId" && k != "themeKey" && k != "direction" && !same(v, x[k]) {
			return nil, invalid()
		}
	}
	if method == "policy" {
		if items(command["beforeDirections"]) == nil {
			return nil, invalid()
		}
		if _, ok := integer(command["themeVersion"]); !ok {
			return nil, invalid()
		}
		if _, ok := command["themeEnabled"].(bool); !ok {
			return nil, invalid()
		}
		if obj(proposal["target"])["id"] != command["themeKey"] {
			return nil, invalid()
		}
	} else if obj(proposal["target"])["id"] != x["themeId"] {
		return nil, invalid()
	}
	for k, v := range parsed {
		command[k] = v
	}
	return command, nil
}

func (s *Service) executeRecommendationExtended(ctx context.Context, a Actor, x, command Object, fresh Authorize) (Object, error) {
	service, e := s.recommendations(a, fresh)
	if e != nil {
		return nil, e
	}
	if x["kind"] == "recommendation-theme-update" {
		return service.SaveTheme(ctx, a, command)
	}
	return service.SavePolicy(ctx, a, recommendationPolicyBody(command), &discovery.ThemeExpectation{Key: str(command["themeKey"]), ExpectedVersion: num(command["themeVersion"]), Enabled: command["themeEnabled"] == true})
}
func (s *Service) recoverRecommendationExtended(ctx context.Context, a Actor, x, command Object, operationID string) (Object, error) {
	service, e := s.recommendations(a, nil)
	if e != nil {
		return nil, e
	}
	saved, e := service.CommandResult(ctx, a, operationID)
	if e != nil {
		return nil, e
	}
	row, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return service.CommandRecordWithin(ctx, tx, operationID) })
	if e != nil {
		return nil, e
	}
	if row == nil {
		if saved["state"] == "not-recorded" {
			return nil, nil
		}
		return unknownRecommendation(operationID), nil
	}
	method, expectedKind, target := "policy", "policy-updated", command["themeKey"]
	input := recommendationPolicyBody(command)
	if x["kind"] == "recommendation-theme-update" {
		method = "theme"
		expectedKind = "theme-updated"
		target = "theme:" + str(x["themeId"])
		input = command
	}
	raw, e := identity.Canonical(Object{"kind": method, "input": input})
	if e != nil {
		return nil, e
	}
	receipt := obj(saved["result"])
	if row["operator_id"] != a.ID || row["kind"] != expectedKind || row["theme_key"] != target || row["request_hash"] != identity.Digest(raw) || num(row["revision"]) != num(command["expectedVersion"])+1 || saved["state"] != "recorded" || saved["kind"] != method || num(receipt["version"]) != num(row["revision"]) {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	out := clone(obj(row["result"]))
	out["replayed"] = true
	return out, nil
}
func recommendationExtendedResult(kind string, result Object, operationID string, x, command Object) (Object, error) {
	if result["state"] == "unknown" {
		return unknownRecommendation(operationID), nil
	}
	if result["operationId"] != operationID {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	if kind == "recommendation-theme-update" {
		theme := obj(result["theme"])
		if theme["id"] != x["themeId"] || num(theme["version"]) != num(x["expectedVersion"])+1 || theme["label"] != x["label"] || theme["enabled"] != x["enabled"] {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return Object{"operationId": operationID, "state": "completed", "summary": "已有推荐主题已更新。", "receipt": Object{"themeId": theme["id"], "version": theme["version"], "replayed": result["replayed"] == true}}, nil
	}
	policy := obj(result["policy"])
	if num(policy["version"]) != num(x["expectedVersion"])+1 || policy["enabled"] != x["enabled"] || !same(policy["controls"], x["controls"]) || !same(policy["directions"], command["beforeDirections"]) {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	return Object{"operationId": operationID, "state": "completed", "summary": "推荐策略开关与控制已保存。", "receipt": Object{"version": policy["version"], "replayed": result["replayed"] == true}}, nil
}
