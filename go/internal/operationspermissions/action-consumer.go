package operationspermissions

import (
	"context"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func actionInvalid() error { return fail("invalid_operations_agentos_action", 400) }
func managementRequest(input Object) (Object, error) {
	x := obj(clone(input))
	switch x["kind"] {
	case "ai-work-prompt-save":
		if !exact(x, []string{"kind", "aiAccountId", "prompt"}, nil) || !validUUID(x["aiAccountId"]) {
			return nil, actionInvalid()
		}
		p, ok := x["prompt"].(string)
		if !ok || utf8.RuneCountInString(p) > 16000 {
			return nil, actionInvalid()
		}
	case "ai-role-command":
		if !exact(x, []string{"kind", "command"}, nil) {
			return nil, actionInvalid()
		}
		c, e := parseDelegated(obj(x["command"]), true)
		if e != nil {
			return nil, actionInvalid()
		}
		x["command"] = c
	default:
		return nil, actionInvalid()
	}
	return x, nil
}
func managementAction(x Object) string {
	if x["kind"] == "ai-work-prompt-save" {
		return "ai.prompts.update"
	}
	return "ai.roles." + delegatedAction(obj(x["command"]))
}
func actionLabel(value any, fallback string) string {
	s, ok := value.(string)
	if !ok || trim(s) == "" {
		return fallback
	}
	r := []rune{}
	for _, c := range s {
		if unicode.Is(unicode.Cc, c) {
			r = append(r, ' ')
		} else {
			r = append(r, c)
		}
	}
	return displaySlice(trim(string(r)), 180)
}
func (s *Service) actionHuman(ctx context.Context, actor Actor, domain, purpose, action string) (Actor, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.HumanAIWithin(ctx, tx, actor, domain, purpose, action) })
}
func (s *Service) PrepareManagementAction(ctx context.Context, operator Actor, domain string, input Object, operationID string) (Object, error) {
	x, e := managementRequest(input)
	if e != nil {
		return nil, e
	}
	read := "ai.roles.read"
	if x["kind"] == "ai-work-prompt-save" {
		read = "ai.prompts.read"
	}
	actor, e := s.actionHuman(ctx, operator, domain, "prepare", read)
	if e != nil {
		return nil, e
	}
	expires := s.now() + 30
	var target, command, review Object
	var title string
	impact, basis := []any{}, []any{}
	expiry := func(v any) {
		if intOK(v, 0) && num(v) < expires {
			expires = num(v)
		}
	}
	if x["kind"] == "ai-work-prompt-save" {
		item, e := s.DelegatedPrompt(ctx, actor, Object{"aiAccountId": x["aiAccountId"]})
		if e != nil {
			return nil, e
		}
		prompt := obj(item["prompt"])
		if _, ok := prompt["name"].(string); !ok {
			return nil, actionInvalid()
		}
		if _, ok := prompt["text"].(string); !ok {
			return nil, actionInvalid()
		}
		expiry(item["readExpiresAt"])
		if prompt["text"] == x["prompt"] {
			return nil, fail("operations_ai_prompt_no_change", 409)
		}
		if !contains([]string{"governance", "messaging", "discovery", "maintenance"}, str(prompt["domain"])) || !validUUID(prompt["configId"]) || !intOK(prompt["revision"], 1) || !intOK(prompt["promptVersion"], 1) || utf8.RuneCountInString(str(prompt["name"])) > 100 || utf8.RuneCountInString(str(prompt["text"])) > 16000 {
			return nil, actionInvalid()
		}
		command = Object{"aiAccountId": x["aiAccountId"], "expectedRevision": prompt["revision"], "expectedPromptVersion": prompt["promptVersion"], "prompt": x["prompt"], "delegationVersion": item["delegationVersion"]}
		name := actionLabel(prompt["name"], "获准 AI")
		target = Object{"kind": "ai-work-prompt", "id": x["aiAccountId"], "label": name + "的岗位工作要求", "href": "/admin/operations/ai-work-accounts?domain=" + str(prompt["domain"]) + "&tab=duty"}
		title = "修改「" + name + "」的岗位工作要求"
		source := "empty-default"
		if str(prompt["text"]) != "" {
			source = "saved-configuration"
		}
		review = Object{"kind": "ai-work-prompt", "aiAccountId": x["aiAccountId"], "domain": prompt["domain"], "name": prompt["name"], "configId": prompt["configId"], "expectedRevision": prompt["revision"], "promptVersion": prompt["promptVersion"], "nextPromptVersion": num(prompt["promptVersion"]) + 1, "scope": "role-work-requirements", "source": source, "before": prompt["text"], "after": x["prompt"], "effect": "new-rounds-only"}
		basis = []any{Object{"label": "当前岗位要求", "value": "版本 " + strconv.FormatInt(num(prompt["promptVersion"]), 10) + "；配置修订 " + strconv.FormatInt(num(prompt["revision"]), 10)}, Object{"label": "人工管理范围", "value": "委派版本 " + strconv.FormatInt(num(item["delegationVersion"]), 10)}}
		impact = []any{"仅更新这个岗位的工作要求，新轮次采用新版本。", "模型、固定代码边界、目标、角色权限、自动授权、开关和运行频率保持原配置。"}
	} else {
		directory, e := s.DelegatedDirectory(ctx, actor)
		if e != nil {
			return nil, e
		}
		role := obj(x["command"])
		item, e := s.DelegatedRolePreparation(ctx, actor, role)
		if e != nil {
			return nil, e
		}
		expiry(directory["readExpiresAt"])
		expiry(item["readExpiresAt"])
		if num(obj(directory["delegation"])["version"]) != num(item["delegationVersion"]) {
			return nil, fail("operations_ai_delegation_version_changed", 409)
		}
		command = Object{"command": item["command"], "delegationVersion": item["delegationVersion"]}
		assignment := role["kind"] == "assignment-save"
		id := role["id"]
		if id == nil {
			if !validUUID(operationID) {
				return nil, actionInvalid()
			}
			id = operationID
		}
		var name any = role["name"]
		targetKind := "ai-role"
		if assignment {
			targetKind = "ai-role-assignment"
			name = nil
			for _, v := range arr(directory["targetAiAccounts"]) {
				r := obj(v)
				if r["id"] == role["aiAccountId"] {
					name = r["name"]
					break
				}
			}
		}
		target = Object{"kind": targetKind, "id": id, "label": actionLabel(name, "获准 AI 专用角色"), "href": "/admin/operations/permissions?tab=roles"}
		if assignment {
			verb := "撤回"
			if role["enabled"] == true {
				verb = "分配"
			}
			title = verb + "获准 AI 的专用角色"
			var roleName any
			for _, v := range arr(directory["roles"]) {
				r := obj(v)
				if r["id"] == role["roleId"] {
					roleName = r["name"]
					break
				}
			}
			impact = []any{"只" + verb + "这个获准其他 AI 的指定专用角色。", "目标 AI：" + actionLabel(name, "获准 AI") + "；角色：" + actionLabel(roleName, "当前专用角色")}
		} else {
			title = "修改获准 AI 专用角色"
			if role["kind"] == "role-create" {
				title = "创建获准 AI 专用角色"
			}
			enabled := "停用"
			if role["enabled"] == true {
				enabled = "启用"
			}
			permissions := strings.Join(stringsOf(role["permissions"]), "、")
			if permissions == "" {
				permissions = "无"
			}
			targets := []string{}
			for _, id := range stringsOf(role["targetAiAccountIds"]) {
				var name any
				for _, v := range arr(directory["targetAiAccounts"]) {
					r := obj(v)
					if r["id"] == id {
						name = r["name"]
						break
					}
				}
				targets = append(targets, actionLabel(name, "获准 AI"))
			}
			impact = []any{"角色名称：" + str(role["name"]), "角色说明：" + str(role["description"]), "角色状态：" + enabled, "角色权限：" + permissions, "管理目标：" + strings.Join(targets, "、")}
		}
		impact = append(impact, "只影响人工委派内其他 AI 的专用角色；共享角色、人员角色、总控自身与管理范围保持原边界。")
		basis = []any{Object{"label": "人工管理范围", "value": "委派版本 " + strconv.FormatInt(num(item["delegationVersion"]), 10)}, Object{"label": "原对象版本", "value": strconv.FormatInt(num(role["expectedVersion"]), 10)}}
	}
	required := managementAction(x)
	if _, e = s.actionHuman(ctx, actor, domain, "prepare", required); e != nil {
		return nil, e
	}
	if expires <= s.now() {
		return nil, fail("operations_source_unavailable", 409)
	}
	proposal := Object{"schemaVersion": 1, "kind": x["kind"], "domain": domain, "request": x, "command": command, "target": target, "title": title, "impact": impact, "basis": basis, "requiredAction": required, "checkedAt": s.now(), "readExpiresAt": expires, "decisionSource": "human-required"}
	if review != nil {
		proposal["review"] = review
	}
	return proposal, nil
}
func managementCommand(proposal Object, operationID string, recovery bool) (Object, Object, error) {
	x, e := managementRequest(obj(proposal["request"]))
	if e != nil || num(proposal["schemaVersion"]) != 1 || proposal["kind"] != x["kind"] || !validUUID(operationID) {
		return nil, nil, actionInvalid()
	}
	command := obj(clone(proposal["command"]))
	if !intOK(command["delegationVersion"], 1) {
		return nil, nil, actionInvalid()
	}
	if x["kind"] == "ai-work-prompt-save" {
		if !exact(command, []string{"aiAccountId", "expectedRevision", "expectedPromptVersion", "prompt", "delegationVersion"}, nil) {
			return nil, nil, actionInvalid()
		}
		body := obj(clone(command))
		delete(body, "delegationVersion")
		body["operationId"] = operationID
		parsed, e := parsePrompt(body, true)
		if e != nil {
			return nil, nil, actionInvalid()
		}
		if body["aiAccountId"] != x["aiAccountId"] || body["prompt"] != x["prompt"] {
			if recovery {
				return nil, nil, fail("operations_agentos_operation_conflict", 409)
			}
			return nil, nil, actionInvalid()
		}
		if !recovery && (obj(proposal["target"])["kind"] != "ai-work-prompt" || obj(proposal["target"])["id"] != x["aiAccountId"]) {
			return nil, nil, actionInvalid()
		}
		return x, parsed, nil
	}
	if !exact(command, []string{"command", "delegationVersion"}, nil) {
		return nil, nil, actionInvalid()
	}
	inner, e := parseDelegated(obj(command["command"]), true)
	if e != nil {
		return nil, nil, actionInvalid()
	}
	if !same(inner, x["command"]) {
		if recovery {
			return nil, nil, fail("operations_agentos_operation_conflict", 409)
		}
		return nil, nil, actionInvalid()
	}
	inner["operationId"] = operationID
	return x, inner, nil
}
func managementResult(x, command, result Object, operationID string) (Object, error) {
	if result["operationId"] != operationID || num(result["delegationVersion"]) != num(command["delegationVersion"]) {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	receipt := Object{"operationId": operationID, "delegationVersion": result["delegationVersion"], "replayed": result["replayed"] == true}
	summary := ""
	if x["kind"] == "ai-work-prompt-save" {
		p := obj(result["prompt"])
		if p["aiAccountId"] != x["aiAccountId"] || num(p["revision"]) != num(command["expectedRevision"])+1 || num(p["promptVersion"]) != num(command["expectedPromptVersion"])+1 {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		summary = "岗位工作要求已保存，新轮次采用新版本。"
		for _, k := range []string{"aiAccountId", "configId", "revision", "promptVersion"} {
			receipt[k] = p[k]
		}
	} else {
		input := obj(command["command"])
		assignment := input["kind"] == "assignment-save"
		value := obj(result["role"])
		if assignment {
			value = obj(result["assignment"])
		}
		if !validUUID(value["id"]) || num(value["version"]) != num(input["expectedVersion"])+1 {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		if assignment {
			if value["aiAccountId"] != input["aiAccountId"] || value["roleId"] != input["roleId"] || value["enabled"] != input["enabled"] {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
			receipt["assignmentId"], receipt["aiAccountId"], receipt["roleId"] = value["id"], value["aiAccountId"], value["roleId"]
			summary = "获准 AI 的专用角色分配已保存。"
		} else {
			if value["subjectScope"] != "ai-only" || value["name"] != input["name"] || value["enabled"] != input["enabled"] || !same(value["permissions"], input["permissions"]) {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
			receipt["roleId"] = value["id"]
			summary = "获准 AI 的专用角色已保存。"
		}
		receipt["version"], receipt["enabled"] = value["version"], value["enabled"]
	}
	return Object{"operationId": operationID, "state": "completed", "summary": summary, "receipt": receipt}, nil
}
func (s *Service) ExecuteManagementAction(ctx context.Context, operator Actor, proposal Object, operationID string, authorize func(context.Context) (Actor, error)) (Object, error) {
	x, body, e := managementCommand(proposal, operationID, false)
	if e != nil {
		return nil, e
	}
	if authorize == nil || proposal["requiredAction"] != managementAction(x) {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	authenticate := func() (Actor, error) {
		a, e := authorize(ctx)
		if e != nil {
			return Actor{}, e
		}
		if a.ID != operator.ID || a.Endpoint != s.Endpoint {
			return Actor{}, fail("business_admin_denied", 403)
		}
		if operator.AIProof != nil {
			c, e := s.humanContext(operator)
			if e != nil {
				return Actor{}, e
			}
			copy := *c
			copy.humanProof = a.Proof
			a.AIProof = &copy
		}
		return s.actionHuman(ctx, a, str(proposal["domain"]), "prepare", managementAction(x))
	}
	actor, e := authenticate()
	if e != nil {
		return nil, e
	}
	version := num(obj(proposal["command"])["delegationVersion"])
	var result Object
	if x["kind"] == "ai-work-prompt-save" {
		result, e = s.DelegatedPromptSave(ctx, actor, body, DelegatedOptions{&version})
	} else {
		result, e = s.DelegatedRoleSave(ctx, actor, body, DelegatedOptions{&version})
	}
	if e != nil {
		return nil, e
	}
	if _, e = authenticate(); e != nil {
		return Object{"operationId": operationID, "state": "unknown", "summary": "本次处理结果暂时无法读取，系统会继续查询。", "receipt": nil}, nil
	}
	return managementResult(x, obj(proposal["command"]), result, operationID)
}
func (s *Service) RecoverManagementAction(ctx context.Context, operator Actor, proposal Object, operationID string) (Object, error) {
	x, body, e := managementCommand(proposal, operationID, true)
	if e != nil {
		return nil, e
	}
	if proposal["requiredAction"] != managementAction(x) {
		return nil, actionInvalid()
	}
	read := "ai.roles.read"
	kind := str(obj(x["command"])["kind"])
	if x["kind"] == "ai-work-prompt-save" {
		read, kind = "ai.prompts.read", "prompt-save"
	}
	actor, e := s.actionHuman(ctx, operator, str(proposal["domain"]), "query", read)
	if e != nil {
		return nil, e
	}
	saved, e := s.DelegatedManagementOperation(ctx, actor, operationID, &kind, body)
	if e != nil {
		return nil, e
	}
	if saved["state"] == "not-recorded" {
		return Object{"operationId": operationID, "state": "not-recorded", "summary": "尚未记录本次处理。", "receipt": nil}, nil
	}
	if _, e = s.actionHuman(ctx, actor, str(proposal["domain"]), "query", read); e != nil {
		return nil, e
	}
	return managementResult(x, obj(proposal["command"]), obj(saved["result"]), operationID)
}

// Display-only UTF16 budget. A surrogate pair is kept together; source
// request/statement/payload strings never pass through this presentation slice.
func displaySlice(s string, budget int) string {
	units := 0
	for i, r := range s {
		size := 1
		if r > 0xffff {
			size = 2
		}
		if units+size > budget {
			return s[:i]
		}
		units += size
	}
	return s
}
