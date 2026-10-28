package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"time"
)

func strategyTaskConfig(cfg, strategy, version Object) (Object, error) {
	execution := obj(strategy["execution"])
	scope := obj(execution["resourceScope"])
	if execution == nil || scope == nil || scope["kind"] == "unresolved" || scope["kind"] == "selected" && len(texts(scope["resourceIds"])) == 0 {
		return nil, fail("operations_autonomy_strategy_not_ready")
	}
	out := obj(clone(cfg))
	configuration := obj(out["configuration"])
	out["plan_version"] = version["version"]
	configuration["mode"] = execution["mode"]
	configuration["purpose"] = "operations-" + str(strategy["domain"])
	if strategy["objective"] != nil {
		configuration["goal"] = strategy["objective"]
	}
	ids := []string{}
	if scope["kind"] == "selected" {
		ids = texts(scope["resourceIds"])
	}
	configuration["plan"] = Object{"strategyIds": []string{str(strategy["id"])}, "grantIds": execution["grantIds"], "actions": execution["actions"], "resourceIds": ids, "eventTypes": texts(obj(execution["trigger"])["eventTypes"])}
	configuration["strategyExecution"] = clone(execution)
	return out, nil
}
func (s *Service) CreateStrategyTask(ctx context.Context, a Actor, input Object, authorize Authorize) (Object, error) {
	if !closed(input, []string{"operationId", "strategyId", "expectedStrategyVersion"}, nil) || !schemaUUID.MatchString(str(input["operationId"])) || !schemaUUID.MatchString(str(input["strategyId"])) || !integer(input["expectedStrategyVersion"], 1, 9007199254740991) {
		return nil, invalid()
	}
	x := obj(clone(input))
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.control", authorize)
		if e != nil {
			return nil, e
		}
		if _, e = s.actor(ctx, tx, actor, "strategies.run", nil); e != nil {
			return nil, e
		}
		prior, e := s.previousWithin(ctx, tx, actor, str(x["operationId"]), "strategy-task", x)
		if e != nil || prior != nil {
			return prior, e
		}
		if e = s.EnsureWithin(ctx, tx); e != nil {
			return nil, e
		}
		head, e := optional(ctx, tx, `SELECT to_jsonb(h) FROM operations_p13_strategy_heads_v1 h WHERE endpoint=$1 FOR SHARE`, s.Endpoint)
		if e != nil {
			return nil, e
		}
		var version Object
		if head["active_id"] != nil {
			version, e = optional(ctx, tx, `SELECT to_jsonb(v) FROM operations_p13_strategy_versions_v1 v WHERE endpoint=$1 AND id=$2`, s.Endpoint, head["active_id"])
			if e != nil {
				return nil, e
			}
		}
		var strategy Object
		for _, v := range list(obj(version["configuration"])["strategies"]) {
			r := obj(v)
			if r["id"] == x["strategyId"] {
				strategy = r
				break
			}
		}
		if strategy == nil || strategy["enabled"] != true || num(version["version"]) != num(x["expectedStrategyVersion"]) || head["paused"] == true {
			return nil, fail("operations_autonomy_strategy_changed")
		}
		domain := str(obj(strategy["execution"])["aiDomain"])
		if domain == "" {
			domain = str(strategy["domain"])
		}
		base, e := s.configWithin(ctx, tx, domain, "")
		if e != nil {
			return nil, e
		}
		cfg, e := strategyTaskConfig(base, strategy, version)
		if e != nil {
			return nil, e
		}
		title := str(strategy["name"])
		task, e := s.createTaskWithin(ctx, tx, cfg, TaskInput{ID: str(x["operationId"]), Source: "workbench", Key: "strategy:" + str(x["operationId"]), Title: &title})
		if e != nil {
			return nil, e
		}
		snapshot := obj(task["configuration"])
		snapshot["externalWorkbench"] = Object{"operatorId": actor.ID, "strategyId": strategy["id"]}
		saved, e := one(ctx, tx, `UPDATE operations_autonomy_tasks_v1 SET mode='human-ai',configuration=$3,state='waiting-human',human_decision=$4,code='specific-human-action-required' WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_autonomy_tasks_v1)`, s.Endpoint, task["id"], jsonText(snapshot), jsonText(Object{"kind": "specific-action", "operatorId": actor.ID, "at": s.now().UTC().Format("2006-01-02T15:04:05.000Z")}))
		if e != nil {
			return nil, e
		}
		view, e := s.taskViewWithin(ctx, tx, saved, actor, true, true)
		if e != nil {
			return nil, e
		}
		return s.recordWithin(ctx, tx, actor, str(x["operationId"]), "strategy-task", x, Object{"operationId": x["operationId"], "task": view, "replayed": false})
	})
}
func (s *Service) scheduleStrategiesWithin(ctx context.Context, tx pgx.Tx, configs []Object) error {
	head, e := optional(ctx, tx, `SELECT to_jsonb(h) FROM operations_p13_strategy_heads_v1 h WHERE endpoint=$1`, s.Endpoint)
	if e != nil {
		return e
	}
	if head["active_id"] == nil || head["paused"] == true {
		return nil
	}
	version, e := optional(ctx, tx, `SELECT to_jsonb(v) FROM operations_p13_strategy_versions_v1 v WHERE endpoint=$1 AND id=$2`, s.Endpoint, head["active_id"])
	if e != nil {
		return e
	}
	configuration := obj(version["configuration"])
	if obj(configuration["common"])["automationEnabled"] != true {
		return nil
	}
	for _, v := range list(configuration["strategies"]) {
		strategy := obj(v)
		execution := obj(strategy["execution"])
		scope := obj(execution["resourceScope"])
		trigger := obj(execution["trigger"])
		if strategy["enabled"] != true || execution == nil || scope == nil || scope["kind"] == "unresolved" || scope["kind"] == "selected" && len(texts(scope["resourceIds"])) == 0 || trigger["kind"] == "manual" {
			continue
		}
		enabled := false
		for _, v := range list(configuration["domains"]) {
			d := obj(v)
			enabled = enabled || d["key"] == strategy["domain"] && d["executionEnabled"] == true
		}
		if !enabled {
			continue
		}
		var base Object
		for _, r := range configs {
			if r["domain"] == execution["aiDomain"] {
				base = r
				break
			}
		}
		if base["enabled"] != true {
			continue
		}
		var busy bool
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND domain=$2 AND source<>'workbench' AND state IN ('queued','running','unknown'))`, s.Endpoint, base["domain"]).Scan(&busy); e != nil {
			return e
		}
		if busy {
			continue
		}
		cfg, e := strategyTaskConfig(base, strategy, version)
		if e != nil {
			return e
		}
		title := str(strategy["name"])
		if trigger["kind"] == "event" {
			events, e := many(ctx, tx, `SELECT to_jsonb(e) FROM operations_autonomy_events_v1 e WHERE e.endpoint=$1 AND e.available_at<=$2 AND e.event_type=ANY($3::text[]) AND NOT EXISTS(SELECT 1 FROM operations_autonomy_event_consumers_v1 c WHERE c.endpoint=e.endpoint AND c.event_id=e.id AND c.strategy_id=$4) ORDER BY e.created_at,e.id LIMIT 100 FOR UPDATE OF e`, s.Endpoint, s.now(), texts(trigger["eventTypes"]), strategy["id"])
			if e != nil {
				return e
			}
			if len(events) == 0 {
				continue
			}
			same := true
			ids := []string{}
			for _, r := range events {
				same = same && r["target_type"] == events[0]["target_type"] && r["target_id"] == events[0]["target_id"]
				ids = append(ids, str(r["id"]))
			}
			var targetType, targetID *string
			if same {
				targetType, targetID = ptr(events[0]["target_type"]), ptr(events[0]["target_id"])
			}
			task, e := s.createTaskWithin(ctx, tx, cfg, TaskInput{Source: "event", Key: "strategy-event:" + str(strategy["id"]) + ":" + str(events[0]["id"]), Title: &title, EventIDs: ids, TargetType: targetType, TargetID: targetID})
			if e != nil {
				return e
			}
			if task != nil {
				for _, event := range events {
					if _, e = tx.Exec(ctx, `INSERT INTO operations_autonomy_event_consumers_v1(endpoint,event_id,strategy_id,task_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, s.Endpoint, event["id"], strategy["id"], task["id"]); e != nil {
						return e
					}
				}
			}
		} else {
			schedule := Object{"kind": "daily", "at": trigger["at"], "timezone": "Asia/Shanghai"}
			if trigger["kind"] == "interval" {
				schedule = Object{"kind": "interval", "minutes": trigger["minutes"], "timezone": "Asia/Shanghai"}
			}
			if schedule["kind"] == "interval" && num(schedule["minutes"]) == 0 || schedule["kind"] == "daily" && str(schedule["at"]) == "" {
				continue
			}
			clock, e := optional(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_strategy_schedules_v1 c WHERE endpoint=$1 AND strategy_id=$2 FOR UPDATE`, s.Endpoint, strategy["id"])
			if e != nil {
				return e
			}
			if clock == nil || clock["version_id"] != version["id"] {
				next, e := NextDue(schedule, s.now())
				if e != nil {
					return e
				}
				clock, e = one(ctx, tx, `INSERT INTO operations_autonomy_strategy_schedules_v1(endpoint,strategy_id,version_id,next_due_at) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint,strategy_id) DO UPDATE SET version_id=EXCLUDED.version_id,next_due_at=EXCLUDED.next_due_at RETURNING to_jsonb(operations_autonomy_strategy_schedules_v1)`, s.Endpoint, strategy["id"], version["id"], next)
				if e != nil {
					return e
				}
			}
			due, e := time.Parse(time.RFC3339Nano, str(clock["next_due_at"]))
			if e != nil {
				return e
			}
			if due.After(s.now()) {
				continue
			}
			if _, e = s.createTaskWithin(ctx, tx, cfg, TaskInput{Source: "routine", Key: "strategy-due:" + str(strategy["id"]) + ":" + str(iso(clock["next_due_at"])), Title: &title, Due: &due}); e != nil {
				return e
			}
			next, e := NextDue(schedule, s.now())
			if e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_strategy_schedules_v1 SET next_due_at=$3 WHERE endpoint=$1 AND strategy_id=$2`, s.Endpoint, strategy["id"], next); e != nil {
				return e
			}
		}
	}
	return nil
}
