package actions

import "testing"

func TestIndependentNoticeContractAndQueuedReceipt(t *testing.T) {
	id := "f3b11ad2-6927-4f61-86d0-565966966348"
	op := "85f45288-b578-414b-a044-b6deee289147"
	job := "0e693315-dc09-458f-aa5c-d97e1d09af42"
	content := Object{"purpose": "service-update", "title": "标题", "body": "正文", "href": nil, "audience": Object{"kind": "accounts", "accountIds": []any{id}}, "expiresAt": "2030-01-01T00:00:00Z"}
	create, e := ParseRequest(Object{"kind": "notice-draft-create", "content": content})
	if e != nil {
		t.Fatal(e)
	}
	p := preparation{impact: []any{}, basis: []any{}}
	if e = appendNoticeReview(&p, "拟保存", create["content"]); e != nil {
		t.Fatal(e)
	}
	if len(p.impact) != 6 {
		t.Fatalf("notice review fields: %v", p.impact)
	}
	request := Object{"kind": "notice-state", "targetId": id, "expectedVersion": 1, "action": "publish"}
	result := Object{"notice": Object{"id": id, "version": 2, "state": "queued", "jobId": job}}
	got, e := noticeResult("notice-state", result, op, request)
	if e != nil || got["state"] != "completed" || obj(got["receipt"])["state"] != "queued" {
		t.Fatalf("queued receipt: %v %v", got, e)
	}
	obj(result["notice"])["jobId"] = nil
	if _, e = noticeResult("notice-state", result, op, request); e == nil {
		t.Fatal("queued without job cannot be confirmed")
	}
}

func TestRecommendationExistingThemeAndPolicyContracts(t *testing.T) {
	theme := "7f8fb2cc-c1ad-40a7-9078-d0054bf1a916"
	policy := Object{"kind": "recommendation-policy-save", "expectedVersion": 2, "enabled": true, "controls": Object{"avoidRepetition": true, "avoidConcentration": false}, "reason": "调整现有控制"}
	if _, e := ParseRequest(policy); e != nil {
		t.Fatal(e)
	}
	update := Object{"kind": "recommendation-theme-update", "themeId": theme, "expectedVersion": 1, "label": "已有主题", "enabled": true, "mapping": Object{"categories": []any{"technology"}, "tagIds": []any{}, "queryTerms": []any{}}, "reason": "调整映射"}
	if _, e := ParseRequest(update); e != nil {
		t.Fatal(e)
	}
	delete(update, "themeId")
	if _, e := ParseRequest(update); e == nil {
		t.Fatal("creating a new theme is outside this operation")
	}
}
