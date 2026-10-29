package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
)

func parseNoticeRequest(x Object) (Object, error) {
	kind := str(x["kind"])
	required := []string{"kind"}
	switch kind {
	case "notice-draft-create":
		required = append(required, "content")
	case "notice-draft-save":
		required = append(required, "targetId", "expectedVersion", "content")
	case "notice-state":
		required = append(required, "targetId", "expectedVersion", "action")
	default:
		return nil, invalid()
	}
	if !exact(x, required, nil) {
		return nil, invalid()
	}
	if kind != "notice-draft-create" {
		n, ok := integer(x["expectedVersion"])
		if !validID(x["targetId"]) || !ok || n < 1 || n > 2147483646 {
			return nil, invalid()
		}
	}
	if kind == "notice-state" {
		if x["action"] != "publish" && x["action"] != "withdraw" {
			return nil, invalid()
		}
	} else {
		content, e := messaging.ParseNoticeContent(x["content"])
		if e != nil {
			return nil, e
		}
		x["content"] = content
	}
	return x, nil
}
func noticeKind(kind string) bool {
	return kind == "notice-draft-create" || kind == "notice-draft-save" || kind == "notice-state"
}
func appendNoticeReview(p *preparation, label string, content any) error {
	for _, field := range []string{"purpose", "title", "body", "href", "audience", "expiresAt"} {
		raw, e := json.Marshal(obj(content)[field])
		if e != nil {
			return e
		}
		parts := strategyReviewChunks(string(raw), 4000)
		for i, part := range parts {
			p.impact = append(p.impact, fmt.Sprintf("%s %s（%d/%d）：%s", label, field, i+1, len(parts), part))
		}
	}
	return nil
}
func noticeReviewLimit(p *preparation) error {
	total := 0
	for _, line := range p.impact {
		n := jsLength(str(line))
		if n > 5000 {
			return fail("operations_agentos_notice_review_required", 409)
		}
		total += n
	}
	if len(p.impact) > 80 || total > 20000 {
		return fail("operations_agentos_notice_review_required", 409)
	}
	return nil
}
func (s *Service) prepareNotice(ctx context.Context, a Actor, x Object, operationID string, p *preparation) error {
	service, e := s.messages(a)
	if e != nil {
		return e
	}
	kind := str(x["kind"])
	id := str(x["targetId"])
	var before Object
	if kind == "notice-draft-create" {
		id = operationID
		if !validID(id) {
			return invalid()
		}
	} else {
		value, e := service.NoticeGet(ctx, a, id)
		if e != nil {
			return e
		}
		before = obj(value["notice"])
		if num(before["version"]) != num(x["expectedVersion"]) {
			return fail("operations_notice_version_changed", 409)
		}
		if kind == "notice-draft-save" && before["state"] != "draft" {
			return fail("operations_notice_not_draft", 409)
		}
		if kind == "notice-state" && x["action"] == "publish" && before["state"] != "draft" {
			return fail("operations_notice_not_draft", 409)
		}
		if kind == "notice-state" && x["action"] == "withdraw" && before["state"] == "withdrawn" {
			return fail("operations_notice_already_withdrawn", 409)
		}
	}
	content := x["content"]
	if kind == "notice-state" {
		content = before["content"]
	}
	validated, e := messaging.ParseNoticeContent(content)
	if e != nil {
		return e
	}
	expires, e := time.Parse(time.RFC3339Nano, str(validated["expiresAt"]))
	if e != nil {
		return e
	}
	if kind != "notice-state" || x["action"] == "publish" {
		p.expiry(expires.Unix())
	}
	p.target = Object{"kind": "notice", "id": id, "label": label(validated["title"], "站内通知"), "href": "/admin/operations/notices?notice=" + id}
	version := "新建"
	if before != nil {
		version = fmt.Sprint(before["version"])
	}
	p.basis = []any{basis("通知版本", version), basis("动作", kind)}
	p.impact = []any{"本操作维护独立站内通知；发布仅安排投递，实际送达以投递记录为准。"}
	if before != nil {
		if e = appendNoticeReview(p, "当前", before["content"]); e != nil {
			return e
		}
	}
	if kind != "notice-state" {
		if e = appendNoticeReview(p, "拟保存", validated); e != nil {
			return e
		}
		p.command = Object{"content": validated}
		p.title = "保存独立站内通知草稿"
		if kind == "notice-draft-save" {
			p.command["expectedVersion"] = x["expectedVersion"]
		}
	} else {
		p.command = Object{"expectedVersion": x["expectedVersion"]}
		if x["action"] == "publish" {
			p.title = "发布独立站内通知"
		} else {
			p.title = "撤回独立站内通知"
		}
		p.basis = append(p.basis, basis("动作", x["action"]))
		delivery, _ := json.Marshal(before["delivery"])
		p.impact = append(p.impact, "当前投递状态："+string(delivery))
	}
	return noticeReviewLimit(p)
}
func normalizeNoticeCommand(x, command, proposal Object, operationID string) (Object, error) {
	kind := str(x["kind"])
	keys := []string{"operationId"}
	if kind != "notice-draft-create" {
		keys = append(keys, "expectedVersion")
	}
	if kind != "notice-state" {
		keys = append(keys, "content")
	}
	if !exact(command, keys, nil) || !validID(command["operationId"]) {
		return nil, invalid()
	}
	if kind != "notice-draft-create" && !same(command["expectedVersion"], x["expectedVersion"]) {
		return nil, invalid()
	}
	if kind != "notice-state" {
		content, e := messaging.ParseNoticeContent(command["content"])
		if e != nil || !same(content, x["content"]) {
			return nil, invalid()
		}
		command["content"] = content
	}
	target := x["targetId"]
	if kind == "notice-draft-create" {
		target = operationID
	}
	if obj(proposal["target"])["id"] != target {
		return nil, invalid()
	}
	return command, nil
}
func (s *Service) executeNotice(ctx context.Context, a Actor, x, command Object) (Object, error) {
	service, e := s.messages(a)
	if e != nil {
		return nil, e
	}
	switch str(x["kind"]) {
	case "notice-draft-create":
		return service.NoticeCreate(ctx, a, command)
	case "notice-draft-save":
		return service.NoticeSave(ctx, a, str(x["targetId"]), command)
	default:
		return service.NoticeAction(ctx, a, str(x["targetId"]), str(x["action"]), command)
	}
}
func (s *Service) recoverNotice(ctx context.Context, a Actor, x, command Object, operationID string) (Object, error) {
	service, e := s.messages(a)
	if e != nil {
		return nil, e
	}
	saved, e := service.NoticeCommandResult(ctx, a, operationID)
	if e != nil {
		return nil, e
	}
	if saved["state"] == "not-recorded" {
		return nil, nil
	}
	if saved["state"] != "recorded" {
		return Object{"operationId": operationID, "state": "unknown", "receipt": nil}, nil
	}
	kind := str(x["kind"])
	action := "notice-create"
	expected := clone(command)
	if kind != "notice-draft-create" {
		expected["noticeId"] = x["targetId"]
		action = "notice-save"
	}
	if kind == "notice-state" {
		action = "notice-" + str(x["action"])
	}
	raw, e := identity.Canonical(Object{"action": action, "input": expected})
	if e != nil {
		return nil, e
	}
	receipt := obj(saved["result"])
	if saved["kind"] != action || receipt["intentHash"] != identity.Digest(raw) {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	return Object{"recoveredReceipt": receipt, "operationId": operationID}, nil
}
func noticeResult(kind string, result Object, operationID string, x Object) (Object, error) {
	receipt := obj(result["recoveredReceipt"])
	if receipt == nil {
		notice := obj(result["notice"])
		id := x["targetId"]
		if kind == "notice-draft-create" {
			id = operationID
		}
		if notice["id"] != id {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		receipt = Object{"noticeId": id, "version": notice["version"], "state": notice["state"], "submittedJobId": notice["jobId"]}
	}
	expectedID := x["targetId"]
	expectedVersion := num(x["expectedVersion"]) + 1
	expectedState := "draft"
	if kind == "notice-draft-create" {
		expectedID = operationID
		expectedVersion = 1
	}
	if kind == "notice-state" && x["action"] == "publish" {
		expectedState = "queued"
	}
	if kind == "notice-state" && x["action"] == "withdraw" {
		expectedState = "withdrawn"
	}
	if receipt["noticeId"] != expectedID || num(receipt["version"]) != expectedVersion || receipt["state"] != expectedState || expectedState == "queued" && !validID(receipt["submittedJobId"]) {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	summary := "站内通知草稿已保存。"
	if kind == "notice-state" && x["action"] == "publish" {
		summary = "站内通知已安排投递；实际送达以投递记录为准。"
	}
	if kind == "notice-state" && x["action"] == "withdraw" {
		summary = "站内通知已撤回。"
	}
	return Object{"operationId": operationID, "state": "completed", "summary": summary, "receipt": receipt}, nil
}
