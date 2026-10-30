package agentos

import (
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

var cardPresentationUUID = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
var cardPresentationInternalLabel = regexp.MustCompile(`[A-Za-z][A-Za-z0-9_.:-]*`)
var cardPresentationChunk = regexp.MustCompile(`^(.*?)（([0-9]+)/([0-9]+)）：(.*)$`)

var cardPresentationLabels = map[string]string{
	"automationEnabled": "自动运行启用", "executionEnabled": "领域执行启用", "algorithm": "排序方式", "fixedConstraints": "固定约束", "personalNeeds": "个人需求约束", "supply": "供给约束", "negativeFeedback": "负反馈约束", "themeKey": "主题", "common": "共同设置", "domains": "领域", "strategies": "策略", "name": "名称", "label": "名称", "key": "标识", "domain": "领域", "aiDomain": "AI 领域", "objective": "目标", "enabled": "启用", "mode": "执行方式", "template": "模板", "judgment": "判断方式", "instructions": "工作要求", "condition": "条件", "execution": "执行设置", "ordinaryBounds": "普通策略边界", "recovery": "恢复设置", "trigger": "触发条件", "kind": "类型", "minutes": "间隔分钟", "at": "时间", "eventTypes": "事件类型", "grantIds": "授权范围", "resourceScope": "资源范围", "resourceIds": "指定资源", "requiredRehearsal": "要求预演", "actions": "动作", "parameters": "参数", "path": "参数路径", "minimum": "最小值", "maximum": "最大值", "modes": "允许的执行方式", "canEnable": "允许启用", "canDisable": "允许停用", "canCreate": "允许创建", "versionId": "版本", "conditions": "恢复条件", "combinator": "条件关系", "rules": "条件规则", "field": "字段", "operator": "操作符", "value": "值", "accountTier": "账户层级", "subjectType": "主体类型", "textLength": "文本长度", "linkCount": "链接数", "attachmentCount": "附件数", "fileBytes": "文件大小", "keywordList": "关键词", "domainList": "域名列表", "config": "配置", "configuration": "配置", "controls": "控制设置", "avoidRepetition": "避免重复", "avoidConcentration": "避免集中", "direction": "方向", "directions": "各主题方向", "mapping": "主题映射", "categories": "分类", "topics": "主题", "keywords": "关键词", "title": "标题", "body": "正文", "content": "内容", "purpose": "用途", "href": "链接", "audience": "受众", "accountIds": "指定账户", "subjectTypes": "主体类型", "channels": "渠道", "schedule": "发送时间", "senderKey": "发送身份", "automation": "自动发送", "expiresAt": "有效期至", "startsAt": "开始时间", "endsAt": "结束时间", "scheduledAt": "计划时间", "reason": "原因", "state": "状态", "action": "动作", "permissions": "权限", "permission": "权限", "roles": "角色", "role": "角色", "scope": "范围", "priority": "优先级", "weight": "权重", "limit": "数量上限", "query": "查询", "text": "文本", "description": "说明", "search": "搜索", "settings": "设置", "ranking": "排序", "filters": "筛选条件", "rulesEnabled": "规则启用", "resultLimit": "结果上限", "maxResults": "最大结果数", "timeout": "超时时间", "interval": "间隔", "daily": "每日", "event": "事件", "type": "类型", "items": "项目", "targets": "目标", "tagIds": "标签", "tags": "标签", "include": "包含", "exclude": "排除", "sources": "来源", "boost": "提升权重", "threshold": "阈值", "maxItems": "最大数量", "minItems": "最小数量", "queryExpansion": "查询扩展", "semantic": "语义", "lexical": "词语", "matching": "匹配", "fuzzy": "模糊匹配", "synonyms": "同义词", "stopWords": "停用词", "minScore": "最低分数", "maxAgeDays": "最长天数", "account": "账户", "community": "社区", "chat": "聊天", "work": "协作", "discovery": "发现", "overview": "运营概览", "governance": "治理", "messaging": "消息", "maintenance": "维护", "policy": "策略", "read": "读取", "write": "写入", "publish": "发布", "status": "状态", "visibility": "可见性", "channel": "渠道", "method": "方式", "count": "数量", "url": "链接", "timezone": "时区", "start": "开始", "end": "结束", "frequency": "频率", "intervalMinutes": "间隔分钟", "dailyAt": "每日时间", "recipients": "收件人", "subject": "主题", "message": "消息", "summary": "摘要", "internalNote": "内部备注", "maxAttempts": "最大尝试次数", "retry": "重试", "attempts": "尝试次数", "autoExecute": "自动执行", "maxExecutions": "最大执行次数", "cooldownMinutes": "冷却分钟", "enabledActions": "启用的动作", "maxPerRun": "单次上限", "maxPerDay": "每日上限", "minIntervalMinutes": "最小间隔分钟", "maxDurationMinutes": "最长持续分钟", "requireApproval": "要求审批", "allow": "允许", "deny": "拒绝", "all": "全部", "labelIds": "标签", "scopeKind": "范围类型", "pinned": "置顶", "featured": "精选", "topic": "分类", "category": "分类", "note": "备注",
}
var cardPresentationEnums = map[string]string{"native-unavailable": "执行引擎不可用", "workflow-failed": "流程失败",
	"human-led": "人工主导", "analysis-only": "仅分析", "business-action": "业务操作", "selected-public-content-visibility": "指定公开内容可见性", "textLength": "文本长度", "linkCount": "链接数", "attachmentCount": "附件数", "fileBytes": "文件大小", "keywordList": "关键词", "domainList": "域名列表", "accountTier": "账户层级", "subjectType": "主体类型", "manual": "手动", "interval": "间隔", "daily": "每天", "event": "事件", "code": "代码执行", "ai": "AI 执行", "ai-human": "AI 处理、人工参与", "human-ai": "人工处理、AI 参与", "code-automatic": "代码自动执行", "ai-autonomous": "AI 自主执行", "ai-human-participation": "AI 执行、人工参与", "prepared-command": "已准备命令", "semantic": "语义判断", "eligible": "符合条件的对象", "selected": "指定对象", "unresolved": "未确定", "and": "同时满足", "or": "满足任一", "eq": "等于", "neq": "不等于", "gt": "大于", "gte": "大于或等于", "lt": "小于", "lte": "小于或等于", "matches": "匹配", "person": "个人", "agent": "AI 账户", "organization": "组织", "accounts": "指定账户", "attributes": "按属性", "announcement": "公开公告", "inapp": "站内信", "email": "系统邮件", "maintenance": "维护通知", "service-update": "服务更新", "community-update": "社区更新", "draft": "草稿", "active": "运行中", "paused": "已暂停", "stopped": "已停止", "expired": "已到期", "activate": "启用", "resume": "恢复", "pause": "暂停", "stop": "停止", "withdraw": "撤回", "keep": "保持", "increase": "增加", "decrease": "减少", "pending": "待处理", "processing": "处理中", "closed": "已关闭", "public": "公开", "private": "私有", "overview": "运营概览", "governance": "治理", "messaging": "消息", "discovery": "发现", "account": "账户", "community": "社区", "chat": "聊天", "work": "协作", "other": "其他", "true": "是", "false": "否", "all": "全部",
}
var cardPresentationEnumFields = map[string]bool{"kind": true, "domain": true, "aiDomain": true, "mode": true, "judgment": true, "combinator": true, "operator": true, "purpose": true, "state": true, "action": true, "direction": true, "subjectType": true, "subjectTypes": true, "channels": true, "channel": true, "visibility": true, "modes": true, "template": true, "field": true, "actions": true, "permissions": true, "permission": true, "eventTypes": true, "key": true, "senderKey": true}
var cardPresentationMetadata = map[string]bool{"id": true, "version": true, "revision": true, "expectedVersion": true, "expectedRevision": true, "schemaVersion": true, "createdAt": true, "updatedAt": true, "readExpiresAt": true, "checkedAt": true, "operationId": true, "runId": true, "versionId": true, "themeId": true, "targetId": true, "hrefInternal": true}

var cardPresentationPermissionNames = func() map[string]string {
	names := map[string]string{}
	for _, item := range operationspermissions.CatalogMetadata() {
		code, name := text(item, "code"), text(item, "label")
		if code != "" && name != "" {
			names[code] = name
		}
	}
	return names
}()
var cardPresentationPermissionToken = regexp.MustCompile(`[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+`)

type cardPresentationBuilder struct {
	details, changes, warnings []any
	valid                      bool
	names                      map[string]string
}

func (b *cardPresentationBuilder) warn(s string) {
	b.valid = false
	for _, x := range b.warnings {
		if x == s {
			return
		}
	}
	b.warnings = append(b.warnings, s)
}
func (b *cardPresentationBuilder) add(label string, value string) {
	if utf8.RuneCountInString(value) > 5000 || utf8.RuneCountInString(label) > 5000 {
		b.warn("展示内容超过长度限制，无法完整审阅。")
		return
	}
	if cardPresentationUUID.MatchString(value) || cardPresentationUUID.MatchString(label) {
		b.warn("存在无法以业务名称确认的内部标识，无法完整审阅。")
		return
	}
	if len(b.details)+len(b.changes) >= 100 {
		b.warn("展示项目超过数量限制，无法完整审阅。")
		return
	}
	b.details = append(b.details, Object{"label": label, "value": value})
}
func (b *cardPresentationBuilder) walk(label, key string, v any) {
	if cardPresentationMetadata[key] {
		return
	}
	switch x := v.(type) {
	case map[string]any:
		if len(x) == 0 {
			b.add(label, "无")
			return
		}
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if cardPresentationMetadata[k] {
				continue
			}
			n, ok := cardPresentationLabels[k]
			if !ok {
				b.warn("“" + label + "”包含未识别的业务字段，无法完整审阅。")
				continue
			}
			b.walk(label+" · "+n, k, x[k])
		}
	case []any:
		if len(x) == 0 {
			b.add(label, "无")
			return
		}
		for i, item := range x {
			b.walk(fmt.Sprintf("%s · 第%d项", label, i+1), key, item)
		}
	case nil:
		b.add(label, "未设置")
	case bool:
		if x {
			b.add(label, "是")
		} else {
			b.add(label, "否")
		}
	case float64:
		b.add(label, strconv.FormatFloat(x, 'f', -1, 64))
	case int:
		b.add(label, strconv.Itoa(x))
	case int64:
		b.add(label, strconv.FormatInt(x, 10))
	case json.Number:
		b.add(label, string(x))
	case string:
		named := false
		if cardPresentationUUID.MatchString(x) {
			if name, ok := b.names[x]; ok && (key == "" || key == "key" || key == "themeKey" || key == "resourceIds" || key == "accountIds" || key == "grantIds") && name != "" {
				x = name
				named = true
			} else {
				b.warn("“" + label + "”包含无法核对业务名称的内部标识。")
				return
			}
		}
		if (key == "key" || key == "themeKey") && !named {
			if n, ok := b.names[x]; ok && n != "" {
				x = n
			} else if n, ok := cardPresentationEnums[x]; ok {
				x = n
			} else {
				b.warn("“" + label + "”无法核对对应的业务名称。")
				return
			}
		} else if (key == "permissions" || key == "permission" || key == "actions") && cardPresentationPermissionNames[x] != "" {
			x = cardPresentationPermissionNames[x]
		} else if cardPresentationEnumFields[key] && !named {
			if n, ok := cardPresentationEnums[x]; ok {
				x = n
			} else {
				b.warn("“" + label + "”包含未识别的业务取值，无法完整审阅。")
				return
			}
		}
		b.add(label, x)
	default:
		b.warn("“" + label + "”包含无法翻译的内容。")
	}
}
func (b *cardPresentationBuilder) difference(label, key string, before, after any) {
	if reflect.DeepEqual(before, after) || cardPresentationMetadata[key] {
		return
	}
	if key == "algorithm" {
		b.warn("排序方式发生变化，无法完整审阅。")
		return
	}
	old, oldMap := before.(map[string]any)
	next, nextMap := after.(map[string]any)
	if oldMap || nextMap {
		keys := map[string]bool{}
		for k := range old {
			keys[k] = true
		}
		for k := range next {
			keys[k] = true
		}
		ordered := make([]string, 0, len(keys))
		for k := range keys {
			ordered = append(ordered, k)
		}
		sort.Strings(ordered)
		for _, k := range ordered {
			if reflect.DeepEqual(old[k], next[k]) {
				continue
			}
			if cardPresentationMetadata[k] {
				continue
			}
			name, ok := cardPresentationLabels[k]
			if !ok {
				b.warn("“" + label + "”包含未识别的业务字段，无法完整审阅。")
				continue
			}
			b.difference(label+" · "+name, k, old[k], next[k])
		}
		return
	}
	oldList, oldArray := before.([]any)
	nextList, nextArray := after.([]any)
	if oldArray || nextArray {
		if key == "strategies" && oldArray && nextArray {
			oldByID := map[string]any{}
			nextByID := map[string]any{}
			oldOrder := []string{}
			nextOrder := []string{}
			valid := true
			for _, v := range oldList {
				item, ok := v.(map[string]any)
				id, _ := item["id"].(string)
				if !ok || id == "" || oldByID[id] != nil {
					valid = false
					break
				}
				oldByID[id] = item
				oldOrder = append(oldOrder, id)
			}
			for _, v := range nextList {
				item, ok := v.(map[string]any)
				id, _ := item["id"].(string)
				if !ok || id == "" || nextByID[id] != nil {
					valid = false
					break
				}
				nextByID[id] = item
				nextOrder = append(nextOrder, id)
			}
			if !valid {
				b.warn("策略列表无法按原对象可靠对应，无法完整审阅。")
				return
			}
			all := map[string]bool{}
			for id := range oldByID {
				all[id] = true
			}
			for id := range nextByID {
				all[id] = true
			}
			ids := make([]string, 0, len(all))
			for id := range all {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			for _, id := range ids {
				name := b.names[id]
				if name == "" {
					item, _ := nextByID[id].(map[string]any)
					name, _ = item["name"].(string)
					if name == "" {
						item, _ = oldByID[id].(map[string]any)
						name, _ = item["name"].(string)
					}
				}
				if name == "" || cardPresentationUUID.MatchString(name) {
					b.warn("策略差异无法核对对应名称。")
					continue
				}
				b.difference(label+" · "+name, "", oldByID[id], nextByID[id])
			}
			if !reflect.DeepEqual(oldOrder, nextOrder) && len(oldOrder) == len(nextOrder) {
				oldNames := []string{}
				nextNames := []string{}
				missing := false
				for _, id := range oldOrder {
					if b.names[id] == "" {
						missing = true
					}
					oldNames = append(oldNames, b.names[id])
				}
				for _, id := range nextOrder {
					if b.names[id] == "" {
						missing = true
					}
					nextNames = append(nextNames, b.names[id])
				}
				if missing {
					b.warn("策略顺序无法核对对应名称。")
				} else {
					b.difference(label+" · 顺序", "", strings.Join(oldNames, "、"), strings.Join(nextNames, "、"))
				}
			}
			return
		}
		count := len(oldList)
		if len(nextList) > count {
			count = len(nextList)
		}
		for i := 0; i < count; i++ {
			var a, c any
			if i < len(oldList) {
				a = oldList[i]
			}
			if i < len(nextList) {
				c = nextList[i]
			}
			b.difference(fmt.Sprintf("%s · 第%d项", label, i+1), key, a, c)
		}
		return
	}
	scalar := func(v any) any {
		if v == nil {
			return nil
		}
		tmp := cardPresentationBuilder{valid: true, details: []any{}, changes: []any{}, warnings: []any{}, names: b.names}
		tmp.walk(label, key, v)
		if !tmp.valid || len(tmp.details) != 1 {
			for _, w := range tmp.warnings {
				b.warn(w.(string))
			}
			return nil
		}
		return tmp.details[0].(Object)["value"]
	}
	a, c := scalar(before), scalar(after)
	if before != nil && a == nil || after != nil && c == nil {
		return
	}
	if len(b.details)+len(b.changes) >= 100 {
		b.warn("展示项目超过数量限制，无法完整审阅。")
		return
	}
	b.changes = append(b.changes, Object{"label": label, "before": a, "after": c})
}

// Validate the entire frozen snapshots independently of how many unchanged fields are shown.
func cardPresentationPartial(before, after any) any {
	left, lok := before.(map[string]any)
	right, rok := after.(map[string]any)
	if !lok || !rok {
		return before
	}
	result := map[string]any{}
	for k, v := range right {
		if prior, ok := left[k]; ok {
			result[k] = cardPresentationPartial(prior, v)
		}
	}
	return result
}
func cardPresentation(p Object) Object {
	b := cardPresentationBuilder{details: []any{}, changes: []any{}, warnings: []any{}, valid: true, names: map[string]string{}}
	if names, ok := p["presentationNames"].(map[string]any); ok {
		for key, value := range names {
			if name, ok := value.(string); ok && name != "" && !cardPresentationUUID.MatchString(name) {
				b.names[key] = name
			}
		}
	}
	if names, ok := p["presentationNames"].(map[string]string); ok {
		for key, name := range names {
			if name != "" && !cardPresentationUUID.MatchString(name) {
				b.names[key] = name
			}
		}
	}
	title, _ := p["title"].(string)
	title = strings.TrimSpace(title)
	if title == "" {
		title = "待确认操作"
		b.warn("缺少操作标题，无法完整审阅。")
	}
	if cardPresentationUUID.MatchString(title) || utf8.RuneCountInString(title) > 5000 {
		title = "待确认操作"
		b.warn("操作标题无法安全展示。")
	}
	target, _ := p["target"].(map[string]any)
	if target != nil {
		if name, ok := target["label"].(string); ok && name != "" {
			b.add("目标", name)
		}
	}
	kind, _ := p["kind"].(string)
	if kind == "ai-work-prompt-save" {
		b.add("审阅方式", "请在专用岗位要求审阅区核对完整正文。")
		return Object{"summary": title, "changes": b.changes, "details": b.details, "warnings": b.warnings, "reviewable": b.valid}
	}
	// Chunks from preparation are reassembled only when every part is present in order.
	impacts, ok := p["impact"].([]any)
	if !ok && p["impact"] != nil {
		b.warn("操作影响格式不完整。")
	}
	// Resolve only strategy identifiers that have an unambiguous name in the same frozen snapshots.
	namesSeen := map[string]string{}
	ambiguous := map[string]bool{}
	for i := 0; i < len(impacts); i++ {
		line, ok := impacts[i].(string)
		if kind == "ai-role-command" && ok {
			line = cardPresentationPermissionToken.ReplaceAllStringFunc(line, func(code string) string {
				if label := cardPresentationPermissionNames[code]; label != "" {
					return label
				}
				return code
			})
		}
		if !ok {
			continue
		}
		m := cardPresentationChunk.FindStringSubmatch(line)
		if m == nil || m[2] != "1" || (m[1] != "变更前完整配置" && m[1] != "变更后完整配置") {
			continue
		}
		total, _ := strconv.Atoi(m[3])
		if total < 1 || total > 100 || i+total > len(impacts) {
			continue
		}
		var raw strings.Builder
		complete := true
		for n := 0; n < total; n++ {
			piece, ok := impacts[i+n].(string)
			if !ok {
				complete = false
				break
			}
			part := cardPresentationChunk.FindStringSubmatch(piece)
			if part == nil || part[1] != m[1] || part[2] != strconv.Itoa(n+1) || part[3] != m[3] {
				complete = false
				break
			}
			raw.WriteString(part[4])
		}
		if !complete {
			continue
		}
		var snapshot map[string]any
		if json.Unmarshal([]byte(raw.String()), &snapshot) != nil {
			continue
		}
		strategies, _ := snapshot["strategies"].([]any)
		for _, v := range strategies {
			item, _ := v.(map[string]any)
			id, _ := item["id"].(string)
			name, _ := item["name"].(string)
			if id == "" || name == "" || cardPresentationUUID.MatchString(name) {
				continue
			}
			if old, ok := namesSeen[name]; ok && old != id {
				ambiguous[name] = true
			}
			namesSeen[name] = id
			if old, ok := b.names[id]; ok && old != name {
				delete(b.names, id)
			} else {
				b.names[id] = name
			}
		}
	}
	for name := range ambiguous {
		for id, value := range b.names {
			if value == name {
				delete(b.names, id)
			}
		}
	}
	chunks := map[string]any{}
	pairedLabels := map[string]bool{"变更前完整配置": true, "变更后完整配置": true, "当前设置": true, "目标设置": true, "当前策略": true, "目标开关与控制": true, "当前主题": true, "目标主题": true}
	hasStrategyPair := false
	for _, v := range impacts {
		if line, ok := v.(string); ok && strings.HasPrefix(line, "变更前完整配置（1/") {
			hasStrategyPair = true
			break
		}
	}
	if len(impacts) == 0 {
		b.warn("缺少具体操作影响，无法完整审阅。")
	}
	for i := 0; i < len(impacts); i++ {
		line, ok := impacts[i].(string)
		if !ok {
			b.warn("操作影响格式无法识别。")
			continue
		}
		m := cardPresentationChunk.FindStringSubmatch(line)
		if m != nil {
			index, _ := strconv.Atoi(m[2])
			total, _ := strconv.Atoi(m[3])
			label := m[1]
			if index != 1 || total < 1 || total > 100 || i+total > len(impacts) {
				b.warn("操作内容分块不完整，无法完整审阅。")
				continue
			}
			var raw strings.Builder
			complete := true
			for n := 0; n < total; n++ {
				part, ok := impacts[i+n].(string)
				if !ok {
					complete = false
					break
				}
				v := cardPresentationChunk.FindStringSubmatch(part)
				if v == nil || v[1] != label || v[2] != strconv.Itoa(n+1) || v[3] != strconv.Itoa(total) {
					complete = false
					break
				}
				raw.WriteString(v[4])
			}
			if !complete {
				b.warn("操作内容分块不完整，无法完整审阅。")
				continue
			}
			i += total - 1
			var value any
			if json.Unmarshal([]byte(raw.String()), &value) != nil {
				b.warn("操作内容无法完整解析，无法完整审阅。")
				continue
			}
			if label == "保留全部主题方向" {
				b.add("其他主题", "保持现有展示方向。")
				continue
			}
			if pairedLabels[label] {
				if _, duplicate := chunks[label]; duplicate {
					b.warn("配置内容存在重复分块，无法完整审阅。")
				} else {
					chunks[label] = value
				}
				continue
			}
			field := ""
			parts := strings.Fields(label)
			if len(parts) > 1 {
				candidate := parts[len(parts)-1]
				if n, exists := cardPresentationLabels[candidate]; exists {
					field = candidate
					label = strings.TrimSuffix(label, candidate) + n
				} else {
					b.warn("该操作内容包含未识别的业务字段，无法完整审阅。")
					continue
				}
			}
			b.walk(label, field, value)
			continue
		}
		// Diff lines may contain serialized objects; translate both sides, never expose JSON.
		if colon := strings.Index(line, "："); colon >= 0 {
			rest := line[colon+len("："):]
			if parts := strings.SplitN(rest, " → ", 2); len(parts) == 2 {
				var a, c any
				if json.Unmarshal([]byte(parts[0]), &a) == nil && json.Unmarshal([]byte(parts[1]), &c) == nil {
					if hasStrategyPair {
						continue
					}
					label := line[:colon]
					if cardPresentationUUID.MatchString(label) {
						label = cardPresentationUUID.ReplaceAllStringFunc(label, func(id string) string { return b.names[id] })
						if strings.Contains(label, "策略  增删") || strings.Contains(label, "策略  ") {
							b.warn("策略差异包含无法核对名称的内部标识。")
							continue
						}
					}
					fields := strings.Fields(label)
					if len(fields) > 0 {
						last := fields[len(fields)-1]
						if name, ok := cardPresentationLabels[last]; ok {
							label = strings.TrimSuffix(label, last) + name
						} else if name, ok := cardPresentationEnums[last]; ok {
							label = strings.TrimSuffix(label, last) + name
						}
					}
					if cardPresentationInternalLabel.MatchString(label) {
						b.warn("操作差异包含无法核对的业务名称。")
						continue
					}
					b.difference(label, "", a, c)
					continue
				}
			}
		}
		if strings.ContainsAny(line, "{}[]") {
			b.warn("操作影响包含无法完整翻译的结构化内容。")
			continue
		}
		b.add("影响", line)
	}
	for _, pair := range []struct {
		before, after, label string
		partial              bool
	}{
		{"变更前完整配置", "变更后完整配置", "策略配置", false},
		{"当前设置", "目标设置", "搜索设置", false},
		{"当前策略", "目标开关与控制", "推荐策略", true},
		{"当前主题", "目标主题", "推荐主题", true},
	} {
		before, hasBefore := chunks[pair.before]
		after, hasAfter := chunks[pair.after]
		if !hasBefore && !hasAfter {
			continue
		}
		if !hasBefore || !hasAfter {
			b.warn("“" + pair.label + "”缺少完整的变更前后内容。")
			continue
		}
		compare := before
		if pair.partial {
			compare = cardPresentationPartial(before, after)
		}
		b.difference(pair.label, "", compare, after)
		if settings, ok := after.(map[string]any); ok {
			if fixed, exists := settings["fixedConstraints"]; exists {
				b.walk(pair.label+" · 固定约束", "fixedConstraints", fixed)
			}
			if _, exists := settings["algorithm"]; exists {
				b.add(pair.label+" · 排序方式", "固定排序方式")
			}
		}
	}
	bases, ok := p["basis"].([]any)
	if !ok && p["basis"] != nil {
		b.warn("操作依据格式不完整。")
	}
	for _, item := range bases {
		x, ok := item.(map[string]any)
		if !ok {
			b.warn("操作依据格式无法识别。")
			continue
		}
		label, _ := x["label"].(string)
		if label == "" {
			b.warn("操作依据缺少名称。")
			continue
		}
		if strings.Contains(label, "版本") || strings.Contains(label, "ID") || strings.Contains(label, "编号") {
			continue
		}
		b.walk(label, "", x["value"])
	}
	return Object{"summary": title, "changes": b.changes, "details": b.details, "warnings": b.warnings, "reviewable": b.valid}
}
