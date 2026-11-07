package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

const CommunityParameterAdjustment = "community-parameter-adjustment"

var growthRuleKey = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

func CommunityParameterReadAction(area string) string {
	switch area {
	case "growth":
		return "rules.read"
	case "content-score", "recommendation":
		return "recommendations.read"
	}
	return ""
}

func macroScope(area, scope string) bool {
	return area == "growth" && growthRuleKey.MatchString(scope) ||
		(area == "content-score" || area == "recommendation") && scope == "global"
}

func macroNumber(value any) bool {
	switch v := value.(type) {
	case int, int64:
		return true
	case float64:
		return !math.IsNaN(v) && !math.IsInf(v, 0)
	case json.Number:
		n, err := v.Float64()
		return err == nil && !math.IsNaN(n) && !math.IsInf(n, 0)
	}
	return false
}

func parseMacroRequest(input Object) (Object, error) {
	x := clone(input)
	parameters := obj(x["parameters"])
	reason := trim(str(x["reason"]))
	if !exact(x, []string{"kind", "area", "scope", "expectedVersion", "parameters", "reason"}, nil) ||
		x["kind"] != CommunityParameterAdjustment || !macroScope(str(x["area"]), str(x["scope"])) ||
		len(parameters) == 0 || len(parameters) > 12 || reason == "" || jsLength(reason) > 500 {
		return nil, invalid()
	}
	if _, ok := integer(x["expectedVersion"]); !ok {
		return nil, invalid()
	}
	if strings.HasPrefix(reason, "{") && json.Valid([]byte(reason)) {
		return nil, invalid()
	}
	if x["area"] == "growth" && num(x["expectedVersion"]) < 1 {
		return nil, invalid()
	}
	for _, value := range parameters {
		if !macroNumber(value) {
			return nil, invalid()
		}
	}
	x["reason"] = reason
	return x, nil
}

func macroAreaLabel(area string) string {
	return map[string]string{"growth": "账户成长", "content-score": "内容评分", "recommendation": "推荐排序"}[area]
}

var macroParameterLabels = map[string]string{
	"experience": "每次获得的经验",
	"likeWeight": "点赞系数", "contentRecognitionWeight": "内容认可系数",
	"freshnessWeight": "新鲜度系数", "discussionWeight": "讨论系数",
	"diminishingScale": "互动增量递减尺度", "halfLifeHours": "热度半衰期（小时）",
	"matchWeight": "需求匹配系数", "recognitionWeight": "推荐认可系数",
	"heatWeight": "推荐热度系数", "smoothing": "融合平滑参数",
	"maxPositionChange": "最大调整位次",
}

func (s *Service) previewMacroWithin(ctx context.Context, tx pgx.Tx, actor Actor, area, scope string, patch Object) (Object, error) {
	if area == "growth" {
		if s.GrowthParameters == nil {
			return nil, fail("operations_agentos_action_not_connected", 503)
		}
		growth := *s.GrowthParameters
		authority, err := s.discoveryAuthority(actor)
		if err != nil {
			return nil, err
		}
		growth.Authority = authority
		return growth.PreviewCommunityParametersWithin(ctx, tx, actor, scope, patch)
	}
	recommendations, err := s.recommendations(actor, nil)
	if err != nil {
		return nil, err
	}
	return recommendations.PreviewCommunityParametersWithin(ctx, tx, actor, area, patch)
}

func (s *Service) CommunityParameters(ctx context.Context, actor Actor, domain string, input Object) (Object, error) {
	area, scope := str(input["area"]), str(input["scope"])
	if !exact(input, []string{"area"}, []string{"scope"}) || !macroScope(area, scope) && !(area == "growth" && scope == "") {
		return nil, invalid()
	}
	if domain != "governance" {
		return nil, fail("operations_agentos_domain_mismatch", 403)
	}
	actor, err := s.human(ctx, actor, domain, CommunityParameterReadAction(area), "query", nil)
	if err != nil {
		return nil, err
	}
	if area == "growth" && scope == "" {
		if s.GrowthParameters == nil {
			return nil, fail("operations_agentos_action_not_connected", 503)
		}
		growth := *s.GrowthParameters
		authority, err := s.discoveryAuthority(actor)
		if err != nil {
			return nil, err
		}
		growth.Authority = authority
		result, err := growth.Query(ctx, actor, Object{"kind": "rules"})
		if err != nil {
			return nil, err
		}
		return Object{"availability": "available", "area": area, "rules": result["items"]}, nil
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		current, err := s.previewMacroWithin(ctx, tx, actor, area, scope, Object{})
		if err != nil {
			return nil, err
		}
		return Object{"availability": "available", "area": area, "scope": scope, "version": current["version"], "parameters": current["before"], "sample": current["sample"], "label": current["label"]}, nil
	})
}

func (s *Service) prepareMacro(ctx context.Context, actor Actor, domain string, x Object, p *preparation) error {
	if domain != "governance" {
		return fail("operations_agentos_domain_mismatch", 403)
	}
	area, scope := str(x["area"]), str(x["scope"])
	preview, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		return s.previewMacroWithin(ctx, tx, actor, area, scope, obj(x["parameters"]))
	})
	if err != nil {
		return err
	}
	if num(preview["version"]) != num(x["expectedVersion"]) {
		return fail("operations_agentos_review_changed", 409)
	}
	before, after := obj(preview["before"]), obj(preview["after"])
	keys := make([]string, 0, len(after))
	for k := range after {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, key := range keys {
		if same(before[key], after[key]) {
			continue
		}
		name := macroParameterLabels[key]
		if name == "" || !macroNumber(before[key]) || !macroNumber(after[key]) {
			return fail("operations_agentos_action_not_connected", 503)
		}
		p.changes = append(p.changes, Object{"label": name, "before": fmt.Sprint(before[key]), "after": fmt.Sprint(after[key])})
	}
	if len(p.changes) == 0 {
		return fail("operations_agentos_review_changed", 409)
	}
	targetLabel := "全站" + macroAreaLabel(area)
	if area == "growth" {
		targetLabel = label(preview["label"], "账户成长规则")
	}
	p.target = Object{"kind": "community-parameter", "id": area + ":" + scope, "label": targetLabel}
	p.title = "调整" + macroAreaLabel(area) + "参数"
	p.command = macroOwnerInput(x, "")
	p.basis = []any{basis("当前版本", fmt.Sprint(num(x["expectedVersion"]))), basis("调整理由", x["reason"])}
	if summary := str(preview["sampleSummary"]); summary != "" {
		p.basis = append(p.basis, basis("样本", summary))
	} else {
		p.basis = append(p.basis, basis("样本", "暂无可比较样本"))
	}
	effect := map[string]string{"growth": "影响之后取得的经验", "content-score": "按新参数计算内容认可与近期热度", "recommendation": "在现有相关候选中调整推荐顺序"}[area]
	p.impact = []any{effect}
	return nil
}

func macroOwnerInput(x Object, operationID string) Object {
	input := clone(obj(x["parameters"]))
	input["expectedVersion"], input["reason"] = x["expectedVersion"], x["reason"]
	if operationID != "" {
		input["operationId"] = operationID
	}
	return input
}

func (s *Service) ConfirmCommunityParametersWithin(ctx context.Context, tx pgx.Tx, actor Actor, proposal Object, operationID string) (Object, error) {
	if s.isDuty(actor) || actor.ID == "" || actor.Endpoint != s.Endpoint {
		return nil, fail("operations_agentos_human_review_required", 403)
	}
	x, command, err := s.proposal(proposal, operationID)
	if err != nil {
		return nil, err
	}
	if x["kind"] != CommunityParameterAdjustment || proposal["domain"] != "governance" {
		return nil, invalid()
	}
	// Adoption is the current human's business decision. The model's intersected
	// read permissions qualify preparation and cannot grant adoption permission.
	actor.AIProof = nil
	var result Object
	area, scope := str(x["area"]), str(x["scope"])
	if area == "growth" {
		if s.GrowthParameters == nil {
			return nil, fail("operations_agentos_action_not_connected", 503)
		}
		result, err = s.GrowthParameters.AdoptCommunityParametersWithin(ctx, tx, actor, scope, command)
	} else {
		if s.Recommendations == nil {
			return nil, fail("operations_agentos_action_not_connected", 503)
		}
		result, err = s.Recommendations.AdoptCommunityParametersWithin(ctx, tx, actor, area, command)
	}
	if err != nil {
		return nil, err
	}
	return macroReceipt(x, operationID, result)
}

func macroReceipt(x Object, operationID string, result Object) (Object, error) {
	version := num(result["version"])
	for _, key := range []string{"communitySignals", "rule"} {
		if version == 0 {
			version = num(obj(result[key])["version"])
		}
	}
	if result["operationId"] != operationID || version != num(x["expectedVersion"])+1 {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	return Object{"operationId": operationID, "state": "completed", "summary": fmt.Sprintf("%s参数已采用（第 %d 版）。", macroAreaLabel(str(x["area"])), version), "receipt": Object{"operationId": operationID, "version": version, "area": x["area"], "scope": x["scope"], "replayed": result["replayed"] == true}}, nil
}

func (s *Service) recoverMacro(ctx context.Context, actor Actor, x, command Object, operationID string) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var result Object
		var err error
		area, scope := str(x["area"]), str(x["scope"])
		actor.AIProof = nil
		if area == "growth" {
			if s.GrowthParameters == nil {
				return nil, fail("operations_agentos_action_not_connected", 503)
			}
			result, err = s.GrowthParameters.CommunityParametersReceiptWithin(ctx, tx, actor, scope, command)
		} else {
			if s.Recommendations == nil {
				return nil, fail("operations_agentos_action_not_connected", 503)
			}
			result, err = s.Recommendations.CommunityParametersReceiptWithin(ctx, tx, actor, area, command)
		}
		if err != nil {
			return nil, err
		}
		if area == "growth" {
			if result["state"] == "not-recorded" {
				return missing(operationID), nil
			}
			result = obj(result["result"])
		}
		if result == nil {
			return missing(operationID), nil
		}
		result["replayed"] = true
		return macroReceipt(x, operationID, result)
	})
}

func (s *Service) PrepareDutyCommunityParameters(ctx context.Context, actor Actor, domain, operationID string, input Object) (Object, error) {
	if !s.isDuty(actor) {
		return nil, fail("operations_agentos_scope_denied", 403)
	}
	if _, err := parseMacroRequest(input); err != nil {
		return nil, operationsautonomy.MarkPreparationRejected("prepare", err)
	}
	proposal, err := s.Prepare(ctx, actor, domain, input, operationID)
	if err != nil {
		return nil, operationsautonomy.MarkPreparationRejected("prepare", err)
	}
	return proposal, nil
}
