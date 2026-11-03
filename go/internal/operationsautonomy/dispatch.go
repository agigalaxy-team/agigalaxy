package operationsautonomy

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"time"
)

// Dispatch is a user-owned work request, independent of a position's routine
// configuration. Goals are data, not system prompts or new authority.
func parseDispatch(input Object) (Object, error) {
	if !closed(input, []string{"kind", "targetDomain", "title", "goal", "trigger", "startNow"}, []string{"mode", "actions", "grantIds", "resourceIds", "strategyIds"}) || input["kind"] != "task-dispatch" || !has(domains, str(input["targetDomain"])) {
		return nil, invalid()
	}
	x := obj(clone(input))
	for k, b := range map[string][2]int{"title": {1, 160}, "goal": {1, 4000}} {
		v, ok := text(x[k], b[0], b[1], true)
		if !ok {
			return nil, invalid()
		}
		x[k] = v
	}
	if _, ok := x["startNow"].(bool); !ok {
		return nil, invalid()
	}
	if x["mode"] == nil {
		x["mode"] = "ai-human"
	}
	if !has([]string{"ai", "ai-human"}, str(x["mode"])) {
		return nil, invalid()
	}
	t := obj(x["trigger"])
	if !closed(t, []string{"kind"}, []string{"minutes", "at", "eventTypes"}) {
		return nil, invalid()
	}
	switch t["kind"] {
	case "once":
		if len(t) != 1 {
			return nil, invalid()
		}
		if x["startNow"] != true {
			return nil, invalid()
		}
	case "interval":
		// Bound only by time.Duration representation, not a business period.
		if len(t) != 2 || !integer(t["minutes"], 1, int64(time.Duration(1<<63-1)/time.Minute)) {
			return nil, invalid()
		}
	case "daily":
		if len(t) != 2 || !clockPattern.MatchString(str(t["at"])) {
			return nil, invalid()
		}
	case "event":
		if len(t) != 2 || len(texts(t["eventTypes"])) == 0 {
			return nil, invalid()
		}
		for _, v := range texts(t["eventTypes"]) {
			if !safeCode.MatchString(v) {
				return nil, invalid()
			}
		}
	default:
		return nil, invalid()
	}
	for _, k := range []string{"actions", "grantIds", "resourceIds", "strategyIds"} {
		if x[k] == nil {
			x[k] = []any{}
		}
		values, ok := x[k].([]any)
		if !ok {
			return nil, invalid()
		}
		for _, v := range values {
			if k == "actions" {
				if !safeCode.MatchString(str(v)) {
					return nil, invalid()
				}
			} else if !schemaUUID.MatchString(str(v)) {
				return nil, invalid()
			}
		}
	}
	return x, nil
}

func dispatchConfiguration(base, x Object) Object {
	cfg := obj(clone(obj(base["configuration"])))
	cfg["goal"], cfg["mode"], cfg["purpose"] = x["goal"], x["mode"], "operations-"+str(x["targetDomain"])
	// A new request never inherits unrelated actions or grants from routine duty.
	cfg["plan"] = Object{"strategyIds": x["strategyIds"], "actions": x["actions"], "grantIds": x["grantIds"], "resourceIds": x["resourceIds"], "eventTypes": []any{}}
	schedule := Object{"kind": "interval", "minutes": 1, "timezone": "Asia/Shanghai"}
	trigger := obj(x["trigger"])
	if has([]string{"interval", "daily"}, str(trigger["kind"])) {
		schedule = obj(clone(trigger))
		schedule["timezone"] = "Asia/Shanghai"
	}
	cfg["schedule"] = schedule
	return cfg
}

func (s *Service) dispatchOwner(ctx context.Context, tx pgx.Tx, a Actor, source, target string) (Actor, error) {
	if s.Permissions == nil {
		return Actor{}, fail("operations_autonomy_unavailable")
	}
	human, e := s.Permissions.TaskOwnerWithin(ctx, tx, a, source)
	if e != nil {
		return Actor{}, e
	}
	return s.actor(ctx, tx, human, "ai.use."+target, nil)
}

func (s *Service) PrepareDispatch(ctx context.Context, a Actor, source string, input Object, operationID string) (Object, error) {
	if s.EnqueueWithin == nil {
		return nil, fault.New("operations_autonomy_unavailable", 503)
	}
	x, e := parseDispatch(input)
	if e != nil {
		return nil, e
	}
	runtime := s.runtime(ctx)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		_, e := s.dispatchOwner(ctx, tx, a, source, str(x["targetDomain"]))
		if e != nil {
			return nil, e
		}
		base, e := s.configWithin(ctx, tx, str(x["targetDomain"]), "")
		if e != nil {
			return nil, e
		}
		role, e := s.AIWork.AuthorizationWithin(ctx, tx, str(x["targetDomain"]), nil)
		if e != nil {
			return nil, e
		}
		candidate := obj(clone(base))
		candidate["configuration"] = dispatchConfiguration(base, x)
		ready, e := s.readinessWithin(ctx, tx, candidate, runtime)
		if e != nil {
			return nil, e
		}
		if ready["ready"] != true {
			return nil, fail("operations_autonomy_not_ready")
		}
		command := Object{"request": x, "aiAccountId": role.AccountID}
		label := map[string]string{"overview": "总控", "governance": "治理", "messaging": "消息", "discovery": "数据与发现", "maintenance": "运维"}[str(x["targetDomain"])]
		trigger := obj(x["trigger"])
		frequency := "执行一次"
		switch trigger["kind"] {
		case "interval":
			frequency = fmt.Sprintf("每 %d 分钟", num(trigger["minutes"]))
		case "daily":
			frequency = "每天 " + str(trigger["at"]) + "（上海时间）"
		case "event":
			frequency = "相关事件发生时"
		}
		return Object{"schemaVersion": 1, "kind": "task-dispatch", "domain": source, "request": x, "command": command, "requiredAction": "autonomy.control", "target": Object{"kind": "ai-work-account", "id": role.AccountID, "label": label}, "title": x["title"], "impact": []any{"交办岗位：" + label, "执行安排：" + frequency, "工作目标：" + str(x["goal"]), "首次执行：" + map[bool]string{true: "确认后开始", false: "等待触发"}[x["startNow"] == true]}, "basis": []any{"目标岗位现有角色与已选择的正式授权"}, "checkedAt": s.now().Unix(), "readExpiresAt": s.now().Unix() + 30, "decisionSource": "human-required"}, nil
	})
}

func (s *Service) ConfirmDispatch(ctx context.Context, a Actor, source string, proposal Object, operationID string, authorize Authorize) (Object, error) {
	if s.EnqueueWithin == nil {
		return nil, fault.New("operations_autonomy_unavailable", 503)
	}
	x, e := parseDispatch(obj(proposal["request"]))
	if e != nil {
		return nil, e
	}
	if !schemaUUID.MatchString(operationID) || proposal["kind"] != "task-dispatch" || !sameValue(obj(proposal["command"])["request"], x) {
		return nil, invalid()
	}
	runtime := s.runtime(ctx)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.control", authorize)
		if e != nil {
			return nil, e
		}
		actor, e = s.dispatchOwner(ctx, tx, actor, source, str(x["targetDomain"]))
		if e != nil {
			return nil, e
		}
		intent := Object{"sourceDomain": source, "request": x, "aiAccountId": obj(proposal["command"])["aiAccountId"]}
		if prior, e := s.previousWithin(ctx, tx, actor, operationID, "dispatch", intent); e != nil || prior != nil {
			return prior, e
		}
		base, e := s.configWithin(ctx, tx, str(x["targetDomain"]), " FOR SHARE")
		if e != nil {
			return nil, e
		}
		role, e := s.AIWork.AuthorizationWithin(ctx, tx, str(x["targetDomain"]), nil)
		if e != nil {
			return nil, e
		}
		if role.AccountID != intent["aiAccountId"] {
			return nil, fail("operations_autonomy_revision_changed")
		}
		cfg := dispatchConfiguration(base, x)
		candidate := obj(clone(base))
		candidate["configuration"] = cfg
		ready, e := s.readinessWithin(ctx, tx, candidate, runtime)
		if e != nil {
			return nil, e
		}
		if ready["ready"] != true {
			return nil, fail("operations_autonomy_not_ready")
		}
		var next any
		if x["startNow"] == true {
			next = s.now()
		} else if has([]string{"interval", "daily"}, str(obj(x["trigger"])["kind"])) {
			next, e = NextDue(obj(cfg["schedule"]), s.now())
			if e != nil {
				return nil, e
			}
		}
		assignment, e := one(ctx, tx, `INSERT INTO operations_autonomy_dispatches_v1(id,endpoint,operator_id,domain,ai_account_id,title,configuration,next_due_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING to_jsonb(operations_autonomy_dispatches_v1)`, operationID, s.Endpoint, actor.ID, x["targetDomain"], role.AccountID, x["title"], jsonText(x), next, s.now())
		if e != nil {
			return nil, e
		}
		var task Object
		if x["startNow"] == true {
			task, e = s.createDispatchTaskWithin(ctx, tx, base, assignment, nil)
			if e != nil {
				return nil, e
			}
			if e = s.advanceDispatchWithin(ctx, tx, assignment); e != nil {
				return nil, e
			}
		}
		result := Object{"operationId": operationID, "state": "completed", "summary": "任务已交办，已进入服务端调度。", "receipt": Object{"dispatchId": operationID, "taskId": task["id"], "scheduled": true}, "effectExecuted": true, "dispatchId": operationID, "dispatch": Object{"id": operationID, "revision": 1}, "targetDomain": x["targetDomain"], "enabled": true, "taskId": task["id"]}
		if x["startNow"] != true {
			result["summary"] = "任务已交办，等待计划触发。"
		}
		return s.recordWithin(ctx, tx, actor, operationID, "dispatch", intent, result)
	})
}

func (s *Service) RecoverDispatch(ctx context.Context, a Actor, source string, proposal Object, operationID string) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.dispatchOwner(ctx, tx, a, source, str(obj(proposal["request"])["targetDomain"]))
		if e != nil {
			return nil, e
		}
		row, e := optional(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_commands_v1 c WHERE endpoint=$1 AND operation_id=$2 AND kind='dispatch' AND operator_id=$3`, s.Endpoint, operationID, actor.ID)
		if e != nil || row == nil {
			return nil, e
		}
		intent := obj(row["input"])
		if !sameValue(intent["request"], proposal["request"]) {
			return nil, fail("operations_autonomy_revision_changed")
		}
		return obj(row["result"]), nil
	})
}

func (s *Service) ReadDispatch(ctx context.Context, a Actor, source string, args Object) (Object, error) {
	if !closed(args, []string{"dispatchId"}, nil) || !schemaUUID.MatchString(str(args["dispatchId"])) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		owner, e := s.Permissions.TaskOwnerWithin(ctx, tx, a, source)
		if e != nil {
			return nil, e
		}
		d, e := optional(ctx, tx, `SELECT to_jsonb(d) FROM operations_autonomy_dispatches_v1 d WHERE endpoint=$1 AND id=$2 AND operator_id=$3`, s.Endpoint, args["dispatchId"], owner.ID)
		if e != nil {
			return nil, e
		}
		if d == nil {
			return nil, fail("operations_autonomy_task_not_found")
		}
		if _, e = s.actor(ctx, tx, owner, "ai.use."+str(d["domain"]), nil); e != nil {
			return nil, e
		}
		// Task metadata is not a route to another position's business materials.
		latest, e := optional(ctx, tx, `SELECT to_jsonb(t) FROM (SELECT id,state,model_state,business_state,created_at,completed_at,code FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND configuration ? 'dispatch' AND configuration->'dispatch'->>'id'=$2 ORDER BY created_at DESC,id DESC LIMIT 1)t`, s.Endpoint, str(d["id"]))
		if e != nil {
			return nil, e
		}
		return s.stamp(Object{"dispatchId": d["id"], "title": d["title"], "targetDomain": d["domain"], "enabled": d["enabled"], "trigger": obj(d["configuration"])["trigger"], "nextDueAt": iso(d["next_due_at"]), "latestTask": latest, "effectExecuted": false}), nil
	})
}

func (s *Service) createDispatchTaskWithin(ctx context.Context, tx pgx.Tx, base, assignment, event Object) (Object, error) {
	x := obj(assignment["configuration"])
	cfg := obj(clone(base))
	cfg["configuration"] = dispatchConfiguration(base, x)
	cfg["enabled"] = true
	obj(cfg["configuration"])["dispatch"] = Object{"id": assignment["id"], "revision": assignment["revision"], "operatorId": assignment["operator_id"]}
	title := str(assignment["title"])
	key := "dispatch:" + str(assignment["id"]) + ":" + str(assignment["next_due_at"])
	in := TaskInput{Source: "routine", Key: key, Title: &title}
	if event != nil {
		in.Source = "event"
		in.Key = "dispatch:" + str(assignment["id"]) + ":event:" + str(event["id"])
		in.EventIDs = []string{str(event["id"])}
	}
	return s.createTaskWithin(ctx, tx, cfg, in)
}

func (s *Service) advanceDispatchWithin(ctx context.Context, tx pgx.Tx, assignment Object) error {
	x := obj(assignment["configuration"])
	trigger := obj(x["trigger"])
	var next any
	if has([]string{"interval", "daily"}, str(trigger["kind"])) {
		schedule := obj(clone(trigger))
		schedule["timezone"] = "Asia/Shanghai"
		v, e := NextDue(schedule, s.now())
		if e != nil {
			return e
		}
		next = v
	}
	_, e := tx.Exec(ctx, `UPDATE operations_autonomy_dispatches_v1 SET next_due_at=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, assignment["id"], next, s.now())
	return e
}

// Every task uses its own plan switch. Disabling routine duty neither cancels
// an independent assignment nor silently grants it the routine's scope.
func (s *Service) taskConfigWithin(ctx context.Context, tx pgx.Tx, task Object, lock string) (Object, error) {
	cfg, e := s.configWithin(ctx, tx, str(task["domain"]), lock)
	if e != nil {
		return nil, e
	}
	dispatch := obj(obj(task["configuration"])["dispatch"])
	if dispatch == nil {
		return cfg, nil
	}
	row, e := optional(ctx, tx, `SELECT to_jsonb(d) FROM operations_autonomy_dispatches_v1 d WHERE endpoint=$1 AND id=$2 FOR SHARE`, s.Endpoint, dispatch["id"])
	if e != nil {
		return nil, e
	}
	cfg["enabled"] = row != nil && row["enabled"] == true && row["domain"] == task["domain"] && row["ai_account_id"] == task["ai_account_id"]
	return cfg, nil
}

func (s *Service) scheduleDispatchesWithin(ctx context.Context, tx pgx.Tx) error {
	rows, e := many(ctx, tx, `SELECT to_jsonb(d) FROM operations_autonomy_dispatches_v1 d WHERE endpoint=$1 AND enabled ORDER BY next_due_at NULLS LAST,created_at FOR UPDATE`, s.Endpoint)
	if e != nil {
		return e
	}
	for _, d := range rows {
		var busy bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND domain=$2 AND source<>'workbench' AND state IN ('queued','running','unknown'))`, s.Endpoint, d["domain"]).Scan(&busy); e != nil {
			return e
		}
		if busy {
			continue
		}
		base, e := s.configWithin(ctx, tx, str(d["domain"]), "")
		if e != nil {
			return e
		}
		if due, err := time.Parse(time.RFC3339Nano, str(d["next_due_at"])); err == nil && !due.After(s.now()) {
			if _, e = s.createDispatchTaskWithin(ctx, tx, base, d, nil); e != nil {
				return e
			}
			if e = s.advanceDispatchWithin(ctx, tx, d); e != nil {
				return e
			}
			continue
		}
		trigger := obj(obj(d["configuration"])["trigger"])
		if trigger["kind"] != "event" {
			continue
		}
		event, e := optional(ctx, tx, `SELECT to_jsonb(e) FROM operations_autonomy_events_v1 e WHERE e.endpoint=$1 AND e.event_type=ANY($2::text[]) AND e.available_at<=$3 AND e.created_at>=$4 AND NOT EXISTS(SELECT 1 FROM operations_autonomy_tasks_v1 t WHERE t.endpoint=e.endpoint AND t.source_key='dispatch:'||$5::text||':event:'||e.id::text) ORDER BY e.created_at,e.id LIMIT 1`, s.Endpoint, texts(trigger["eventTypes"]), s.now(), d["created_at"], d["id"])
		if e != nil {
			return e
		}
		if event != nil {
			if _, e = s.createDispatchTaskWithin(ctx, tx, base, d, event); e != nil {
				return e
			}
		}
	}
	return nil
}
