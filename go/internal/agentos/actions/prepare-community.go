package actions

import (
	"context"
)

func (s *Service) prepareCommunity(ctx context.Context, a Actor, x Object, p *preparation) error {
	kind, id := str(x["kind"]), str(x["targetId"])
	var item Object
	var e error
	if kind == "resource-visibility" {
		service, e := s.resources(a)
		if e != nil {
			return e
		}
		item, e = service.Get(ctx, a, str(x["targetKind"]), id)
		if e != nil {
			return e
		}
	} else {
		service, e := s.content(a)
		if e != nil {
			return e
		}
		if kind == "case-resolve" {
			item, e = service.Report(ctx, a, id)
		} else {
			item, e = service.Section(ctx, a, id)
		}
		if e != nil {
			return e
		}
	}
	p.expiry(item["readExpiresAt"])
	if kind == "case-resolve" {
		if e = capability(item["canModerate"]); e != nil {
			return e
		}
		action := str(x["restrictionAction"])
		if action == "" {
			action = "keep"
			if x["hideUntil"] != nil {
				action = "hide"
			}
		}
		flag := map[string]string{"hide": "canHide", "release": "canRelease", "keep": "canKeep"}[action]
		if e = capability(obj(item["currentEffect"])[flag]); e != nil {
			return e
		}
		p.target = Object{"kind": "public-case", "id": id, "label": label(item["title"], "公开内容举报与申诉"), "href": "/admin/operations/community?tab=reports&id=" + id}
		p.title = "复核这项公开举报与申诉"
		p.command = pick(x, "resolution", "summary", "restrictionAction", "hideUntil")
		p.command["expectedVersion"] = item["version"]
		state := "当前无生效限制"
		if obj(item["currentEffect"])["active"] == true {
			state = "当前生效"
		}
		p.basis = []any{basis("处理资格", "当前独立处理者可复核"), basis("本案限制", state)}
		effect := "维持本案现有展示限制。"
		if action == "release" {
			effect = "解除本案的隐藏限制。其他案件的限制，以及原内容的可见条件仍保持。"
		} else if action == "hide" {
			deadline, e := s.deadline(x["hideUntil"], item["maxHideSeconds"], obj(item["source"])["publishedUntil"])
			if e != nil {
				return e
			}
			effect = "设置本案隐藏，截止 " + deadline
		}
		p.impact = []any{"结论：" + map[string]string{"accepted": "举报成立", "dismissed": "不采纳举报", "needs-review": "需要进一步复核"}[str(x["resolution"])], effect, "处理说明：" + str(x["summary"])}
		return nil
	}
	display := "正常展示"
	if obj(item["visibility"])["hidden"] == true {
		display = "已隐藏"
	}
	if kind == "section-classification" || kind == "section-visibility" {
		if item["sourceState"] != "available" {
			return fail("operations_source_unavailable", 409)
		}
		p.target = Object{"kind": "section", "id": id, "label": label(item["title"], "版块"), "href": "/admin/operations/community?tab=sections&id=" + id}
		current := category(str(item["category"]))
		if current == "" {
			current = "未记录"
		}
		p.basis = []any{basis("当前分类", current), basis("当前展示", display)}
		if kind == "section-classification" {
			if e = capability(item["canManage"]); e != nil {
				return e
			}
			p.title = "调整版块分类"
			p.impact = []any{"分类改为" + category(str(x["category"]))}
			p.command = Object{"expectedVersion": item["version"], "category": x["category"], "reason": x["reason"]}
			return nil
		}
	}
	cap := item["canRestore"]
	if x["action"] == "hide" {
		cap = item["canHide"]
	}
	if e = capability(cap); e != nil {
		return e
	}
	p.command = Object{"kind": x["action"], "expectedVersion": item["version"], "expectedVisibilityVersion": obj(item["visibility"])["version"], "reason": x["reason"]}
	if v, ok := x["until"]; ok {
		p.command["until"] = v
	}
	if kind == "section-visibility" {
		p.title = "恢复这个版块"
		p.impact = []any{"解除这次运营下架，版块仍只向原本有权阅读的人展示。"}
		if x["action"] == "hide" {
			deadline, e := s.deadline(x["until"], item["maxHideSeconds"], nil)
			if e != nil {
				return e
			}
			p.title = "下架这个版块"
			p.impact = []any{"停止版块展示，截止 " + deadline}
		}
		return nil
	}
	name := "方法"
	if x["targetKind"] == "projects" {
		name = "项目"
	}
	p.target = Object{"kind": x["targetKind"], "id": id, "label": label(item["title"], name), "href": "/admin/operations/resources?kind=" + str(x["targetKind"]) + "&id=" + id}
	verb := "恢复这个"
	if x["action"] == "hide" {
		verb = "下架这个"
	}
	p.title = verb + name
	source := "当前不可读取"
	if item["sourceState"] == "available" {
		source = "当前可读取"
	}
	p.basis = []any{basis("来源状态", source), basis("当前展示", display)}
	p.impact = []any{"解除这次运营下架。已归档、撤回或到期的材料仍不展示。"}
	if x["action"] == "hide" {
		deadline, e := s.deadline(x["until"], item["maxHideSeconds"], nil)
		if e != nil {
			return e
		}
		p.impact = []any{"停止展示，截止 " + deadline}
	}
	return nil
}
