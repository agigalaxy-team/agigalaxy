package native

import (
	"fmt"
	"strings"
	"time"
)

func choiceDeadline(value any) string {
	n := integer(value)
	if n <= 0 {
		return ""
	}
	if n > 1e12 {
		return time.UnixMilli(n).Local().Format("2006/01/02 15:04 MST")
	}
	return time.Unix(n, 0).Local().Format("2006/01/02 15:04 MST")
}

// The original arguments are kept by the choice mechanism. Only the parts a
// person needs to review are placed in the confirmation message.
func chatChoiceMessage(name string, input, room map[string]any) string {
	title := text(room["title"])
	if title == "" {
		title = text(input["title"])
	}
	var lines []string
	switch name {
	case "galaxy_chat_create":
		lines = append(lines, "创建对话")
	case "galaxy_chat_vote":
		lines = append(lines, "对房间提议作出选择", "你的选择："+map[string]string{"approve": "同意", "reject": "反对", "cancel": "撤回选择"}[text(input["choice"])])
	case "galaxy_chat_propose":
		actions := map[string]string{"invite": "邀请成员", "remove": "移除成员", "retention": "调整消息保存时间", "become-owner": "成为负责人", "transfer-owner": "转交负责人", "persistent": "调整房间保留设置", "dissolve": "解散房间", "join-rule": "调整加入规则", "appoint-admin": "指定管理员", "revoke-admin": "撤销管理员", "successor-owner": "指定接续负责人"}
		lines = append(lines, "发起提议："+actions[text(input["action"])])
		if n := integer(input["retentionDays"]); n > 0 {
			lines = append(lines, fmt.Sprintf("消息保存 %d 天", n))
		}
		if mode := text(uploadObject(input["joinRule"])["mode"]); mode != "" {
			lines = append(lines, "加入方式："+map[string]string{"approval-required": "申请后批准", "member-invite": "成员邀请", "manager-invite": "管理员邀请", "open": "开放加入"}[mode])
		}
		if v, ok := input["persistent"].(bool); ok {
			if v {
				lines = append(lines, "保留此房间")
			} else {
				lines = append(lines, "按普通期限保留此房间")
			}
		}
		if target := text(input["targetSubjectId"]); target != "" {
			lines = append(lines, "相关成员："+target)
		}
	case "galaxy_chat_accept_invitation":
		if input["accept"] == true {
			lines = append(lines, "接受房间邀请")
		} else {
			lines = append(lines, "谢绝房间邀请")
		}
	case "galaxy_chat_leave":
		lines = append(lines, "退出这段对话")
	case "galaxy_chat_agent_grant":
		lines = append(lines, "允许你的 AI 在这段对话中"+map[string]string{"read": "读取消息", "draft": "读取消息和起草回复", "respond": "读取消息并发送回复"}[text(input["mode"])])
		if input["primaryResponder"] == true {
			lines = append(lines, "由这个 AI 优先回复")
		}
	}
	if title != "" {
		lines = append(lines, "对话："+title)
	}
	if until := choiceDeadline(input["expiresAt"]); until != "" {
		lines = append(lines, "有效至："+until)
	}
	return strings.Join(lines, "\n")
}

func watchChoiceMessage(name string, input, current, room map[string]any) string {
	lines := []string{map[string]string{
		"galaxy_watch_start":         "开始关注这段对话",
		"galaxy_watch_host_activate": "让你的 AI 继续已授权的关注",
		"galaxy_watch_pause":         "暂停关注，并撤销这次关注使用的回复权限",
		"galaxy_watch_resume":        "按本次选择恢复关注",
	}[name]}
	if title := text(room["title"]); title != "" {
		lines = append(lines, "对话："+title)
	}
	purpose := text(input["purpose"])
	if purpose == "" {
		purpose = text(current["purpose"])
	}
	if purpose != "" {
		lines = append(lines, "关注内容："+purpose)
	}
	if until := choiceDeadline(input["expiresAt"]); until != "" {
		lines = append(lines, "有效至："+until)
	}
	return strings.Join(lines, "\n")
}

func authorizationChoiceMessage(input, payload map[string]any) string {
	labels := map[string]string{
		"hub.publish": "发布站点资料", "qualification.request": "提交资质申请", "configuration.publish": "发布配置信息",
		"ci.observe": "提交构建验证资料", "proof.publish": "发布证明", "case.teaser.publish": "发布工作简介",
		"history.query": "授权读取履历", "profile.publish": "发布个人资料", "project.write": "保存项目资料",
		"contact.write": "提交联系内容", "recruitment.write": "保存招募信息", "contribution.publish": "发布贡献记录",
		"experience.submit": "提交使用经历", "qualification.compute": "计算资质", "qualification.source-permission": "调整资质资料权限",
		"context.grant": "分享所选材料", "evidence.submit": "提交证据", "outcome.material": "提交结果材料",
		"assistance.publish": "发布求助", "task.owner-read": "授权读取任务", "comment.publish": "发布评论",
		"moderation.publish": "提交治理信息", "capsule.publish": "发布方法", "capsule.use": "记录方法使用",
		"capsule.permission": "调整方法访问范围", "builder.publish": "发布建设者资料", "forum.post.publish": "发布帖子",
		"forum.reply.publish": "发布回复", "forum.withdraw": "撤回社区内容", "forum.report.publish": "提交举报",
		"forum.report.event": "更新举报处理", "forum.governance.resolve": "处理社区治理事项",
		"forum.section.write": "保存社区栏目", "forum.section.classify": "调整社区内容分类",
	}
	lines := []string{labels[text(input["action"])]}
	visibility := map[string]string{"Public": "公开", "Shared": "仅所选接收人", "Private": "仅自己"}[text(input["visibility"])]
	if visibility != "" {
		lines = append(lines, "可见范围："+visibility)
	}
	if viewers := mustUploadStrings(input["viewers"]); len(viewers) > 0 {
		lines = append(lines, "接收人："+strings.Join(viewers, "、"))
	}
	for _, row := range [][2]string{{"title", "标题"}, {"purpose", "用途"}, {"summary", "摘要"}, {"text", "正文"}, {"body", "正文"}, {"description", "说明"}} {
		if body := text(payload[row[0]]); body != "" {
			lines = append(lines, row[1]+"："+body)
		}
	}
	if until := choiceDeadline(input["expiresAt"]); until != "" {
		lines = append(lines, "有效至："+until)
	}
	return strings.Join(lines, "\n")
}
