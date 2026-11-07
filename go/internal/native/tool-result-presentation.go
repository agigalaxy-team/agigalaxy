package native

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Only a transport explicitly marked unknown establishes uncertain delivery.
// A rejection, validation failure, or an HTTP status alone does not.
func nativeOutcomeUnknown(err error) bool {
	var business *businessRequestError
	var request *ConnectionRequestError
	return errors.As(err, &business) && errors.As(business, &request) && request.Outcome == "unknown"
}

// Convert only the legacy JSON text result at the actual MCP boundary. Internal
// handlers still exchange their original wire representation. Already authored
// text, multi-part content, metadata and the input-required flow are untouched.
func presentNativeToolResult(result *mcp.CallToolResult) *mcp.CallToolResult {
	if result == nil || result.RequestState != "" || len(result.InputRequests) != 0 || len(result.Content) != 1 {
		return result
	}
	content, ok := result.Content[0].(*mcp.TextContent)
	if !ok {
		return result
	}
	decoder := json.NewDecoder(strings.NewReader(content.Text))
	decoder.UseNumber()
	var data any
	if decoder.Decode(&data) != nil || !json.Valid([]byte(content.Text)) {
		return result
	}
	// A result can also be retained by an internal choice record; do not mutate it.
	presented := *result
	result = &presented
	if result.StructuredContent == nil {
		switch data.(type) {
		case map[string]any:
			result.StructuredContent = json.RawMessage(content.Text)
		case []any:
			result.StructuredContent = map[string]any{"items": json.RawMessage(content.Text)}
		default:
			result.StructuredContent = map[string]any{"value": json.RawMessage(content.Text)}
		}
	}
	lines := nativeResultLines(data, result.IsError)
	result.Content = []mcp.Content{}
	if len(lines) > 0 {
		rendered := *content
		rendered.Text = strings.Join(lines, "\n\n")
		result.Content = []mcp.Content{&rendered}
	}
	return result
}

var nativeReadableFields = map[string]string{
	"title": "标题", "summary": "摘要", "text": "内容", "content": "内容", "body": "正文", "excerpt": "摘录", "markdown": "内容", "answer": "回答", "question": "问题", "reply": "回复", "description": "说明", "name": "名称", "displayName": "名称", "fileName": "文件", "filename": "文件", "purpose": "用途", "goal": "目标", "currentSituation": "目前情况", "requestedScope": "需要的帮助", "limitations": "限制", "resultSummary": "结果", "notes": "补充说明", "note": "补充说明", "about": "简介", "problemPattern": "适用问题", "solutionStrategy": "解决方法", "applicableScope": "适用范围", "verificationMethod": "验证方法", "approach": "方法", "strategy": "方法", "problem": "问题说明", "attemptedApproaches": "已有尝试", "environmentDifference": "环境差异", "adoptedParts": "实际采用的部分", "proposal": "协助说明", "value": "结果", "values": "结果", "tools": "工具", "skills": "技能", "license": "许可证",
}
var nativeReadableStates = map[string]string{
	"declined": "已取消", "prepared": "已准备", "pending": "正在处理", "unknown": "结果尚未确定", "absent": "原操作尚未接受", "active": "进行中", "paused": "已暂停", "stopped": "已停止", "working": "正在处理", "failed": "未完成", "canceled": "已取消", "rejected": "已拒绝", "input-required": "需要补充内容", "revoked": "已撤销", "expired": "已过期", "conflict": "内容存在冲突", "connected": "已连接", "user-choice-needs-browser": "等待你的选择", "original-operation-needs-reconciliation": "原操作结果尚未确定",
}

func nativeResultLines(data any, isError bool) []string {
	if isError {
		object, _ := data.(map[string]any)
		message := "这次操作遇到问题，原因尚不明确。"
		switch object["error"] {
		case helpQueryInvalid:
			message = `查找帮助只需提供问题关键词，例如 {"query":"问题关键词"}。按来源查询时请使用工具说明中的请求格式。`
		case "native_remote_input_invalid", "native_choice_input_invalid", "local_work_input_invalid":
			message = "这次操作所需的内容不完整或不符合要求。"
		case "local_identity_required":
			message = "当前设备尚未准备所需的身份。"
		case "request_timeout":
			message = "请求超时，尚未收到结果。"
		case "request_cancelled":
			message = "请求已中断，尚未收到结果。"
		case "native_request_transport_failed":
			message = "连接中断，尚未收到结果。"
		case "access_denied", "not_authorized":
			message = "当前权限不允许这次操作。"
		}
		lines := []string{message}
		if object["mayNeedReceiptReconciliation"] == true || object["state"] == "unknown" {
			lines = append(lines, "结果尚未确认。")
		}
		// Full partial results and recovery evidence remain in structured data.
		return lines
	}
	lines := []string{}
	if object, ok := data.(map[string]any); ok {
		if object["queryDoesNotPublish"] == true {
			for _, value := range uploadRows(object["results"]) {
				row := uploadObject(value)
				label := "资料"
				switch row["kind"] {
				case "search-v2":
					label = "相关资料"
				case "participants-v2", "participant-v2":
					label = "相关参与者"
				}
				switch row["state"] {
				case "empty":
					lines = append(lines, label+"：本次没有找到匹配结果。")
				case "failed":
					lines = append(lines, label+"：暂未查到结果，请稍后再试。")
				case "ready":
					items := uploadRows(uploadObject(row["data"])["items"])
					lines = append(lines, fmt.Sprintf("%s：找到 %d 项。", label, len(items)))
					lines = append(lines, nativeAuthoredLines(items)...)
				}
			}
		}
		if object["initialized"] == true {
			service := uploadObject(object["serviceAccess"])
			switch service["state"] {
			case "ready":
				lines = append(lines, "本机初始化已完成，服务已连接。")
			case "disconnected":
				lines = append(lines, "本机已就绪，暂未连接服务。")
			case "local-only":
				lines = append(lines, "本机初始化已完成。")
			}
		}
		service, _ := object["access"].(map[string]any)
		if service["kind"] == "service" {
			switch service["state"] {
			case "ready":
				lines = append(lines, "已接入银河。")
			case "disconnected":
				lines = append(lines, "暂未连接服务。")
			}
		}
		access, _ := object["accountAccess"].(map[string]any)
		accountAccess := access["kind"] == "official-account"
		if accountAccess {
			switch access["state"] {
			case "ready":
				lines = append(lines, "在线账户：已关联。")
			case "account-required":
				lines = append(lines, "在线账户：未关联。")
			case "unknown":
				lines = append(lines, "在线账户：状态未知。")
			}
		}
		for _, key := range []string{"state", "status"} {
			if accountAccess {
				break
			}
			if state, ok := object[key].(string); ok && nativeReadableStates[state] != "" {
				lines = append(lines, nativeReadableStates[state]+"。")
				break
			}
		}
		if object["state"] == "user-choice-needs-browser" {
			if url, ok := object["url"].(string); ok && url != "" {
				if object["reason"] == "official-account-login" {
					lines = []string{"登录银河账户并确认本机身份：\n" + url}
				} else {
					lines = append(lines, "打开页面完成选择：\n"+url)
				}
			}
		}
		if object["state"] == "linked" {
			lines = append(lines, "银河账户已关联。")
		}
	}
	lines = append(lines, nativeAuthoredLines(data)...)
	if len(lines) == 0 {
		switch value := data.(type) {
		case []any:
			if len(value) == 0 {
				return []string{"没有返回条目。"}
			}
		case map[string]any:
			if items, ok := value["items"].([]any); ok && len(items) == 0 {
				return []string{"没有返回条目。"}
			}
		case string:
			if value != "" {
				return []string{value}
			}
		case json.Number, bool:
			return []string{fmt.Sprint(value)}
		}
		return nil
	}
	return lines
}

func nativeAuthoredLines(data any) []string {
	lines := []string{}
	var walk func(any)
	walk = func(value any) {
		switch item := value.(type) {
		case []any:
			for _, child := range item {
				walk(child)
			}
		case map[string]any:
			keys := make([]string, 0, len(item))
			for key := range item {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				child := item[key]
				if label, ok := nativeReadableFields[key]; ok {
					switch v := child.(type) {
					case string:
						if strings.TrimSpace(v) != "" {
							lines = append(lines, label+"："+v)
						}
						continue
					case json.Number:
						lines = append(lines, label+"："+string(v))
						continue
					case []any:
						values := []string{}
						for _, x := range v {
							switch x := x.(type) {
							case string:
								values = append(values, x)
							case json.Number:
								values = append(values, string(x))
							default:
								values = nil
							}
							if values == nil {
								break
							}
						}
						if len(values) > 0 {
							lines = append(lines, label+"："+strings.Join(values, "、"))
							continue
						}
					}
				}
				// Only known content containers are traversed. Unknown containers
				// can contain diagnostics or configuration, even under text keys.
				switch key {
				case "items", "work", "works", "observations", "observation", "posts", "post", "comments", "comment", "replies", "reply", "messages", "entries", "materials", "material", "parts":
					switch child.(type) {
					case map[string]any, []any:
						walk(child)
					}
				}
			}
		}
	}
	walk(data)
	return lines
}
