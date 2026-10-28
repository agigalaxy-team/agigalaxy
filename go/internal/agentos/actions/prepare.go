package actions

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

type preparation struct {
	target, command Object
	title           string
	impact          []any
	basis           []any
	expires         int64
}

func (p *preparation) expiry(v any) {
	if n, ok := integer(v); ok && n < p.expires {
		p.expires = n
	}
}
func (s *Service) deadline(until, maximum, source any) (string, error) {
	u, ok := integer(until)
	m, valid := integer(maximum)
	if !ok || !valid || u <= s.now() || u > s.now()+m {
		return "", fail("operations_hide_expiry", 409)
	}
	if source != nil {
		n, ok := integer(source)
		if !ok || u > n {
			return "", fail("operations_hide_expiry", 409)
		}
	}
	return time.Unix(u, 0).UTC().Format("2006-01-02T15:04:05.000Z"), nil
}
func basis(k string, v any) Object { return Object{"label": k, "value": v} }
func (s *Service) Prepare(ctx context.Context, a Actor, domain string, input Object, operationID string) (Object, error) {
	return s.PrepareWithReference(ctx, a, domain, input, operationID, nil)
}
func (s *Service) PrepareWithReference(ctx context.Context, a Actor, domain string, input Object, operationID string, reference Object) (Object, error) {
	if slices.Contains([]string{"ai-role-command", "ai-work-prompt-save"}, str(input["kind"])) {
		if reference != nil {
			return nil, invalid()
		}
		return s.Permissions.PrepareManagementAction(ctx, a, domain, input, operationID)
	}
	x, e := ParseRequest(input)
	if e != nil {
		return nil, e
	}
	kind := str(x["kind"])
	if reference != nil && !slices.Contains([]string{"content-visibility", "content-curation"}, kind) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	read, e := CardReadPermission(kind)
	if e != nil {
		return nil, e
	}
	actor, e := s.human(ctx, a, domain, "workbench.read", "prepare", nil)
	if e != nil {
		return nil, e
	}
	actor, e = s.human(ctx, actor, domain, read, "prepare", nil)
	if e != nil {
		return nil, e
	}
	p := preparation{impact: []any{}, basis: []any{}, expires: s.now() + 30}
	switch kind {
	case "ordinary-strategy-draft", "ordinary-strategy-publish", "strategy-control", "strategy-continue":
		e = s.prepareStrategy(ctx, actor, x, &p)
	case "rule-publish", "rule-restore":
		e = s.prepareRule(ctx, actor, x, &p)
	case "search-apply", "search-restore", "recommendation-direction":
		e = s.prepareDiscovery(ctx, actor, x, &p)
	case "job-cancel", "job-retry", "search-retry":
		e = s.prepareJobs(ctx, actor, x, &p)
	case "content-visibility", "content-curation", "public-content-batch":
		e = s.prepareContent(ctx, actor, x, reference, &p)
	case "file-scan-retry", "file-access", "file-cleanup-approve":
		e = s.prepareFile(ctx, actor, x, &p)
	case "section-classification", "section-visibility", "resource-visibility", "case-resolve":
		e = s.prepareCommunity(ctx, actor, x, &p)
	case "private-case-message":
		e = s.preparePrivateMessage(ctx, actor, x, &p)
	case "account-restriction":
		e = s.prepareAccount(ctx, actor, x, &p)
	case "message-draft-create", "message-draft-save", "messaging-state":
		e = s.prepareMessaging(ctx, actor, x, operationID, &p)
	case "feedback-update":
		e = s.prepareFeedback(ctx, actor, x, &p)
	default:
		e = fail("operations_agentos_action_not_connected", 503)
	}
	if e != nil {
		return nil, e
	}
	permission := required(x)
	if _, e = s.human(ctx, actor, domain, permission, "prepare", nil); e != nil {
		return nil, e
	}
	if p.expires <= s.now() {
		return nil, fail("operations_source_unavailable", 409)
	}
	out := Object{"schemaVersion": 1, "kind": kind, "domain": domain, "request": x, "command": p.command, "target": p.target, "title": p.title, "impact": p.impact, "basis": p.basis, "requiredAction": permission, "checkedAt": s.now(), "readExpiresAt": p.expires, "decisionSource": "human-required"}
	if reference != nil {
		out["publicReference"] = clone(reference)
	}
	return out, nil
}
func (s *Service) prepareContent(ctx context.Context, a Actor, x, reference Object, p *preparation) error {
	service, e := s.content(a)
	if e != nil {
		return e
	}
	kind := str(x["kind"])
	if kind == "public-content-batch" {
		selected := []any{}
		for _, v := range items(x["items"]) {
			r := obj(v)
			response, e := service.Content(ctx, a, str(r["kind"]), str(r["id"]), Object{})
			if e != nil {
				return e
			}
			item := obj(response["content"])
			cap := obj(item["capabilities"])["canBatchRestore"]
			if x["action"] == "hide" {
				cap = obj(item["capabilities"])["canBatchHide"]
			}
			if e = capability(cap); e != nil {
				return e
			}
			selected = append(selected, Object{"kind": r["kind"], "id": r["id"], "expectedVersion": item["version"], "expectedRevision": obj(item["visibility"])["version"]})
			p.expiry(item["publishedUntil"])
		}
		previewInput := Object{"kind": x["action"], "items": selected}
		if v, ok := x["until"]; ok {
			previewInput["until"] = v
		}
		preview, e := service.Preview(ctx, a, previewInput)
		if e != nil {
			return e
		}
		if int64(len(selected)) > num(preview["maximumItems"]) {
			return fail("operations_agentos_human_review_required", 409)
		}
		for _, v := range items(preview["items"]) {
			if obj(v)["eligible"] != true {
				return fail("operations_agentos_human_review_required", 409)
			}
		}
		p.target = Object{"kind": "content-batch", "id": obj(selected[0])["id"], "label": fmt.Sprintf("明确选定的 %d 项公开内容", len(selected)), "href": "/admin/operations/community?tab=posts"}
		verb := "恢复"
		if x["action"] == "hide" {
			verb = "下架"
		}
		p.title = "批量" + verb + "明确选定的公开内容"
		p.command = clone(previewInput)
		p.command["reason"] = x["reason"]
		p.basis = []any{basis("明确影响范围", fmt.Sprintf("%d 项已选当前公开来源", len(selected)))}
		p.impact = []any{"逐项核对原版本和运营覆盖版本，未满足条件的对象保留拒绝原因。"}
		return nil
	}
	response, e := service.Content(ctx, a, str(x["targetKind"]), str(x["targetId"]), Object{})
	if e != nil {
		return e
	}
	item := obj(response["content"])
	if item["sourceState"] != "available" {
		return fail("operations_source_unavailable", 409)
	}
	if reference != nil {
		required := []string{"kind", "id"}
		optional := []string{}
		if reference["kind"] == "post" {
			optional = append(optional, "versionId")
		}
		if !exact(reference, required, optional) || reference["kind"] != x["targetKind"] || reference["id"] != x["targetId"] || !validID(reference["id"]) {
			return fail("invalid_operations_agentos_request", 400)
		}
		if id, ok := reference["versionId"]; ok {
			if !validID(id) {
				return fail("invalid_operations_agentos_request", 400)
			}
			if item["versionId"] != id {
				return fail("operations_agentos_source_changed", 409)
			}
		}
	}
	p.expiry(item["publishedUntil"])
	fallback, name := "公开回复", "回复"
	if x["targetKind"] == "post" {
		fallback, name = "公开帖子", "帖子"
	}
	p.target = Object{"kind": x["targetKind"], "id": x["targetId"], "label": label(item["title"], fallback), "href": "/admin/operations/community?tab=posts&contentKind=" + str(x["targetKind"]) + "&id=" + str(x["targetId"])}
	display := "正常展示"
	if obj(item["visibility"])["hidden"] == true {
		display = "已隐藏"
	}
	p.basis = []any{basis("来源", "当前可公开读取的"+name), basis("当前展示", display)}
	if kind == "content-visibility" {
		cap := obj(item["capabilities"])["canRestore"]
		if x["action"] == "hide" {
			cap = obj(item["capabilities"])["canHide"]
		}
		if e = capability(cap); e != nil {
			return e
		}
		p.title = "恢复这条公开内容"
		p.impact = []any{"解除这次运营下架。作者已撤回、已到期或没有阅读权限的内容仍不展示。"}
		if x["action"] == "hide" {
			deadline, e := s.deadline(x["until"], item["maxHideSeconds"], item["publishedUntil"])
			if e != nil {
				return e
			}
			p.title = "下架这条公开内容"
			p.impact = []any{"停止该内容的公开展示，截止 " + deadline}
		}
		p.command = Object{"kind": x["action"], "expectedVersion": item["version"], "expectedRevision": obj(item["visibility"])["version"], "reason": x["reason"]}
		if v, ok := x["until"]; ok {
			p.command["until"] = v
		}
		return nil
	}
	if e = capability(obj(item["capabilities"])["canCurate"]); e != nil {
		return e
	}
	p.title = "调整这条内容的分类与编排"
	p.command = pick(x, "topic", "pinned", "featured", "tagIds", "reason")
	p.command["expectedVersion"], p.command["expectedRevision"] = item["version"], obj(item["curation"])["revision"]
	if v, ok := x["topic"]; ok {
		name := category(str(v))
		if v == nil {
			name = "恢复来源分类"
		}
		p.impact = append(p.impact, "分类："+name)
	}
	for _, key := range []string{"pinned", "featured"} {
		if v, ok := x[key]; ok {
			title := map[string]string{"pinned": "置顶：", "featured": "精选："}[key]
			choice := "否"
			if v == true {
				choice = "是"
			}
			p.impact = append(p.impact, title+choice)
		}
	}
	if ids, ok := x["tagIds"]; ok {
		tags, e := service.Tags(ctx, a)
		if e != nil {
			return e
		}
		names := []string{}
		for _, id := range items(ids) {
			found := false
			for _, v := range items(tags["items"]) {
				tag := obj(v)
				if tag["id"] == id && tag["enabled"] == true {
					found = true
					names = append(names, label(tag["name"], "标签"))
					break
				}
			}
			if !found {
				return fail("operations_tag_unavailable", 409)
			}
		}
		value := strings.Join(names, "、")
		if len(names) == 0 {
			value = "清除运营标签"
		}
		p.impact = append(p.impact, "标签："+value)
	}
	return nil
}
func grouped(n int64) string {
	s := strconv.FormatInt(n, 10)
	for at := len(s) - 3; at > 0; at -= 3 {
		s = s[:at] + "," + s[at:]
	}
	return s
}
func (s *Service) prepareFile(ctx context.Context, a Actor, x Object, p *preparation) error {
	service, e := s.files(a)
	if e != nil {
		return e
	}
	kind := str(x["kind"])
	if kind == "file-cleanup-approve" {
		plan, e := service.CleanupPlan(ctx, a, str(x["planId"]))
		if e != nil {
			return e
		}
		p.expiry(plan["readExpiresAt"])
		if e = capability(plan["state"] == "awaiting-approval" && obj(plan["permissions"])["canApprove"] == true); e != nil {
			return e
		}
		rows := items(plan["items"])
		if plan["id"] != x["planId"] || num(plan["revision"]) < 1 || rows == nil || len(rows) < 1 || len(rows) > 50 || num(plan["itemCount"]) != int64(len(rows)) {
			return fail("operations_agentos_cleanup_review_required", 409)
		}
		total := int64(0)
		seen := map[string]bool{}
		p.impact = []any{fmt.Sprintf("清除以下 %d 份文件在服务器上的副本，无法从此处恢复。", len(rows))}
		for i, v := range rows {
			r := obj(v)
			key := str(r["kind"]) + ":" + str(r["id"])
			size, ok := integer(r["size"])
			if !slices.Contains([]string{"chat", "forum"}, str(r["kind"])) || !validID(r["id"]) || seen[key] || !ok || !slices.Contains([]string{"expired", "unreferenced"}, str(r["reason"])) || r["state"] != "pending" {
				return fail("operations_agentos_cleanup_review_required", 409)
			}
			seen[key] = true
			total += size
			if total > 9007199254740991 {
				return fail("operations_agentos_cleanup_review_required", 409)
			}
			name := "社区附件"
			if r["kind"] == "chat" {
				name = "私聊附件"
			}
			reason := "已无有效来源引用"
			if r["reason"] == "expired" {
				reason = "既有期限已到"
			}
			active, refs := "未确认", "未确认"
			if n, ok := integer(r["activeReferences"]); ok {
				active = strconv.FormatInt(n, 10)
			}
			if n, ok := integer(r["referenceCount"]); ok {
				refs = strconv.FormatInt(n, 10)
			}
			expires := "未记录"
			if t, e := time.Parse(time.RFC3339Nano, str(r["expiresAt"])); e == nil {
				expires = t.UTC().Format("2006-01-02T15:04:05.000Z")
			}
			p.impact = append(p.impact, fmt.Sprintf("%d. %s · %s · 声明大小 %s 字节 · %s · 制定时有效引用 %s / 总引用 %s · 既有到期时间 %s", i+1, label(r["name"], "未命名"+name), name, grouped(size), reason, active, refs, expires))
		}
		if total != num(plan["declaredBytes"]) {
			return fail("operations_agentos_cleanup_review_required", 409)
		}
		p.impact = append(p.impact, "只处理这份已列明的计划，不包含之后新增的文件。清理前会再次核对引用、留存和对象状态，有变化的文件不会继续清理。", "批准只安排逐项处理；对象是否已移除以实际结果为准，磁盘释放空间目前无法确认。")
		length := 0
		for _, v := range p.impact {
			n := jsLength(str(v))
			length += n
			if n > 5000 {
				return fail("operations_agentos_cleanup_review_required", 409)
			}
		}
		if length > 20000 {
			return fail("operations_agentos_cleanup_review_required", 409)
		}
		p.target = Object{"kind": "file-cleanup-plan", "id": x["planId"], "label": fmt.Sprintf("具体文件清理计划（%d 份文件）", len(rows)), "href": "/admin/operations/files?kind=all&view=cleanup&plan=" + str(x["planId"])}
		p.title = fmt.Sprintf("批准清理这 %d 份文件", len(rows))
		p.command = Object{"expectedRevision": plan["revision"]}
		created := "未记录"
		if value, e := time.Parse(time.RFC3339Nano, str(plan["createdAt"])); e == nil {
			created = value.UTC().Format("2006-01-02T15:04:05.000Z")
		}
		p.basis = []any{basis("计划制定时间", created), basis("固定范围", fmt.Sprintf("%d 份文件；声明大小合计 %s 字节", len(rows), grouped(total))), basis("当前计划", "等待本次人工批准")}
		return nil
	}
	item, e := service.Get(ctx, a, str(x["targetKind"]), str(x["targetId"]))
	if e != nil {
		return e
	}
	item, e = wire(item)
	if e != nil {
		return e
	}
	p.expiry(item["readExpiresAt"])
	fallback := "文件"
	if kind == "file-access" {
		fallback = "社区附件"
		if x["targetKind"] == "chat" {
			fallback = "私聊附件"
		}
	}
	p.target = Object{"kind": "file", "id": x["targetId"], "label": label(item["name"], fallback), "href": "/admin/operations/files?fileKind=" + str(x["targetKind"]) + "&id=" + str(x["targetId"])}
	if kind == "file-scan-retry" {
		if e = capability(item["canRetryScan"]); e != nil {
			return e
		}
		version := item["processingVersion"]
		if version == nil {
			version = item["version"]
		}
		p.title = "重新安排文件扫描"
		p.command = Object{"kind": "scan", "expectedVersion": version, "reason": x["reason"]}
		p.basis = []any{basis("处理资格", "当前可重新安排扫描")}
		p.impact = []any{"重新安排安全扫描，不删除文件。扫描结果会在检查完成后更新。"}
		return nil
	}
	access := obj(item["access"])
	if item["id"] != x["targetId"] || item["kind"] != x["targetKind"] || str(item["processingVersion"]) == "" || jsLength(str(item["processingVersion"])) > 8192 {
		return fail("operations_agentos_operation_unavailable", 409)
	}
	if _, ok := integer(access["revision"]); !ok {
		return fail("operations_agentos_operation_unavailable", 409)
	}
	if _, ok := access["stopped"].(bool); !ok {
		return fail("operations_agentos_operation_unavailable", 409)
	}
	stop := x["action"] == "stop"
	cap := access["canRestore"]
	if stop {
		cap = access["canStop"]
	}
	if e = capability(cap); e != nil {
		return e
	}
	if stop && num(x["until"]) <= s.now() {
		return fail("operations_file_access_until", 400)
	}
	if stop && access["stopped"] == true || !stop && (access["stopped"] != true || num(access["until"]) <= s.now()) {
		return fail("operations_file_access_changed", 409)
	}
	p.title = "恢复此文件访问"
	if stop {
		p.title = "停止此文件访问"
	}
	p.command = Object{"expectedVersion": item["processingVersion"], "expectedRevision": access["revision"], "action": x["action"], "reason": x["reason"]}
	if stop {
		p.command["until"] = x["until"]
	}
	origin := "社区附件"
	if x["targetKind"] == "chat" {
		origin = "私聊附件"
	}
	state := "当前没有生效的运营访问覆盖"
	if access["stopped"] == true {
		state = "停止至北京时间 " + restrictedTime(num(access["until"]))
	}
	p.basis = []any{basis("文件来源", origin), basis("运营访问状态", state)}
	effect, retrieval := "解除当前这一版运营访问覆盖。", "恢复后仍按原扫描结果、来源状态与阅读权限判断是否可取件。"
	if stop {
		effect = "停止此文件的获准取件，截止北京时间 " + restrictedTime(num(x["until"])) + "。"
		retrieval = "停止期间，下载与获准导出仍受同一文件访问控制。"
	}
	p.impact = []any{effect, "此操作不删除文件，也不更改原存储期限、作者撤回或清理计划。", retrieval, "处理原因：" + str(x["reason"])}
	if stop {
		p.expiry(x["until"])
	} else {
		p.expiry(access["until"])
	}
	return nil
}
