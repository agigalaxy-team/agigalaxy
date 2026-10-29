package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

func (s *Service) messages(a Actor) (*messaging.Service, error) {
	if s.Messaging == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	v := s.Messaging
	return &messaging.Service{Pool: v.Pool, Endpoint: v.Endpoint, Authority: s.authority(a), Jobs: v.Jobs, Scheduler: v.Scheduler, Now: v.Now, Directory: v.Directory, Mail: v.Mail, ContinueAIApproval: v.ContinueAIApproval, Approver: v.Approver}, nil
}
func messageChannels(config Object) string {
	names := []string{}
	for _, v := range items(config["channels"]) {
		if n := map[string]string{"announcement": "公开公告", "inapp": "站内信", "email": "系统邮件"}[str(v)]; n != "" {
			names = append(names, n)
		}
	}
	return strings.Join(names, "、")
}
func messageAudience(config Object, draft bool) string {
	a := obj(config["audience"])
	switch a["kind"] {
	case "all-accounts":
		return "全部符合条件的账户"
	case "accounts":
		if draft {
			return fmt.Sprintf("明确列出的 %d 个账户", len(items(a["accountIds"])))
		}
		return fmt.Sprintf("已选 %d 个账户", len(items(a["accountIds"])))
	case "attributes":
		names := []string{}
		for _, v := range items(a["subjectTypes"]) {
			names = append(names, map[string]string{"person": "个人", "agent": "Agent", "organization": "组织"}[str(v)])
		}
		return "主体类型：" + strings.Join(names, "、")
	}
	return "未记录"
}
func messagePurpose(config Object) string {
	value := str(obj(config["content"])["purpose"])
	name := map[string]string{"maintenance": "维护通知", "service-update": "服务更新", "community-update": "社区更新"}[value]
	if name == "" {
		return "未记录"
	}
	return name + "（" + value + "）"
}
func (s *Service) prepareMessaging(ctx context.Context, a Actor, x Object, operation string, p *preparation) error {
	service, e := s.messages(a)
	if e != nil {
		return e
	}
	kind := str(x["kind"])
	id := str(x["targetId"])
	if kind != "messaging-state" {
		create := kind == "message-draft-create"
		if create {
			id = operation
			if !validID(id) {
				return invalid()
			}
		}
		config, e := messaging.ParseDraftConfiguration(x["config"])
		if e != nil {
			return e
		}
		_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
			e := service.ValidateConfigurationWithin(ctx, tx, config)
			return e == nil, e
		})
		if e != nil {
			return e
		}
		p.command = Object{"planId": id, "config": config}
		if !create {
			response, e := service.Get(ctx, a, id)
			if e != nil {
				return e
			}
			p.expiry(response["readExpiresAt"])
			plan := obj(response["plan"])
			if e = capability(plan["id"] == id && plan["state"] == "draft" && obj(plan["capabilities"])["canSave"] == true); e != nil {
				return e
			}
			p.command = Object{"expectedVersion": plan["version"], "expectedRevision": plan["revision"], "config": config}
		}
		content := obj(config["content"])
		expiry, _ := time.Parse(time.RFC3339Nano, str(content["expiresAt"]))
		p.expiry(expiry.Unix())
		p.target = Object{"kind": "message-plan", "id": id, "label": label(content["title"], "待核实消息草稿"), "href": "/admin/operations/messaging?id=" + id}
		p.title = "保存待人工核实的消息草稿"
		if create {
			p.title = "生成待人工核实的消息草稿"
		}
		p.basis = []any{basis("事实与受众", "待人工核实；本操作不批准发布"), basis("用途", messagePurpose(config)), basis("渠道", messageChannels(config)), basis("受众草案", messageAudience(config, true))}
		return messageDraftReview(p, config)
	}
	response, e := service.Get(ctx, a, id)
	if e != nil {
		return e
	}
	plan := obj(response["plan"])
	p.expiry(response["readExpiresAt"])
	action := str(x["action"])
	key := map[string]string{"activate": "canActivate", "pause": "canPause", "resume": "canResume", "stop": "canStop", "withdraw": "canWithdraw"}[action]
	if e = capability(obj(plan["capabilities"])[key]); e != nil {
		return e
	}
	config := obj(plan["config"])
	p.target = Object{"kind": "message-plan", "id": id, "label": label(obj(config["content"])["title"], "消息计划"), "href": "/admin/operations/messaging?id=" + id}
	p.title = map[string]string{"activate": "发布这份消息计划", "pause": "暂停这份消息计划", "resume": "恢复这份消息计划", "stop": "停止这份消息计划", "withdraw": "撤回这份消息计划"}[action]
	p.command = pick(plan, "version", "revision")
	p.command = Object{"expectedVersion": plan["version"], "expectedRevision": plan["revision"]}
	state := map[string]string{"draft": "草稿", "active": "运行中", "paused": "已暂停", "stopped": "已停止", "expired": "已到期"}[str(coalesce(plan["effectiveState"], plan["state"]))]
	if state == "" {
		state = "未记录"
	}
	channels := messageChannels(config)
	if channels == "" {
		channels = "未记录"
	}
	p.basis = []any{basis("当前计划", state), basis("用途", messagePurpose(config)), basis("渠道", channels), basis("受众", messageAudience(config, false))}
	switch action {
	case "activate", "resume":
		if e = messagePublicationReview(p, config); e != nil {
			return e
		}
	case "withdraw":
		p.impact = []any{"撤回已发布的公告和站内信，停止后续发送；已提交的邮件无法收回。"}
	case "pause":
		p.impact = []any{"暂停后续发送，已发送的消息保持当前状态。"}
	default:
		p.impact = []any{"停止后续发送，已发送的消息保持当前状态。"}
	}
	return nil
}

func messageDraftReview(p *preparation, config Object) error {
	p.impact = []any{"仅保存草稿，保存后仍需人工核实事实与受众；本操作不发布、不发送。"}
	return messageConfigReviewFields(p, config)
}

func messagePublicationReview(p *preparation, config Object) error {
	validated, e := messaging.ParseConfiguration(config)
	if e != nil {
		return e
	}
	p.impact = []any{"按这份计划的内容、渠道和时间发布或发送；每次执行时确定并保留当次符合条件的受众。", "邮件提交后是否送达，以实际回执为准。"}
	return messageConfigReviewFields(p, validated)
}

// messageConfigReviewFields receives the already-normalized original config.
// Never silently truncate content or recipients to fit the human review card.
func messageConfigReviewFields(p *preparation, validated Object) error {
	p.impact = append(p.impact, "发送身份："+messaging.OfficialMailIdentities[str(validated["senderKey"])].Name)
	for _, field := range []string{"content", "channels", "audience", "schedule", "senderKey", "automation"} {
		raw, e := json.Marshal(validated[field])
		if e != nil {
			return e
		}
		parts := strategyReviewChunks(string(raw), 4000)
		for i, part := range parts {
			p.impact = append(p.impact, fmt.Sprintf("%s（%d/%d）：%s", field, i+1, len(parts), part))
		}
	}
	total := 0
	for _, line := range p.impact {
		n := jsLength(str(line))
		total += n
		if n > 5000 {
			return fail("operations_agentos_message_review_required", 409)
		}
	}
	if len(p.impact) > 80 || total > 20000 {
		return fail("operations_agentos_message_review_required", 409)
	}
	return nil
}
