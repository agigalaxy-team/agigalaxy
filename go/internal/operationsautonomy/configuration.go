package operationsautonomy

import (
	"context"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func invalid() error { return fault.New("invalid_operations_autonomy_request", 400) }
func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func text(v any, min, max int, trimmed bool) (string, bool) {
	s, ok := v.(string)
	if trimmed {
		s = trim(s)
	}
	n := utf8.RuneCountInString(s)
	return s, ok && n >= min && n <= max
}

var clockPattern = regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`)

func parseConfiguration(input Object) (Object, error) {
	if !closed(input, []string{"operationId", "expectedRevision", "enabled", "mode", "schedule", "purpose", "goal", "prompt"}, []string{"plan"}) || !schemaUUID.MatchString(str(input["operationId"])) || !integer(input["expectedRevision"], 1, 9007199254740991) || !has([]string{"code", "ai", "ai-human", "human-ai"}, str(input["mode"])) {
		return nil, invalid()
	}
	if _, ok := input["enabled"].(bool); !ok {
		return nil, invalid()
	}
	x := obj(clone(input))
	for k, bounds := range map[string][2]int{"purpose": {1, 120}, "goal": {0, 4000}, "prompt": {0, 16000}} {
		s, ok := text(x[k], bounds[0], bounds[1], k != "prompt")
		if !ok {
			return nil, invalid()
		}
		x[k] = s
	}
	schedule := obj(x["schedule"])
	if !closed(schedule, []string{"kind"}, []string{"minutes", "at", "timezone"}) || !has([]string{"interval", "daily"}, str(schedule["kind"])) {
		return nil, invalid()
	}
	if _, ok := schedule["timezone"]; !ok {
		schedule["timezone"] = "Asia/Shanghai"
	}
	if schedule["timezone"] != "Asia/Shanghai" {
		return nil, invalid()
	}
	if v, ok := schedule["minutes"]; ok && v != nil && !integer(v, 1, 10080) {
		return nil, invalid()
	}
	if v, ok := schedule["at"]; ok && v != nil && !clockPattern.MatchString(str(v)) {
		return nil, invalid()
	}
	plan := obj(x["plan"])
	if _, ok := x["plan"]; !ok {
		plan = Object{}
		x["plan"] = plan
	}
	if !closed(plan, nil, []string{"strategyIds", "grantIds", "actions", "resourceIds", "eventTypes"}) {
		return nil, invalid()
	}
	for k, max := range map[string]int{"strategyIds": 50, "grantIds": 50, "actions": 200, "resourceIds": 100, "eventTypes": 50} {
		if _, ok := plan[k]; !ok {
			plan[k] = []any{}
		}
		a, ok := plan[k].([]any)
		if !ok || len(a) > max {
			return nil, invalid()
		}
		for _, v := range a {
			s, ok := v.(string)
			if !ok {
				return nil, invalid()
			}
			if k == "actions" || k == "eventTypes" {
				if !safeCode.MatchString(s) {
					return nil, invalid()
				}
			} else if !schemaUUID.MatchString(s) {
				return nil, invalid()
			}
		}
	}
	return x, nil
}
func NextDue(schedule Object, at time.Time) (time.Time, error) {
	if schedule["kind"] == "interval" {
		return at.Add(time.Duration(num(schedule["minutes"])) * time.Minute), nil
	}
	if str(schedule["at"]) == "" {
		return time.Time{}, fault.New("operations_autonomy_daily_time_required", 400)
	}
	hour, minute := 0, 0
	_, e := time.Parse("15:04", str(schedule["at"]))
	if e != nil {
		return time.Time{}, invalid()
	}
	t, _ := time.Parse("15:04", str(schedule["at"]))
	hour, minute = t.Hour(), t.Minute()
	local := at.UTC().Add(8 * time.Hour)
	due := time.Date(local.Year(), local.Month(), local.Day(), hour-8, minute, 0, 0, time.UTC)
	if !due.After(at) {
		due = due.Add(24 * time.Hour)
	}
	return due, nil
}
func present(r Object) Object {
	o := Object{"id": r["id"], "domain": r["domain"], "revision": r["revision"]}
	for k, v := range obj(r["configuration"]) {
		o[k] = v
	}
	o["enabled"] = r["enabled"]
	o["promptVersion"] = r["prompt_version"]
	o["planVersion"] = r["plan_version"]
	o["delegationVersion"] = r["delegation_version"]
	for out, k := range map[string]string{"nextDueAt": "next_due_at", "lastValidAt": "last_valid_at", "updatedAt": "updated_at"} {
		o[out] = iso(r[k])
	}
	return o
}
func iso(v any) any {
	if v == nil {
		return nil
	}
	t, e := time.Parse(time.RFC3339Nano, str(v))
	if e != nil {
		return nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func (s *Service) runtime(ctx context.Context) Object {
	if s.RuntimeStatus == nil {
		return Object{"state": "not-configured", "modelState": "not-configured"}
	}
	r, e := s.RuntimeStatus(ctx)
	if e != nil {
		return Object{"state": "unavailable", "modelState": "unknown"}
	}
	return r
}
func (s *Service) readinessWithin(ctx context.Context, tx pgx.Tx, row, runtime Object) (Object, error) {
	reasons := []Object{}
	add := func(code, message string) { reasons = append(reasons, Object{"code": code, "message": message}) }
	var role *operationsai.Authorization
	var account Object
	if s.AIWork == nil {
		add("ai-unavailable", "AI 工作账户暂不可用")
	} else {
		r, e := s.AIWork.AuthorizationWithin(ctx, tx, str(row["domain"]), nil)
		if e != nil {
			add("ai-unavailable", "AI 工作账户暂不可用")
		} else {
			role = &r
			account, _ = optional(ctx, tx, `SELECT to_jsonb(w) FROM(SELECT id,name,enabled FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain=$2)w`, s.Endpoint, row["domain"])
			if !r.Enabled {
				add("ai-disabled", "AI 工作账户已停用")
			}
			if len(r.Permissions) == 0 {
				add("no-role", "尚未分配业务权限")
			}
		}
	}
	cfg := obj(row["configuration"])
	plan, schedule := obj(cfg["plan"]), obj(cfg["schedule"])
	ordinary := []string{}
	for _, code := range texts(plan["actions"]) {
		d := operationsai.Definition(code)
		if d["query"] != true && !has([]string{"ai-role-delegation", "ai-prompt-delegation"}, str(d["kind"])) {
			ordinary = append(ordinary, code)
		}
	}
	if schedule["kind"] == "daily" && str(schedule["at"]) == "" {
		add("daily-time-required", "请先选择每日运行时刻")
	}
	if schedule["kind"] == "interval" && !integer(schedule["minutes"], -9007199254740991, 9007199254740991) {
		add("interval-required", "请选择巡检频率")
	}
	if cfg["mode"] != "code" {
		if runtime["state"] != "connected" {
			code := "runtime-unavailable"
			if runtime["state"] == "not-configured" {
				code = "runtime-not-configured"
			}
			add(code, "运行服务暂不可用")
		}
		_, array := runtime["configuredDomains"].([]any)
		if runtime["modelState"] != "configured" || array && !has(texts(runtime["configuredDomains"]), str(row["domain"])) {
			add("model-not-configured", "当前岗位尚无可用的人工模型配置")
		}
	}
	if cfg["mode"] == "code" {
		active, e := optional(ctx, tx, `SELECT to_jsonb(t) FROM(SELECT v.configuration FROM operations_p13_strategy_heads_v1 h JOIN operations_p13_strategy_versions_v1 v ON v.id=h.active_id WHERE h.endpoint=$1 AND NOT h.paused)t`, s.Endpoint)
		if e != nil {
			return nil, e
		}
		rules := []Object{}
		for _, v := range list(obj(active["configuration"])["strategies"]) {
			r := obj(v)
			if has(texts(plan["strategyIds"]), str(r["id"])) && r["enabled"] == true && r["mode"] == "code-automatic" {
				rules = append(rules, r)
			}
		}
		invalidRule := len(rules) == 0
		for _, r := range rules {
			actions := texts(obj(r["execution"])["actions"])
			if r["template"] != "selected-public-content-visibility" && !(len(actions) == 1 && has([]string{"files.scan.retry", "content.restore"}, actions[0])) {
				invalidRule = true
			}
		}
		if invalidRule {
			add("rule-not-configured", "请选择已发布且有确定处理参数的程序规则")
		}
	}
	if cfg["mode"] == "ai" && len(ordinary) > 0 && len(texts(plan["grantIds"])) == 0 {
		add("authorization-required", "自主动作尚未选择自动执行授权")
	}
	for _, action := range texts(plan["actions"]) {
		if role == nil || !has(role.Permissions, action) {
			add("role-scope-missing", "当前角色未包含计划中的业务动作")
			break
		}
	}
	management := []string{}
	for _, a := range texts(plan["actions"]) {
		if strings.HasPrefix(a, "ai.roles.") || strings.HasPrefix(a, "ai.prompts.") {
			management = append(management, a)
		}
	}
	if len(management) > 0 {
		var delegation Object
		if role != nil {
			var e error
			delegation, e = optional(ctx, tx, `SELECT to_jsonb(d) FROM(SELECT enabled,allowed_management_actions,target_ai_account_ids FROM operations_ai_role_delegations_v1 WHERE endpoint=$1 AND source_ai_account_id=$2)d`, s.Endpoint, role.AccountID)
			if e != nil {
				return nil, e
			}
		}
		bad := delegation["enabled"] != true || len(texts(delegation["target_ai_account_ids"])) == 0
		for _, a := range management {
			action := strings.TrimPrefix(a, "ai.roles.")
			if strings.HasPrefix(a, "ai.prompts.") {
				action = "prompt-" + strings.TrimPrefix(a, "ai.prompts.")
			}
			bad = bad || !has(texts(delegation["allowed_management_actions"]), action)
		}
		if bad {
			add("management-delegation-required", "所选AI管理动作尚未获得明确的目标和管理授权")
		}
	}
	if cfg["mode"] == "ai" && len(ordinary) > 0 {
		grants, e := many(ctx, tx, `SELECT to_jsonb(g) FROM operations_automation_grants_v1 g WHERE endpoint=$1 AND id=ANY($2::uuid[])`, s.Endpoint, texts(plan["grantIds"]))
		if e != nil {
			return nil, e
		}
		inactive := false
		for _, action := range ordinary {
			found := false
			for _, g := range grants {
				found = found || role != nil && g["enabled"] == true && g["executor_kind"] == "ai" && g["mode"] == "automatic" && g["ai_account_id"] == role.AccountID && has(texts(g["permissions"]), action) && perms.AutomationResourceScope(g)["kind"] != "unresolved"
			}
			inactive = inactive || !found
		}
		if inactive {
			add("authorization-inactive", "所选自动授权尚未覆盖当前岗位与动作")
		}
	}
	return Object{"ready": len(reasons) == 0, "reasons": reasons, "account": account, "role": role}, nil
}
func (s *Service) GetConfig(ctx context.Context, a Actor, domain string) (Object, error) {
	if _, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "autonomy.read", nil) }); e != nil {
		return nil, e
	}
	runtime := s.runtime(ctx)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.actor(ctx, tx, a, "autonomy.read", nil); e != nil {
			return nil, e
		}
		if e := s.EnsureWithin(ctx, tx); e != nil {
			return nil, e
		}
		row, e := s.configWithin(ctx, tx, domain, "")
		if e != nil {
			return nil, e
		}
		ready, e := s.readinessWithin(ctx, tx, row, runtime)
		if e != nil {
			return nil, e
		}
		rows, e := many(ctx, tx, `SELECT to_jsonb(v) FROM(SELECT revision,prompt_version,plan_version,delegation_version,created_at FROM operations_autonomy_versions_v1 WHERE config_id=$1 ORDER BY revision DESC LIMIT 30)v`, row["id"])
		if e != nil {
			return nil, e
		}
		history := []Object{}
		for _, r := range rows {
			history = append(history, Object{"revision": r["revision"], "promptVersion": r["prompt_version"], "planVersion": r["plan_version"], "delegationVersion": r["delegation_version"], "createdAt": iso(r["created_at"])})
		}
		return s.stamp(Object{"config": present(row), "readiness": Object{"ready": ready["ready"], "reasons": ready["reasons"]}, "history": history}), nil
	})
}
