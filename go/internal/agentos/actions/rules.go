package actions

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"strings"
)

var ruleNames = map[string]string{"resource-budget": "资源额度", "community-quota": "参与额度", "forum-quota": "论坛额度", "business-controls": "业务规则与名单"}

func (s *Service) rules(a Actor) (*operationsrules.Service, error) {
	if s.Rules == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	return s.Rules.WithAuthority(s.authority(a)), nil
}
func (s *Service) prepareRule(ctx context.Context, a Actor, x Object, p *preparation) error {
	source, e := s.rules(a)
	if e != nil {
		return e
	}
	key := str(x["key"])
	item, e := source.Get(ctx, a, key)
	if e != nil {
		return e
	}
	p.expiry(item["readExpiresAt"])
	cap := obj(item["capabilities"])["canPublish"]
	if x["kind"] == "rule-restore" {
		cap = obj(item["capabilities"])["canRestore"]
	}
	if e = capability(cap); e != nil {
		return e
	}
	scope, e := s.Permissions.AIWorkContext(a)
	if s.isDuty(a) {
		scope, e = s.Permissions.Duty.DutyMetadata(a)
	}
	if e != nil {
		return e
	}
	if _, e = s.human(ctx, a, str(scope["domain"]), "rules.write", "prepare", nil); e != nil {
		return e
	}
	version := obj(item["draft"])
	if x["kind"] == "rule-restore" {
		version = nil
		if obj(item["active"])["id"] == x["versionId"] {
			version = obj(item["active"])
		}
		after := ""
		complete := false
		for page := 0; version == nil && page < 5; page++ {
			query := Object{"limit": 50}
			if after != "" {
				query["after"] = after
			}
			history, e := source.Versions(ctx, a, key, query)
			if e != nil {
				return e
			}
			p.expiry(history["readExpiresAt"])
			for _, v := range items(history["items"]) {
				if obj(obj(v)["version"])["id"] == x["versionId"] {
					version = obj(obj(v)["version"])
					break
				}
			}
			if version == nil && obj(history["baseline"])["id"] == x["versionId"] {
				version = obj(history["baseline"])
			}
			next := str(history["nextAfter"])
			if next == "" {
				complete = true
				break
			}
			if next == after {
				return fail("operations_agentos_rule_review_required", 409)
			}
			after = next
		}
		if version == nil {
			if complete {
				return fail("operations_rule_version_unavailable", 404)
			}
			return fail("operations_agentos_rule_review_required", 409)
		}
		if n, ok := integer(version["publishedVersion"]); !ok || n < 1 {
			return fail("operations_rule_version_not_published", 409)
		}
	}
	if version == nil || version["key"] != key {
		return fail("operations_rule_draft_changed", 409)
	}
	names := map[string]string{}
	accountName := func(id string) (string, error) {
		if name, ok := names[id]; ok {
			return name, nil
		}
		if len(names) >= 100 {
			return "", fail("operations_agentos_rule_review_required", 409)
		}
		accounts, e := s.accounts(a)
		if e != nil {
			return "", e
		}
		current, e := accounts.Get(ctx, a, id)
		if e != nil {
			return "", e
		}
		p.expiry(current["readExpiresAt"])
		account := obj(current["account"])
		name, uid := label(account["displayName"], ""), label(account["uid"], "")
		if name == "" && uid == "" {
			return "", fail("operations_agentos_rule_review_required", 409)
		}
		value := name
		if name == "" {
			value = "UID " + uid
		} else if uid != "" && uid != name {
			value = name + "（UID " + uid + "）"
		}
		names[id] = value
		return value, nil
	}
	changes, e := ruleDifference(key, obj(obj(item["active"])["policy"]), obj(version["policy"]), obj(item["catalog"]), accountName)
	if e != nil {
		return e
	}
	p.target = Object{"kind": "rule", "id": key, "label": ruleNames[key], "href": "/admin/operations/rules?key=" + key + "&version=" + str(version["id"])}
	p.title = "发布这份" + ruleNames[key] + "草稿"
	versionLabel, versionValue := "已保存草稿", fmt.Sprintf("管理版本 %d", num(version["version"]))
	if x["kind"] == "rule-restore" {
		p.title = "恢复这份" + ruleNames[key] + "历史内容"
		versionLabel, versionValue = "目标历史内容", fmt.Sprintf("发布版本 %d", num(version["publishedVersion"]))
	}
	p.command = Object{"expectedRevision": item["revision"], "versionId": version["id"], "reason": x["reason"]}
	p.basis = []any{basis("当前发布", fmt.Sprintf("发布版本 %d", num(obj(item["active"])["publishedVersion"]))), basis(versionLabel, versionValue)}
	for _, line := range changes {
		p.impact = append(p.impact, line)
	}
	if len(changes) == 0 {
		p.impact = append(p.impact, "内容与当前发布相同，将记录为新的发布版本。")
	}
	impact := "后续操作按新的额度和规则检查，已经发生的操作不撤销。"
	if key == "business-controls" {
		impact = "只影响之后对应的新操作；既有内容不会被追溯处置。"
	}
	adoption := "各运行组件更新后采用，实际采用状态可在规则页查看。"
	if obj(item["adoption"])["mode"] == "current-transaction" {
		adoption = "后续对应操作会读取当前发布规则。"
	}
	p.impact = append(p.impact, impact, adoption, "变更说明："+str(x["reason"]))
	length := 0
	for _, line := range p.impact {
		n := jsLength(str(line))
		length += n
		if n > 5000 {
			return fail("operations_agentos_rule_review_required", 409)
		}
	}
	if length > 20000 {
		return fail("operations_agentos_rule_review_required", 409)
	}
	return nil
}
func ruleDifference(key string, before, after, catalog Object, accountName func(string) (string, error)) ([]string, error) {
	old, e := operationsrules.ParsePolicy(key, before)
	if e != nil {
		return nil, e
	}
	next, e := operationsrules.ParsePolicy(key, after)
	if e != nil {
		return nil, e
	}
	lines := []string{}
	total := 0
	add := func(line string) error {
		lines = append(lines, line)
		total += jsLength(line)
		if jsLength(line) > 5000 || len(lines) > 80 || total > 20000 {
			return fail("operations_agentos_rule_review_required", 409)
		}
		return nil
	}
	show := func(v any) string {
		if n, ok := integer(v); ok {
			return grouped(n)
		}
		if v == nil {
			return "null"
		}
		return fmt.Sprint(v)
	}
	enabled := func(v any) string {
		if v == true {
			return "启用"
		}
		return "停用"
	}
	if key != "business-controls" {
		fields := map[string][]string{"resource-budget": {"maxPayloadBytesPerSubject", "maxQueuedJobsPerSubject", "maxActiveExportsPerSubject", "maxActiveJobsGlobal", "maxActiveJobsPerSubject"}, "community-quota": {"new", "normal", "promotionDays", "invitationCooldownDays"}, "forum-quota": {"new", "normal", "maxPermissionSeconds", "maxGovernanceHideSeconds", "accountForumMaxBytes", "maxTitleCodePoints", "maxBodyCodePoints", "maxReplyCodePoints", "maxReportCodePoints", "maxLinks", "maxLinkCodePoints", "maxPayloadBytes", "maxAppeals", "maxReportEvents", "dailyUsageDays", "auditDays"}}[key]
		labels := map[string][2]string{"maxPayloadBytesPerSubject": {"单主体数据存储上限", "字节"}, "maxQueuedJobsPerSubject": {"单主体排队任务上限", "项"}, "maxActiveExportsPerSubject": {"单主体有效导出上限", "项"}, "maxActiveJobsGlobal": {"全服务并行任务", "项"}, "maxActiveJobsPerSubject": {"单主体并行任务", "项"}, "promotionDays": {"转为普通账户所需时间", "天"}, "invitationCooldownDays": {"邀请冷却时间", "天"}, "maxPermissionSeconds": {"内容授权最长时间", "秒"}, "maxGovernanceHideSeconds": {"治理隐藏最长时间", "秒"}, "dailyUsageDays": {"用量记录保留时间", "天"}, "auditDays": {"社区审计保留时间", "天"}, "accountForumMaxBytes": {"单账户社区数据上限", "字节"}, "maxTitleCodePoints": {"标题上限", "字"}, "maxBodyCodePoints": {"帖子上限", "字"}, "maxReplyCodePoints": {"回复上限", "字"}, "maxReportCodePoints": {"举报说明上限", "字"}, "maxLinks": {"链接数量上限", "个"}, "maxLinkCodePoints": {"单链接长度上限", "字"}, "maxPayloadBytes": {"单次内容上限", "字节"}, "maxAppeals": {"每案申诉上限", "次"}, "maxReportEvents": {"每案处理记录上限", "条"}}
		for _, field := range fields {
			if same(old[field], next[field]) {
				continue
			}
			if field == "new" || field == "normal" {
				kinds := []string{"task", "comment", "invitation"}
				if key == "forum-quota" {
					kinds = []string{"post", "version", "reply", "report"}
				}
				for _, kind := range kinds {
					if same(obj(old[field])[kind], obj(next[field])[kind]) {
						continue
					}
					who := "新账户"
					if field == "normal" {
						who = "普通账户"
					}
					name := map[string]string{"task": "任务", "comment": "评论", "invitation": "邀请", "post": "发帖", "version": "帖子修订", "reply": "回复", "report": "举报"}[kind]
					if e = add(who + "每日" + name + "额度：" + show(obj(old[field])[kind]) + " 次改为 " + show(obj(next[field])[kind]) + " 次"); e != nil {
						return nil, e
					}
				}
			} else {
				label, ok := labels[field]
				if !ok {
					return nil, fail("operations_agentos_rule_review_required", 409)
				}
				if e = add(label[0] + "：" + show(old[field]) + " " + label[1] + "改为 " + show(next[field]) + " " + label[1]); e != nil {
					return nil, e
				}
			}
		}
		return lines, nil
	}
	named := func(values any, key, value string) string {
		for _, v := range items(values) {
			if obj(v)[key] == value {
				return str(obj(v)["label"])
			}
		}
		return ""
	}
	for _, v := range items(catalog["features"]) {
		feature := str(obj(v)["key"])
		value := obj(next["features"])[feature]
		if same(obj(old["features"])[feature], value) {
			continue
		}
		name := named(catalog["features"], "key", feature)
		if name == "" {
			return nil, fail("operations_agentos_rule_review_required", 409)
		}
		if e = add("功能「" + name + "」：" + enabled(obj(old["features"])[feature]) + "改为" + enabled(value)); e != nil {
			return nil, e
		}
	}
	find := func(values any, id string) Object {
		for _, v := range items(values) {
			if obj(v)["id"] == id {
				return obj(v)
			}
		}
		return nil
	}
	ids := func(a, b any) []string {
		out := []string{}
		seen := map[string]bool{}
		for _, values := range []any{a, b} {
			for _, v := range items(values) {
				id := str(obj(v)["id"])
				if !seen[id] {
					seen[id] = true
					out = append(out, id)
				}
			}
		}
		return out
	}
	changed := map[string]bool{}
	listDescription := func(item Object) string {
		kind := "词条名单"
		if item["kind"] == "domain" {
			kind = "域名名单"
		}
		entries := []string{}
		for _, v := range items(item["entries"]) {
			entries = append(entries, "「"+str(v)+"」")
		}
		text := strings.Join(entries, "、")
		if len(entries) == 0 {
			text = "无"
		}
		return kind + "「" + str(item["name"]) + "」（" + enabled(item["enabled"]) + "）；条目：" + text
	}
	for _, id := range ids(old["lists"], next["lists"]) {
		a, b := find(old["lists"], id), find(next["lists"], id)
		if same(a, b) {
			continue
		}
		changed[id] = true
		if a != nil {
			prefix := "原名单："
			if b == nil {
				prefix = "移除名单："
			}
			if e = add(prefix + listDescription(a)); e != nil {
				return nil, e
			}
		}
		if b != nil {
			prefix := "改为名单："
			if a == nil {
				prefix = "新增名单："
			}
			if e = add(prefix + listDescription(b)); e != nil {
				return nil, e
			}
		}
	}
	var condition func(Object, Object) (string, error)
	condition = func(node, policy Object) (string, error) {
		if rules, ok := node["rules"]; ok {
			parts := []string{}
			for _, v := range items(rules) {
				text, e := condition(obj(v), policy)
				if e != nil {
					return "", e
				}
				parts = append(parts, text)
			}
			prefix := "同时满足"
			if node["combinator"] == "or" {
				prefix = "满足任一条件"
			}
			return prefix + "（" + strings.Join(parts, "；") + "）", nil
		}
		var field Object
		for _, v := range items(catalog["fields"]) {
			if obj(v)["name"] == node["field"] {
				field = obj(v)
				break
			}
		}
		operator := named(field["operators"], "name", str(node["operator"]))
		if field == nil || operator == "" {
			return "", fail("operations_agentos_rule_review_required", 409)
		}
		value := ""
		if node["field"] == "keywordList" || node["field"] == "domainList" {
			list := find(policy["lists"], str(node["value"]))
			if list == nil {
				return "", fail("operations_agentos_rule_review_required", 409)
			}
			value = str(list["name"])
		} else {
			value = named(field["values"], "name", str(node["value"]))
			if value == "" {
				value = show(node["value"])
			}
		}
		return str(field["label"]) + " " + operator + " " + value, nil
	}
	describe := func(rule, policy Object) (string, error) {
		targets := []string{}
		for _, v := range items(rule["targets"]) {
			name := named(catalog["targets"], "key", str(v))
			if name == "" {
				return "", fail("operations_agentos_rule_review_required", 409)
			}
			targets = append(targets, name)
		}
		exceptions := []string{}
		for _, v := range items(rule["exceptions"]) {
			exception := obj(v)
			people := []string{}
			for _, id := range items(exception["accountIds"]) {
				name, e := accountName(str(id))
				if e != nil {
					return "", e
				}
				people = append(people, name)
			}
			exceptions = append(exceptions, "「"+str(exception["name"])+"」（"+enabled(exception["enabled"])+"）："+strings.Join(people, "、"))
		}
		text, e := condition(obj(rule["conditions"]), policy)
		if e != nil {
			return "", e
		}
		exceptionText := strings.Join(exceptions, "；")
		if len(exceptions) == 0 {
			exceptionText = "无"
		}
		return "「" + str(rule["name"]) + "」（" + enabled(rule["enabled"]) + "）；适用" + strings.Join(targets, "、") + "；" + text + "；命中后停止本次新操作；例外：" + exceptionText, nil
	}
	var references func(Object) bool
	references = func(node Object) bool {
		if rules, ok := node["rules"]; ok {
			for _, v := range items(rules) {
				if references(obj(v)) {
					return true
				}
			}
			return false
		}
		return changed[str(node["value"])]
	}
	for _, id := range ids(old["rules"], next["rules"]) {
		a, b := find(old["rules"], id), find(next["rules"], id)
		if same(a, b) && !references(obj(a["conditions"])) && !references(obj(b["conditions"])) {
			continue
		}
		if a != nil {
			text, err := describe(a, old)
			if err != nil {
				return nil, err
			}
			prefix := "原规则："
			if b == nil {
				prefix = "移除规则："
			}
			if e = add(prefix + text); e != nil {
				return nil, e
			}
		}
		if b != nil {
			text, err := describe(b, next)
			if err != nil {
				return nil, err
			}
			prefix := "改为规则："
			if a == nil {
				prefix = "新增规则："
			}
			if e = add(prefix + text); e != nil {
				return nil, e
			}
		}
	}
	return lines, nil
}
