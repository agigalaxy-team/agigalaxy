package agentos

import (
	"strings"
	"testing"
)

func TestCardPresentationTranslatesStructuredImpact(t *testing.T) {
	result := cardPresentation(Object{"title": "调整推荐设置", "target": Object{"label": "推荐策略"},
		"impact": []any{"调整推荐设置。", `当前策略（1/1）：{"enabled":false,"controls":{"avoidRepetition":false}}`, `目标开关与控制（1/2）：{"enabled":true,"controls":`, `目标开关与控制（2/2）：{"avoidRepetition":false}}`},
		"basis":  []any{Object{"label": "影响范围", "value": "推荐策略"}}})
	if result["reviewable"] != true {
		t.Fatalf("unexpected warnings: %#v", result["warnings"])
	}
	changes := result["changes"].([]any)
	if len(changes) != 1 {
		t.Fatalf("missing difference: %#v", changes)
	}
	c := changes[0].(Object)
	if c["before"] != "否" || c["after"] != "是" {
		t.Fatalf("wrong values: %#v", c)
	}
	details := result["details"].([]any)
	for _, item := range details {
		x := item.(Object)
		if strings.Contains(x["label"].(string), "避免重复") {
			t.Fatalf("unchanged field duplicated: %#v", details)
		}
	}
}
func TestCardPresentationFailsClosedForIncompleteOrUnknown(t *testing.T) {
	for _, impact := range [][]any{{`配置（1/2）：{"enabled":true`}, {`配置（1/1）：{"unrecognizedBusiness":true}`}, {`配置（1/1）：{"accountIds":["e64d9272-4503-4a8c-858a-04e881da6b91"]}`}} {
		result := cardPresentation(Object{"title": "确认变更", "impact": impact, "basis": []any{}})
		if result["reviewable"] != false || len(result["warnings"].([]any)) == 0 {
			t.Fatalf("should reject: %#v", result)
		}
		for _, item := range result["details"].([]any) {
			if strings.Contains(item.(Object)["value"].(string), "e64d9272") {
				t.Fatal("internal ID exposed")
			}
		}
	}
}
func TestCardPresentationKeepsPromptReviewSeparate(t *testing.T) {
	result := cardPresentation(Object{"kind": "ai-work-prompt-save", "title": "修改岗位要求", "impact": []any{"正文不应放入通用展示"}})
	if result["reviewable"] != true || len(result["details"].([]any)) != 1 {
		t.Fatalf("unexpected prompt review: %#v", result)
	}
}

func TestCardPresentationComparesPartialWithoutDeletingOmittedFields(t *testing.T) {
	result := cardPresentation(Object{"title": "调整推荐策略", "impact": []any{`当前策略（1/1）：{"enabled":false,"controls":{"avoidRepetition":false},"directions":[{"key":"theme:one","direction":"keep"}]}`, `目标开关与控制（1/1）：{"enabled":true,"controls":{"avoidRepetition":false}}`}, "basis": []any{}, "presentationNames": Object{"theme:one": "主题一"}})
	if result["reviewable"] != true {
		t.Fatalf("unexpected warnings: %#v", result["warnings"])
	}
	changes := result["changes"].([]any)
	if len(changes) != 1 {
		t.Fatalf("unexpected differences: %#v", changes)
	}
	c := changes[0].(Object)
	if c["before"] != "否" || c["after"] != "是" {
		t.Fatalf("unexpected change: %#v", c)
	}
}
