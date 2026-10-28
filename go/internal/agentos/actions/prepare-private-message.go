package actions

import "context"

func (s *Service) preparePrivateMessage(ctx context.Context, a Actor, x Object, p *preparation) error {
	service, e := s.chatReports(a)
	if e != nil {
		return e
	}
	detail, e := service.OperatorGet(ctx, a, Object{"reportId": x["reportId"]})
	if e != nil {
		return e
	}
	var material Object
	for _, v := range items(detail["materials"]) {
		item := obj(v)
		if item["messageId"] == x["messageId"] && item["state"] == "available" {
			material = item
			break
		}
	}
	if material == nil {
		return fail("chat_report_message_not_selected", 404)
	}
	key := map[string]string{"hide": "canHide", "restore": "canRestore", "keep": "canKeep"}[str(x["action"])]
	if e = capability(obj(material["moderation"])[key]); e != nil {
		return e
	}
	p.expiry(detail["readExpiresAt"])
	p.target = Object{"kind": "chat-report", "id": x["reportId"], "label": "具体私聊案件已选消息", "href": "/admin/operations/chat-reports?report=" + str(x["reportId"])}
	p.title = "处理本案已选消息"
	p.command = Object{"expectedVersion": detail["version"], "expectedRevision": obj(material["moderation"])["revision"], "messageRevision": material["revision"], "action": x["action"], "summary": x["summary"]}
	p.basis = []any{basis("资料范围", "仅本案明确提供且当前仍可读取的消息版本")}
	p.impact = []any{"记录本案单条消息的" + map[string]string{"hide": "屏蔽", "restore": "恢复", "keep": "维持屏蔽"}[str(x["action"])] + "；其他案件覆盖和个人隐藏保持各自有效条件。"}
	return nil
}
