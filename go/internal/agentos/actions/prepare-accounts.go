package actions

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaccounts"
	"time"
)

func (s *Service) accounts(a Actor) (*operationsaccounts.Service, error) {
	if s.AccountGovernance == nil || s.AccountGovernance.Domain == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	v := s.AccountGovernance
	d := *v.Domain
	d.Authority, d.Duty = s.authority(a), s.Permissions.Duty
	return &operationsaccounts.Service{Domain: &d, Accounts: v.Accounts, LookupIdentity: v.LookupIdentity, FindByEmail: v.FindByEmail}, nil
}
func (s *Service) prepareAccount(ctx context.Context, a Actor, x Object, p *preparation) error {
	service, e := s.accounts(a)
	if e != nil {
		return e
	}
	item, e := service.Get(ctx, a, str(x["targetId"]))
	if e != nil {
		return e
	}
	account := obj(item["account"])
	restriction := obj(account["restriction"])
	if account["accountId"] != x["targetId"] || restriction["scope"] != "community-participation" {
		return fail("operations_agentos_operation_unavailable", 409)
	}
	if _, ok := integer(restriction["revision"]); !ok {
		return fail("operations_agentos_operation_unavailable", 409)
	}
	if _, ok := restriction["active"].(bool); !ok {
		return fail("operations_agentos_operation_unavailable", 409)
	}
	if at, ok := integer(item["checkedAt"]); ok {
		p.expiry(at + 30)
	}
	p.expiry(item["readExpiresAt"])
	key := "canRestrict"
	if x["action"] == "release" {
		key = "canRelease"
	}
	if e = capability(obj(item["permissions"])[key]); e != nil {
		return e
	}
	until := str(x["until"])
	if x["action"] == "release" {
		until = str(restriction["until"])
	}
	t, err := time.Parse(time.RFC3339Nano, until)
	if x["action"] == "apply" && (err != nil || t.Unix() <= s.now()) {
		return fail("operations_agentos_restriction_deadline", 409)
	}
	if x["action"] == "release" && (restriction["active"] != true || err != nil || t.Unix() <= s.now()) {
		return fail("operations_agentos_restriction_inactive", 409)
	}
	name, uid := label(account["displayName"], ""), label(account["uid"], "")
	if name == "" && uid == "" {
		return fail("operations_agentos_operation_unavailable", 409)
	}
	display := name
	if name == "" {
		display = "UID " + uid
	} else if uid != "" && uid != name {
		display = name + "（UID " + uid + "）"
	}
	p.target = Object{"kind": "account", "id": x["targetId"], "label": display, "href": "/admin/operations/users?account=" + str(x["targetId"]) + "&tab=restrictions"}
	p.title = "限制此账户参与"
	if restriction["active"] == true {
		p.title = "调整此账户参与限制"
	}
	if x["action"] == "release" {
		p.title = "解除此账户参与限制"
	}
	p.command = pick(x, "reason", "until")
	p.command["expectedRevision"] = restriction["revision"]
	current := "当前没有生效的参与限制"
	if restriction["active"] == true {
		old, _ := time.Parse(time.RFC3339Nano, str(restriction["until"]))
		current = "限制至北京时间 " + restrictedTime(old.Unix())
	}
	p.basis = []any{basis("当前参与状态", current)}
	first := "解除当前这一版账户参与限制，其他内容治理、权限和额度仍按原条件执行。"
	if x["action"] == "apply" {
		prefix := "本次限制生效至"
		if restriction["active"] == true {
			prefix = "本次将现有限制调整为"
		}
		first = prefix + "北京时间 " + restrictedTime(t.Unix()) + "。"
	}
	p.impact = []any{first, "现有业务参与总门覆盖帖子发布与修订、回复、任务发布、评论、邀请、聊天发送与编辑及相关上传。", "这项限制不关闭登录、不删除已有内容；已有读取、撤回和退出仍按各自权限执行。", "处理原因：" + str(x["reason"])}
	p.expiry(t.Unix())
	return nil
}
