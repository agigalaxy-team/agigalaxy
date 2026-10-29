package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

type DutyOperation struct {
	Permission, TargetID, OperationID      string
	Request, Command                       Object
	BusinessAction                         *string
	GrantID, StrategyID, StrategyVersionID *string
	GrantVersion                           *int64
}

func operationObject(in DutyOperation) Object {
	o := Object{"permission": in.Permission, "targetId": in.TargetID, "operationId": in.OperationID}
	if in.Request != nil {
		o["request"] = clone(in.Request)
	}
	if in.Command != nil {
		o["command"] = clone(in.Command)
	}
	for k, v := range map[string]*string{"grantId": in.GrantID, "strategyId": in.StrategyID, "strategyVersionId": in.StrategyVersionID} {
		if v != nil {
			o[k] = *v
		}
	}
	if in.GrantVersion != nil {
		o["grantVersion"] = *in.GrantVersion
	}
	return o
}
func objectOperation(o Object) DutyOperation {
	in := DutyOperation{Permission: str(o["permission"]), TargetID: str(o["targetId"]), OperationID: str(o["operationId"]), Request: obj(o["request"]), Command: obj(o["command"])}
	for k, dst := range map[string]**string{"grantId": &in.GrantID, "strategyId": &in.StrategyID, "strategyVersionId": &in.StrategyVersionID} {
		if o[k] != nil {
			v := str(o[k])
			*dst = &v
		}
	}
	if o["grantVersion"] != nil {
		n := num(o["grantVersion"])
		in.GrantVersion = &n
	}
	return in
}
func (s *Service) authorizeOperationWithin(ctx context.Context, tx pgx.Tx, a Actor, p *dutyProof, in DutyOperation, persisted, sourceMatched bool) (Object, error) {
	if e := s.dutyAuthorizationWithin(ctx, tx, p.input, persisted); e != nil {
		return nil, e
	}
	row, e := s.taskWithin(ctx, tx, p.input.TaskID, "")
	if e != nil {
		return nil, e
	}
	if obj(row["control_state"])["kind"] == "manual-pause" && has([]string{"requested", "paused"}, str(obj(row["control_state"])["phase"])) {
		return nil, fault.New("operations_autonomy_pause_requested", 409)
	}
	if unresolved, err := s.unresolvedDutyWriteWithin(ctx, tx, row, in.OperationID); err != nil {
		return nil, err
	} else if unresolved {
		return nil, fault.New("operations_autonomy_original_operation_unknown", 409)
	}
	cfg := obj(row["configuration"])
	plan := obj(cfg["plan"])
	if persisted {
		if _, e = tx.Exec(ctx, `SELECT public.galaxy_autonomy_lock_persisted_authority_v1($1,$2)`, s.Endpoint, row["id"]); e != nil {
			return nil, e
		}
		if s.AIWork == nil {
			return nil, fault.New("operations_ai_work_unavailable", 503)
		}
		accountID := str(row["ai_account_id"])
		role, e := s.AIWork.AuthorizationWithin(ctx, tx, str(row["domain"]), &accountID)
		if e != nil {
			return nil, e
		}
		if !role.Enabled || !has(role.Permissions, in.Permission) {
			return nil, fault.New("operations_autonomy_authorization_changed", 403)
		}
	}
	if !has([]string{"ai", "code"}, str(row["mode"])) || !has(texts(plan["actions"]), in.Permission) || in.TargetID == "" || in.OperationID == "" {
		return nil, fault.New("operations_autonomy_scope_denied", 403)
	}
	if in.Request["kind"] != nil {
		var decided bool
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_autonomy_decisions_v1 d JOIN operations_autonomy_tool_calls_v1 c ON c.endpoint=d.endpoint AND c.task_id=d.task_id AND c.call_id=d.call_id WHERE d.endpoint=$1 AND d.task_id=$2 AND c.arguments->>'kind'=$3 AND COALESCE(c.arguments->>'targetId',c.arguments->>'reportId',c.arguments->>'aiAccountId',c.arguments->>'id')=$4)`, s.Endpoint, row["id"], in.Request["kind"], in.TargetID).Scan(&decided)
		if e != nil {
			return nil, e
		}
		if decided {
			return nil, fail("operations_autonomy_human_required")
		}
	}
	definition := operationsai.Definition(in.Permission)
	if definition["autonomous"] != true || definition["humanOnly"] == true {
		return nil, fail("operations_autonomy_human_required")
	}
	if ids := texts(plan["resourceIds"]); len(ids) > 0 && !has(ids, in.TargetID) {
		return nil, fault.New("operations_autonomy_scope_denied", 403)
	}
	lock := " FOR SHARE"
	if persisted {
		lock = ""
	}
	grants, e := many(ctx, tx, `SELECT to_jsonb(g) FROM(SELECT id,version,enabled,executor_kind,mode,ai_account_id,permissions,resource_ids,resource_scope_kind FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[])`+lock+`)g`, s.Endpoint, texts(plan["grantIds"]))
	if e != nil {
		return nil, e
	}
	bindings := obj(cfg["versionBindings"])
	var accepted Object
	for _, g := range grants {
		var frozen Object
		for _, v := range list(bindings["grants"]) {
			r := obj(v)
			if r["id"] == g["id"] {
				frozen = r
				break
			}
		}
		kind := "ai"
		if row["mode"] == "code" {
			kind = "program"
		}
		if frozen == nil || frozen["version"] != g["version"] || g["enabled"] != true || g["executor_kind"] != kind || g["mode"] != "automatic" || row["mode"] != "code" && g["ai_account_id"] != row["ai_account_id"] || !has(texts(g["permissions"]), in.Permission) {
			continue
		}
		scope := perms.AutomationResourceScope(g)
		if scope["kind"] == "selected" && has(texts(scope["resourceIds"]), in.TargetID) {
			accepted = g
			break
		}
		if scope["kind"] == "eligible" && persisted && sourceMatched && p.operation["targetId"] == in.TargetID {
			accepted = g
			break
		}
		if scope["kind"] == "eligible" && s.QualifyTargetWithin != nil && in.Request != nil && in.Command != nil {
			if e = s.QualifyTargetWithin(ctx, tx, a, in.Permission, in.TargetID, in.Request, in.Command, str(g["id"])); e != nil {
				return nil, e
			}
			accepted = g
			break
		}
	}
	if accepted == nil {
		return nil, fault.New("operations_autonomy_authorization_changed", 403)
	}
	if persisted && (in.GrantID == nil || *in.GrantID != accepted["id"] || in.GrantVersion == nil || *in.GrantVersion != num(accepted["version"])) {
		return nil, fault.New("operations_autonomy_authorization_changed", 403)
	}
	if len(texts(plan["strategyIds"])) == 0 {
		return nil, fail("operations_autonomy_human_required")
	}
	head, e := optional(ctx, tx, `SELECT to_jsonb(h) FROM operations_p13_strategy_heads_v1 h WHERE endpoint=$1`+lock, s.Endpoint)
	if e != nil {
		return nil, e
	}
	pinned := bindings["strategyVersionId"]
	if head == nil || head["paused"] == true || pinned == nil || has(texts(head["blocked_version_ids"]), str(pinned)) {
		return nil, fail("operations_autonomy_strategy_stopped")
	}
	current, e := optional(ctx, tx, `SELECT to_jsonb(v) FROM(SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2)v`, s.Endpoint, head["active_id"])
	if e != nil {
		return nil, e
	}
	currentCfg := obj(current["configuration"])
	if obj(currentCfg["common"])["automationEnabled"] != true {
		return nil, fail("operations_autonomy_strategy_stopped")
	}
	original, e := optional(ctx, tx, `SELECT to_jsonb(v) FROM(SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2)v`, s.Endpoint, pinned)
	if e != nil {
		return nil, e
	}
	var strategy Object
	for _, v := range list(obj(original["configuration"])["strategies"]) {
		r := obj(v)
		if !has(texts(plan["strategyIds"]), str(r["id"])) || r["enabled"] != true {
			continue
		}
		live := false
		for _, v := range list(currentCfg["strategies"]) {
			c := obj(v)
			live = live || c["id"] == r["id"] && c["enabled"] == true && c["mode"] != "human-led"
		}
		if !live {
			continue
		}
		if r["template"] == "selected-public-content-visibility" && has([]string{"content.hide", "content.restore"}, in.Permission) || r["template"] == "business-action" && has(texts(obj(r["execution"])["actions"]), in.Permission) {
			strategy = r
			break
		}
	}
	if strategy == nil || !has([]string{"ai-autonomous", "code-automatic"}, str(strategy["mode"])) {
		return nil, fail("operations_autonomy_human_required")
	}
	enabled := false
	for _, v := range list(currentCfg["domains"]) {
		d := obj(v)
		enabled = enabled || d["key"] == strategy["domain"] && d["executionEnabled"] == true
	}
	if !enabled {
		return nil, fail("operations_autonomy_strategy_stopped")
	}
	execution := obj(strategy["execution"])
	scope := obj(execution["resourceScope"])
	if scope["kind"] == "unresolved" || scope["kind"] == "selected" && !has(texts(scope["resourceIds"]), in.TargetID) {
		return nil, fail("operations_autonomy_human_required")
	}
	if execution["requiredRehearsal"] == true {
		var rehearsed bool
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_p13_strategy_rehearsals_v1 WHERE endpoint=$1 AND version_id=$2 AND result->>'valid'='true' AND NOT (COALESCE(result->'uncoveredStrategyIds','[]'::jsonb) ? $3))`, s.Endpoint, pinned, strategy["id"]).Scan(&rehearsed)
		if e != nil {
			return nil, e
		}
		if !rehearsed {
			return nil, fail("operations_autonomy_human_required")
		}
	}
	if strategy["condition"] != nil {
		if in.Command == nil {
			if in.BusinessAction != nil {
				return nil, fail("operations_autonomy_human_required")
			}
		} else if strategy["template"] == "selected-public-content-visibility" && str(in.Request["targetKind"]) != "" && s.CurrentPublicSourceWithin != nil {
			source, e := s.CurrentPublicSourceWithin(ctx, tx, str(in.Request["targetKind"]), in.TargetID)
			if e != nil {
				return nil, e
			}
			if source["available"] != true {
				return nil, fail("operations_autonomy_source_unavailable")
			}
			payload := obj(source["payload"])
			text := str(payload["body"])
			if payload["body"] == nil {
				text = str(payload["text"])
			}
			target := "forum-reply"
			if in.Request["targetKind"] == "post" {
				target = "forum-post"
			}
			policy := Object{"schema": "business-controls/1", "features": Object{"forumPost": true, "forumReply": true, "chatSend": true, "attachmentUpload": true}, "lists": []any{}, "rules": []any{Object{"id": strategy["id"], "name": "当前策略条件", "enabled": true, "targets": []any{target}, "conditions": strategy["condition"], "action": "reject", "exceptions": []any{}}}}
			result, e := businessrules.Evaluate(policy, target, "", Object{"attachmentCount": len(list(payload["attachments"]))}, &text, list(payload["links"]))
			if e != nil {
				return nil, e
			}
			if !has(result.Matched, str(strategy["id"])) {
				return nil, fail("operations_autonomy_condition_not_met")
			}
		} else {
			return nil, fail("operations_autonomy_human_required")
		}
	}
	if persisted && (in.StrategyID == nil || *in.StrategyID != strategy["id"] || in.StrategyVersionID == nil || *in.StrategyVersionID != pinned) {
		return nil, fail("operations_autonomy_strategy_stopped")
	}
	return Object{"allowed": true, "grantId": accepted["id"], "grantVersion": accepted["version"], "strategyId": strategy["id"], "strategyVersionId": pinned}, nil
}
func (s *Service) BindDutyOperationWithin(ctx context.Context, tx pgx.Tx, a Actor, in DutyOperation) (Actor, error) {
	p, e := s.proof(a)
	if e != nil || p.recovery || in.Permission == "" || in.OperationID == "" {
		return Actor{}, dutyFail("operations_ai_duty_operation_denied")
	}
	current, e := s.RequireDutyAction(ctx, tx, a, in.Permission, "execution")
	if e != nil {
		return Actor{}, e
	}
	definition := operationsai.Definition(in.Permission)
	if definition["autonomous"] != true || definition["humanOnly"] == true {
		return Actor{}, fail("operations_agentos_human_review_required")
	}
	p, _ = s.proof(current)
	authorization, e := s.authorizeOperationWithin(ctx, tx, current, p, in, false, false)
	if e != nil {
		return Actor{}, e
	}
	copy := *p
	copy.operation = operationObject(in)
	for _, k := range []string{"grantId", "grantVersion", "strategyId", "strategyVersionId"} {
		if v, ok := authorization[k]; ok {
			copy.operation[k] = v
		}
	}
	return s.currentDuty(ctx, tx, &copy)
}
func (s *Service) RequireDutyOperation(ctx context.Context, tx pgx.Tx, a Actor, required []string, selection Object, action *string) (Actor, error) {
	p, e := s.proof(a)
	if e != nil {
		return Actor{}, e
	}
	bound := p.operation
	if bound == nil || p.input.AccessPurpose != "execution" {
		return Actor{}, dutyFail("operations_ai_duty_operation_denied")
	}
	for _, c := range required {
		if c != bound["permission"] {
			return Actor{}, dutyFail("operations_ai_duty_operation_denied")
		}
	}
	batch := obj(bound["request"])["kind"] == "public-content-batch"
	id := selection["id"]
	for _, k := range []string{"resourceId", "accountId", "planId"} {
		if id == nil {
			id = selection[k]
		}
	}
	if id == nil && batch {
		items := list(selection["items"])
		if len(items) > 0 {
			id = obj(items[0])["id"]
		}
	}
	if str(bound["targetId"]) != "" && id != bound["targetId"] || selection["operationId"] != nil && selection["operationId"] != bound["operationId"] {
		return Actor{}, dutyFail("operations_ai_duty_operation_denied")
	}
	command := obj(selection["command"])
	if command == nil {
		command = selection
	}
	for k, v := range obj(bound["command"]) {
		if chosen, ok := command[k]; ok && !sameValue(chosen, v) {
			return Actor{}, dutyFail("operations_ai_duty_operation_denied")
		}
	}
	if bound["permission"] == "feedback.update" {
		if hash, ok := selection["noteHash"]; ok {
			var expected any
			if note := str(obj(bound["command"])["note"]); note != "" {
				expected = identity.Digest([]byte(note))
			}
			if hash != expected {
				return Actor{}, dutyFail("operations_ai_duty_operation_denied")
			}
		}
	}
	if batch && !sameValue(selection["items"], obj(bound["command"])["items"]) {
		return Actor{}, dutyFail("operations_ai_duty_operation_denied")
	}
	fresh, e := s.RequireDutyAction(ctx, tx, a, str(bound["permission"]), "")
	if e != nil {
		return Actor{}, e
	}
	in := objectOperation(bound)
	in.BusinessAction = action
	if _, e = s.authorizeOperationWithin(ctx, tx, fresh, p, in, p.continuation, p.continuation); e != nil {
		return Actor{}, e
	}
	return fresh, nil
}
func sameValue(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
