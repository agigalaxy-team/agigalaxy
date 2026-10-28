package actions

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"slices"
)

func parseFeedbackRequest(x Object) (Object, error) {
	if !validID(x["targetId"]) {
		return nil, invalid()
	}
	command := pick(x, "category", "module", "state", "note")
	command["operationId"], command["expectedRevision"] = "00000000-0000-0000-0000-000000000000", 1
	b, e := protocol.Encode(command)
	if e != nil {
		return nil, e
	}
	normalized, e := feedback.ParseUpdate(b)
	if e != nil {
		return nil, e
	}
	b, e = protocol.Encode(normalized)
	if e != nil {
		return nil, e
	}
	var clean Object
	if e = protocol.Decode(b, &clean); e != nil {
		return nil, e
	}
	out := pick(clean, "category", "module", "state", "note")
	out["kind"], out["targetId"] = x["kind"], x["targetId"]
	return out, nil
}
func (s *Service) feedback(a Actor) (*feedback.Operations, error) {
	if s.Feedback == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	v := s.Feedback.WithAuthority(s.authority(a))
	if v == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	return v, nil
}

var feedbackStateNames = map[string]string{"pending": "待处理", "processing": "处理中", "closed": "已关闭"}

func (s *Service) prepareFeedback(ctx context.Context, a Actor, x Object, p *preparation) error {
	service, e := s.feedback(a)
	if e != nil {
		return e
	}
	response, e := service.Get(ctx, a, str(x["targetId"]), "")
	if e != nil {
		return e
	}
	response, e = wire(response)
	if e != nil {
		return e
	}
	item := obj(response["feedback"])
	if e = capability(obj(response["permissions"])["canManage"]); e != nil {
		return e
	}
	p.expiry(response["readExpiresAt"])
	p.target = Object{"kind": "feedback", "id": x["targetId"], "label": label(item["title"], "使用反馈"), "href": "/admin/operations/feedback?id=" + str(x["targetId"])}
	p.title = "更新这条使用反馈"
	p.command = pick(x, "category", "module", "state", "note")
	p.command["expectedRevision"] = item["revision"]
	state := feedbackStateNames[str(item["state"])]
	if state == "" {
		state = "未记录"
	}
	p.basis = []any{basis("当前状态", state)}
	if v, ok := x["state"]; ok {
		p.impact = append(p.impact, "状态："+feedbackStateNames[str(v)])
	}
	if v, ok := x["category"]; ok {
		category := "未分类"
		if v == "problem" {
			category = "问题"
		} else if v != nil {
			category = "建议"
		}
		p.impact = append(p.impact, "分类："+category)
	}
	if v, ok := x["module"]; ok {
		p.impact = append(p.impact, "所属模块："+map[string]string{"account": "账户", "community": "社区", "chat": "聊天", "work": "协作", "discovery": "发现", "other": "其他"}[str(v)])
	}
	if str(x["note"]) != "" {
		p.impact = append(p.impact, "添加内部备注："+str(x["note"]))
	}
	return nil
}
func unknownFeedback(operation string) Object {
	return Object{"operationId": operation, "state": "unknown", "summary": "本次反馈处理结果尚未核实，系统会继续查询原结果。", "receipt": nil}
}
func feedbackResult(result Object, operation string, request, command Object, receipt bool) (Object, error) {
	row := obj(result["feedback"])
	revision, id := row["revision"], row["id"]
	if receipt {
		revision, id = result["revision"], result["feedbackId"]
	}
	valid := num(command["expectedRevision"]) >= 1 && count(command["expectedRevision"]) != nil && num(revision) == num(command["expectedRevision"])+1 && count(revision) != nil && result["operationId"] == operation && id == request["targetId"]
	if !receipt {
		for _, k := range []string{"category", "module", "state"} {
			if v, ok := command[k]; ok {
				valid = valid && same(row[k], v)
			}
		}
		if note, ok := command["note"]; ok {
			history := items(obj(result["history"])["items"])
			valid = valid && len(history) > 0
			if len(history) > 0 {
				valid = valid && obj(history[0])["kind"] == "updated" && obj(history[0])["note"] == note
			}
		}
	}
	if !valid {
		if receipt {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return unknownFeedback(operation), nil
	}
	return Object{"operationId": operation, "state": "completed", "summary": "这条反馈已更新。", "receipt": Object{"operationId": operation, "feedbackId": request["targetId"], "revision": revision, "replayed": result["replayed"] == true}}, nil
}
func normalizedFeedbackCommand(command Object) (Object, error) {
	b, e := protocol.Encode(command)
	if e != nil {
		return nil, e
	}
	x, e := feedback.ParseUpdate(b)
	if e != nil {
		return nil, e
	}
	b, e = protocol.Encode(x)
	if e != nil {
		return nil, e
	}
	var out Object
	e = protocol.Decode(b, &out)
	return out, e
}
func definiteFeedbackError(code string) bool {
	return slices.Contains([]string{"invalid_feedback_request", "feedback_revision_conflict", "feedback_no_change"}, code)
}
