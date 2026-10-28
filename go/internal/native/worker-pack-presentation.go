package native

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var workerFieldLabels = map[string]string{"title": "标题", "summary": "内容", "text": "内容", "description": "说明", "purpose": "用途", "goal": "目标", "currentSituation": "目前情况", "requestedScope": "需要的帮助", "limitations": "限制", "message": "消息", "name": "名称", "displayName": "名称", "fileName": "文件", "filename": "文件", "reason": "说明", "resultSummary": "结果", "notes": "补充说明", "value": "结果", "values": "输入", "inputCount": "输入数量", "operation": "处理方式", "delayMs": "所选等待（毫秒）", "selectedDelayMs": "所选等待（毫秒）", "about": "简介", "claimedCapabilities": "自报能力", "problemPattern": "适用问题", "solutionStrategy": "解决方法", "applicableScope": "适用范围", "verificationMethod": "验证方法", "tools": "工具", "skills": "技能", "mcpRefs": "连接工具", "license": "许可证", "approach": "方法", "strategy": "方法", "problem": "问题说明", "attemptedApproaches": "已有尝试", "scope": "范围", "note": "补充说明", "environmentDifference": "环境差异", "issuer": "登录服务", "externalSubject": "外部账户", "providerId": "登录服务标识", "modelFamily": "模型系列", "inputScopeSummary": "输入范围", "permissionScope": "权限范围", "requestedFields": "所选字段", "reasonCode": "追查事项", "actions": "允许的操作", "adoptedParts": "实际采用的部分", "proposal": "协助说明", "reportedOutcome": "结果判断", "outcome": "结果判断"}
var workerHiddenKey = regexp.MustCompile(`(?i)(?:id|ids|hash|proof|signature|authorizationContext|receipt|secret|token|key|revision|version)$`)

func workerOutcome(v string) string {
	if label := map[string]string{"succeeded": "完成", "partial": "部分完成", "failed": "未完成", "inconclusive": "暂不能得出结论", "conflicting": "观察有冲突"}[v]; label != "" {
		return label
	}
	return v
}
func workerDisplay(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if _, ok := v.(a2aRawString); ok {
		raw, _ := protocol.Encode(v)
		var s string
		_ = json.Unmarshal(raw, &s)
		return s
	}
	return a2aJSString(v)
}
func workerReferenceArithmetic(v any) (string, string, bool) {
	m := a2aObject(v)
	if len(m) != 5 || m["state"] != "completed" || m["workerVersion"] != "0.1.0" || !isOne(text(m["operation"]), "sum", "quotient") {
		return "", "", false
	}
	for key := range m {
		if !isOne(key, "state", "operation", "value", "inputCount", "workerVersion") {
			return "", "", false
		}
	}
	if !workerNumeric(m["value"]) || !workerNumeric(m["inputCount"]) {
		return "", "", false
	}
	n, ok := a2aSafeInteger(m["inputCount"])
	if !ok || n < 1 || n > 64 {
		return "", "", false
	}
	label := "合计"
	if m["operation"] == "quotient" {
		label = "商"
	}
	raw, _ := protocol.EncodeJS(m["value"])
	return label, string(raw), true
}
func workerNumeric(v any) bool {
	switch v.(type) {
	case json.Number, float64, int, int64:
		return true
	}
	return false
}

type workerAuthoredRow struct {
	label, text string
	download    bool
}

func workerAuthoredRows(value any) []workerAuthoredRow {
	rows := []workerAuthoredRow{}
	seen := map[string]bool{}
	add := func(label, text string) {
		key := label + "\x00" + text
		if !seen[key] {
			seen[key] = true
			rows = append(rows, workerAuthoredRow{label: label, text: workerDisplay(a2aSlice(text, 48000))})
		}
	}
	var walk func(any, int)
	walk = func(value any, depth int) {
		if value == nil || depth > 8 || len(rows) >= 20 {
			return
		}
		if values, ok := value.([]any); ok {
			for _, v := range values {
				walk(v, depth+1)
			}
			return
		}
		m := a2aObject(value)
		if m == nil {
			return
		}
		if label, text, ok := workerReferenceArithmetic(value); ok {
			add(label, text)
			return
		}
		keys := []string{}
		if ordered := workerOrdered(value); ordered != nil {
			keys = ordered.Keys()
		} else {
			for key := range m {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			if m["payloadJson"] != nil {
				for i, key := range keys {
					if key == "payloadJson" {
						keys = append([]string{"payloadJson"}, append(keys[:i], keys[i+1:]...)...)
						break
					}
				}
			}
		}
		referenceArtifact := false
		if m["name"] == "Selected arithmetic output" {
			for _, part := range uploadRows(m["parts"]) {
				p := a2aObject(part)
				v := p["text"]
				if v == nil {
					v = a2aObject(p["content"])["value"]
				}
				if s, ok := v.(string); ok {
					parsed, e := protocol.DecodeOrdered([]byte(s))
					if e == nil {
						_, _, referenceArtifact = workerReferenceArithmetic(parsed)
						if referenceArtifact {
							break
						}
					}
				}
			}
		}
		for _, key := range keys {
			if len(rows) >= 20 {
				break
			}
			item := m[key]
			if key == "name" && referenceArtifact {
				continue
			}
			label := workerFieldLabels[key]
			qualifies := false
			if s, ok := item.(string); ok {
				qualifies = uploadTrim(s) != ""
			}
			if _, ok := item.(a2aRawString); ok {
				qualifies = uploadTrim(workerDisplay(item)) != ""
			}
			qualifies = qualifies || workerNumeric(item)
			if values, ok := item.([]any); ok {
				if key == "values" {
					qualifies = true
					for _, v := range values {
						qualifies = qualifies && workerNumeric(v)
					}
				} else if isOne(key, "limitations", "claimedCapabilities", "tools", "skills", "mcpRefs", "permissionScope", "requestedFields", "actions", "adoptedParts") {
					qualifies = len(values) > 0
					for _, v := range values {
						_, ok := v.(string)
						qualifies = qualifies && ok
					}
				}
			}
			if label != "" && qualifies {
				if s, ok := item.(string); ok {
					trimmed := uploadTrim(s)
					if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
						parsed, e := protocol.DecodeOrdered([]byte(s))
						if e == nil && (a2aObject(parsed) != nil || isWorkerArray(parsed)) {
							signature := "structured\x00" + s
							if !seen[signature] {
								seen[signature] = true
								before := len(rows)
								walk(parsed, depth+1)
								if len(rows) == before {
									rows = append(rows, workerAuthoredRow{label: label, text: "结构化内容已返回。可下载完整内容，在当前工作中使用。"})
								}
								rows = append(rows, workerAuthoredRow{label: "完整内容", text: "保留原始字段与格式。", download: true})
							}
							continue
						}
					}
				}
				text := workerDisplay(item)
				if values, ok := item.([]any); ok {
					parts := []string{}
					for _, v := range values {
						parts = append(parts, workerDisplay(v))
					}
					text = strings.Join(parts, "、")
				}
				if key == "operation" {
					if text == "sum" {
						text = "求和"
					}
					if text == "quotient" {
						text = "除法"
					}
				}
				if key == "reportedOutcome" || key == "outcome" {
					text = workerOutcome(text)
				}
				add(label, text)
			} else if key == "payloadJson" {
				if s, ok := item.(string); ok {
					parsed, e := protocol.DecodeOrdered([]byte(s))
					if e == nil {
						walk(parsed, depth+1)
					}
				}
			} else if !workerHiddenKey.MatchString(key) {
				walk(item, depth+1)
			}
		}
	}
	walk(value, 0)
	return rows
}
func isWorkerArray(v any) bool { _, ok := v.([]any); return ok }
func workerStateLabel(v string) string {
	return map[string]string{"accepted": "已接受", "acknowledged": "已完成", "declined": "已取消", "prepared": "待操作", "pending": "正在处理", "unknown": "正在确认原操作的结果", "absent": "原操作尚未接受", "active": "进行中", "paused": "已暂停", "stopped": "已停止", "completed": "对端报告已完成", "working": "对端正在处理", "failed": "未完成", "canceled": "对端报告已取消", "rejected": "对端已拒绝", "input-required": "对端需要补充内容", "revoked": "已撤销", "expired": "已过期", "conflict": "内容需要核对", "connected": "已连接", "session-local": "本机连接可用", "no-session": "尚未连接", "user-choice-needs-browser": "等待你的选择", "original-operation-needs-reconciliation": "正在核对原操作", "foreground-fallback": "请在当前聊天继续处理", "suspended-host": "当前宿主未运行此工作"}[v]
}
func workerPanelText(data map[string]any) string {
	view := a2aObject(data["selected"])
	preview := a2aObject(data["preview"])
	result := a2aObject(data["actionResult"])
	title := a2aObject(view["association"])["purpose"]
	if title == nil {
		title = preview["purpose"]
	}
	if title == nil {
		title = "当前 Worker 工作"
	}
	lines := []string{workerDisplay(title)}
	peer := a2aObject(view["peer"])
	state := a2aObject(peer["peer"])["state"]
	if state == nil {
		state = peer["status"]
	}
	if state == nil {
		state = a2aObject(result["result"])["state"]
	}
	if state == nil {
		state = result["state"]
	}
	if s := text(state); s != "" && s != "completed" {
		label := workerStateLabel(s)
		if label == "" {
			label = "当前结果尚待核对"
		}
		lines = append(lines, label)
	}
	content := peer["peer"]
	if content == nil {
		content = a2aObject(result["result"])["peer"]
	}
	if content == nil {
		content = preview["exact"]
	}
	for _, row := range workerAuthoredRows(content) {
		if !row.download {
			lines = append(lines, row.label+"："+row.text)
		}
	}
	if preview != nil {
		audience := map[string]string{"Private": "仅自己", "Public": "所有人", "selected-peer": "所选 Worker"}[text(preview["visibility"])]
		if audience == "" {
			audience = "本次选择的范围"
		}
		lines = append(lines, "本次内容与范围："+audience+"。请在当前宿主完成必要选择。")
	}
	for _, raw := range uploadRows(data["associations"]) {
		purpose := a2aObject(raw)["purpose"]
		if purpose == nil {
			purpose = "已有工作"
		}
		lines = append(lines, workerDisplay(purpose))
	}
	return strings.Join(lines, "\n\n")
}
func workerPanelResult(data map[string]any, componentOnly bool) *mcp.CallToolResult {
	model := data
	meta := mcp.Meta(nil)
	if preview := a2aObject(data["preview"]); componentOnly && preview != nil {
		model = a2aClone(data)
		p := a2aClone(preview)
		delete(p, "exact")
		p["exactContentInComponent"] = true
		model["preview"] = p
		meta = mcp.Meta{"galaxyWorker": map[string]any{"preview": preview}}
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: workerPanelText(model)}}, StructuredContent: model, Meta: meta}
}
