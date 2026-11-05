package native

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// Confirmation text describes the person's choice. The original input remains
// with the operation and is never reconstructed from this presentation.
func userChoiceTitle(name string) string {
	titles := map[string]string{
		"galaxy_native_initialize": "创建银河身份", "galaxy_native_connect": "连接银河", "galaxy_native_account_connect": "登录银河",
		"galaxy_native_disconnect": "断开连接", "galaxy_native_authorize": "分享所选内容",
		"galaxy_identity_account_execute": "调整账户关联", "galaxy_identity_group_native_execute": "调整身份显示关系",
		"galaxy_identity_device_native_confirm": "移除设备", "galaxy_identity_device_native_stop_retry": "停止等待设备操作",
		"galaxy_device_offer": "接续已有身份", "galaxy_device_approve": "允许新设备接续", "galaxy_device_accept": "在此设备接续身份",
		"galaxy_local_archive_configure": "设置会话保存", "galaxy_local_upload_privacy_set": "设置分享范围", "galaxy_local_settings_save": "保存设置",
		"galaxy_local_work_delete": "删除本机工作记录", "galaxy_local_archive_delete": "删除本机保存的会话",
		"galaxy_work_sync_choice": "设置工作记录同步", "galaxy_archive_sync_choice": "设置会话同步",
		"galaxy_work_cloud_delete": "删除云端工作记录", "galaxy_archive_cloud_delete": "删除云端会话",
		"galaxy_summary_sync_choice": "设置笔记同步", "galaxy_summary_sync_resolve": "保存合并后的笔记", "galaxy_summary_cloud_delete": "删除云端笔记",
		"galaxy_host_notifications_enable": "开启消息提醒", "galaxy_host_notifications_permission": "允许系统通知",
		"galaxy_native_notification_enable": "开启消息提醒", "galaxy_native_notification_permission": "允许系统通知",
		"galaxy_panel_action_execute": "确认所选操作", "galaxy_help_action_execute": "确认所选操作",
		"galaxy_watch_start": "关注这段对话", "galaxy_watch_resume": "恢复关注", "galaxy_watch_pause": "暂停关注",
		"galaxy_local_worker_identity_create": "创建工作身份",
	}
	if title := titles[name]; title != "" {
		return title
	}
	for _, kind := range [][2]string{{"chat", "对话"}, {"contact", "联系"}, {"recruitment", "招募信息"}, {"capsule", "方法"}, {"summary", "笔记"}, {"project", "项目"}, {"inbox", "消息设置"}, {"worker", "协作工作"}, {"a2a", "外部协作"}, {"identity", "身份设置"}} {
		if strings.Contains(name, kind[0]) {
			return "确认" + kind[1] + "操作"
		}
	}
	return "确认操作"
}

func userChoiceMessage(name string, input any, message string) string {
	// Agent-facing English descriptions are not a person's confirmation text.
	hasChinese := strings.ContainsFunc(message, func(r rune) bool { return unicode.Is(unicode.Han, r) })
	if !hasChinese {
		message = userChoiceTitle(name)
	}
	var value any
	if raw, err := protocol.Encode(input); err == nil {
		_ = protocol.Decode(raw, &value)
	}
	lines := []string{strings.TrimSpace(message)}
	seen := map[string]bool{}
	for _, line := range choiceContentLines(value, 0) {
		if !seen[line] && !strings.Contains(message, line) {
			lines = append(lines, line)
			seen[line] = true
		}
	}
	return strings.Join(lines, "\n")
}

func choiceContentLines(value any, depth int) []string {
	if depth > 8 {
		return nil
	}
	if rows, ok := value.([]any); ok {
		var out []string
		for _, row := range rows {
			out = append(out, choiceContentLines(row, depth+1)...)
		}
		return out
	}
	obj, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	var lines []string
	// Only business fields belong here. Configuration, signatures, hashes and
	// operation locators stay in the original machine-readable operation.
	for _, field := range [][2]string{
		{"title", "标题"}, {"name", "名称"}, {"displayName", "名称"}, {"email", "账户"}, {"recipientNames", "接收人"},
		{"summary", "摘要"}, {"purpose", "用途"}, {"description", "说明"}, {"text", "内容"}, {"body", "正文"}, {"message", "消息"},
		{"goal", "目标"}, {"requestedScope", "需要的帮助"}, {"resultSummary", "结果"}, {"limitations", "适用限制"},
		{"adoptedParts", "采用的部分"}, {"notes", "补充说明"}, {"reason", "原因"}, {"fileName", "文件"}, {"filename", "文件"},
		{"visibility", "可见范围"}, {"subjectType", "身份类型"}, {"mode", "处理方式"}, {"level", "分享范围"},
		{"recipient", "接收方"}, {"viewers", "接收人"}, {"recipientIds", "接收人"}, {"targetSubjectId", "相关成员"},
		{"subjectId", "银河 ID"}, {"galaxyId", "银河 ID"}, {"targetAccountId", "目标账户"}, {"deviceId", "设备"},
		{"endpoint", "服务"}, {"selectedEndpoint", "服务"}, {"enabled", "启用"}, {"includeFullConversations", "包含完整会话"},
		{"autoCleanAfterDays", "自动清理天数"}, {"retentionDays", "保存天数"},
	} {
		v, exists := obj[field[0]]
		if !exists || v == nil {
			continue
		}
		if field[0] == "recipientIds" && len(uploadRows(obj["recipientNames"])) > 0 {
			continue
		}
		shown := choiceDisplayValue(v)
		if shown != "" {
			lines = append(lines, field[1]+"："+shown)
		}
	}
	for _, key := range []string{"preview", "exact", "payload", "draft", "event", "selected", "target", "source", "original", "work", "session", "material", "materials", "content", "uploadPrivacy", "settings", "input", "peer", "worker", "device", "newDevice", "request", "readable", "sessionChoices"} {
		lines = append(lines, choiceContentLines(obj[key], depth+1)...)
	}
	return lines
}

func choiceDisplayValue(value any) string {
	switch v := value.(type) {
	case string:
		if label := map[string]string{"Public": "公开", "public": "公开", "Private": "仅自己", "private": "仅自己", "Shared": "所选成员", "shared": "所选成员", "person": "个人", "organization": "组织", "local-only": "仅本机", "history-overview": "工作概览", "work-content": "所选工作内容", "conversation-archive": "所选完整会话", "read": "读取", "draft": "起草", "respond": "读取并回复"}[v]; label != "" {
			return label
		}
		return v
	case bool:
		if v {
			return "是"
		}
		return "否"
	case []any:
		var parts []string
		for _, item := range v {
			if _, ok := item.(map[string]any); ok {
				continue
			}
			if text := choiceDisplayValue(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "、")
	case map[string]any:
		return ""
	default:
		return fmt.Sprint(value)
	}
}

// A completed callback is not necessarily a completed business task.
func userChoiceOutcome(result any) string {
	obj := uploadObject(result)
	if obj["initialized"] == true {
		return "银河身份已准备好。"
	}
	if obj["settings"] != nil {
		return "设置已保存。"
	}
	switch obj["state"] {
	case "linked":
		return "银河账户已关联。"
	case "committed":
		return "更改已生效。"
	case "revoked":
		return "访问权限已撤销。"
	case "pending", "running", "in-progress":
		return "正在处理。"
	case "acknowledged", "accepted":
		return "对方已接收请求。"
	case "prepared":
		return "已准备好，等待确认。"
	case "canceled", "declined":
		return "已取消。"
	case "failed", "rejected":
		return "操作未完成。"
	}
	if lines := nativeAuthoredLines(result); len(lines) > 0 {
		return strings.Join(lines, "\n")
	}
	return "处理结果已返回。"
}
