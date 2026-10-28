package operationsautonomy

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func date(v any) time.Time { t, _ := time.Parse(time.RFC3339Nano, str(v)); return t }
func filter(rows []Object, accept func(Object) bool) []Object {
	out := []Object{}
	for _, r := range rows {
		if accept(r) {
			out = append(out, r)
		}
	}
	return out
}
func count(rows []Object, accept func(Object) bool) int { return len(filter(rows, accept)) }
func (s *Service) Overview(ctx context.Context, a Actor, days int) (Object, error) {
	actor, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "autonomy.read", nil) })
	if e != nil {
		return nil, e
	}
	if days < 1 || days > 90 {
		return nil, invalid()
	}
	runtime := s.runtime(ctx)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.actor(ctx, tx, actor, "autonomy.read", nil); e != nil {
			return nil, e
		}
		if e := s.EnsureWithin(ctx, tx); e != nil {
			return nil, e
		}
		until := s.now()
		from := until.Add(-time.Duration(days) * 24 * time.Hour)
		cfgs, e := many(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_configs_v1 c WHERE endpoint=$1 ORDER BY domain`, s.Endpoint)
		if e != nil {
			return nil, e
		}
		health, e := optional(ctx, tx, `SELECT to_jsonb(h) FROM(SELECT checked_at,last_tick_at,started_at FROM operations_autonomy_health_v1 WHERE endpoint=$1)h`, s.Endpoint)
		if e != nil {
			return nil, e
		}
		current, e := many(ctx, tx, `SELECT to_jsonb(t) FROM operations_autonomy_tasks_v1 t WHERE endpoint=$1 AND (created_at>=$2 OR state IN ('running','queued','waiting-human','unknown')) ORDER BY created_at DESC,id DESC LIMIT 1000`, s.Endpoint, from)
		if e != nil {
			return nil, e
		}
		rows := []Object{}
		withheld := []string{}
		withheldDomains := map[string]bool{}
		for _, r := range current {
			if e = s.checkTargetWithin(ctx, tx, actor, r, true); e != nil {
				var f *fault.Error
				if !errors.As(e, &f) || !hasStatus(f.Status) {
					return nil, e
				}
				withheld = append(withheld, str(r["id"]))
				withheldDomains[str(r["domain"])] = true
				continue
			}
			rows = append(rows, r)
		}
		window := filter(rows, func(r Object) bool { return !date(r["created_at"]).Before(from) })
		automatic := filter(window, func(r Object) bool { return r["source"] != "workbench" })
		runtimeNumber := func(row Object, key string) int64 {
			v := obj(obj(row["configuration"])["runtime"])[key]
			if v == nil {
				return s.defaultNumber(key)
			}
			return num(v)
		}
		grace := func(row Object) time.Duration {
			return time.Duration(runtimeNumber(row, "startGraceSeconds")) * time.Second
		}
		measure := func(items []Object) Object {
			return Object{"expected": count(items, func(r Object) bool { return r["source"] == "routine" }), "completed": count(items, func(r Object) bool {
				return r["source"] == "routine" && r["effective_check"] == true && r["state"] == "completed"
			}), "late": count(items, func(r Object) bool {
				start := until
				if r["started_at"] != nil {
					start = date(r["started_at"])
				}
				return r["source"] == "routine" && start.Sub(date(r["due_at"])) > grace(r)
			}), "backlog": count(items, func(r Object) bool { return r["state"] == "queued" }), "waitingHuman": count(items, func(r Object) bool { return r["state"] == "waiting-human" })}
		}
		accounts := []Object{}
		names := map[string]string{"overview": "总控", "governance": "治理", "messaging": "消息", "discovery": "数据与发现", "maintenance": "运维"}
		for _, cfg := range cfgs {
			ready, e := s.readinessWithin(ctx, tx, cfg, runtime)
			if e != nil {
				return nil, e
			}
			items := filter(rows, func(r Object) bool { return r["domain"] == cfg["domain"] && r["source"] != "workbench" })
			m := measure(items)
			withheldDomain := withheldDomains[str(cfg["domain"])]
			if withheldDomain || len(current) == 1000 {
				for k := range m {
					m[k] = nil
				}
			}
			alive := health != nil && until.Sub(date(health["checked_at"])) <= time.Duration(s.defaultNumber("healthSeconds")+s.defaultNumber("startGraceSeconds"))*time.Second
			overdue := false
			for _, r := range items {
				overdue = overdue || has([]string{"unknown", "failed", "waiting-human"}, str(r["state"])) || r["state"] == "queued" && until.Sub(date(r["due_at"])) > grace(r) || r["state"] == "running" && r["started_at"] != nil && until.Sub(date(r["started_at"])) > time.Duration(runtimeNumber(r, "roundSeconds"))*time.Second
			}
			schedule := obj(obj(cfg["configuration"])["schedule"])
			interval := num(schedule["minutes"]) * 60
			if schedule["kind"] == "daily" {
				interval = 86400
			}
			stale := cfg["last_valid_at"] != nil && until.Sub(date(cfg["last_valid_at"])) > time.Duration(interval+s.defaultNumber("startGraceSeconds")+s.defaultNumber("roundSeconds"))*time.Second
			state := "pending"
			switch {
			case cfg["enabled"] != true:
				state = "pending"
			case !alive:
				state = "unavailable"
			case ready["ready"] != true:
				state = "blocked"
			case withheldDomain || len(current) == 1000:
				state = "unknown"
			case overdue || stale:
				state = "attention"
			case cfg["last_valid_at"] != nil:
				state = "healthy"
			}
			account := obj(ready["account"])
			name := account["name"]
			if name == nil {
				name = names[str(cfg["domain"])]
			}
			config := present(cfg)
			delete(config, "lastValidAt")
			delete(config, "updatedAt")
			out := Object{"id": account["id"], "domain": cfg["domain"], "name": name, "enabled": cfg["enabled"], "configRevision": cfg["revision"], "readiness": Object{"ready": ready["ready"], "reasons": ready["reasons"]}, "health": state, "lastValidAt": iso(cfg["last_valid_at"]), "nextDueAt": iso(cfg["next_due_at"]), "config": config}
			for k, v := range m {
				out[k] = v
			}
			accounts = append(accounts, out)
		}
		ids := []string{}
		for _, r := range rows {
			ids = append(ids, str(r["id"]))
		}
		receipts, e := many(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT task_id,state,basis,created_at FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND created_at>=$2 AND task_id=ANY($3::uuid[]))r`, s.Endpoint, from, ids)
		if e != nil {
			return nil, e
		}
		automaticIDs := map[string]bool{}
		for _, r := range automatic {
			automaticIDs[str(r["id"])] = true
		}
		uniqueCompleted := func(rows []Object, automaticOnly bool) int {
			seen := map[string]bool{}
			for _, r := range rows {
				if r["state"] == "completed" && (!automaticOnly || automaticIDs[str(r["task_id"])] && r["basis"] != "workbench-original-domain-receipt") {
					seen[str(r["task_id"])] = true
				}
			}
			return len(seen)
		}
		m := measure(automatic)
		summary := Object{"enabledAccounts": count(accounts, func(r Object) bool { return r["enabled"] == true }), "healthyAccounts": count(accounts, func(r Object) bool { return r["health"] == "healthy" }), "active": count(rows, func(r Object) bool { return r["state"] == "running" }), "queued": count(rows, func(r Object) bool { return r["state"] == "queued" }), "waitingHuman": count(rows, func(r Object) bool { return r["state"] == "waiting-human" }), "failed": count(window, func(r Object) bool { return r["state"] == "failed" }), "unknown": count(rows, func(r Object) bool { return r["state"] == "unknown" || r["business_state"] == "unknown" }), "businessCompleted": uniqueCompleted(receipts, true), "allBusinessCompleted": uniqueCompleted(receipts, false), "onTimeRate": nil}
		for k, v := range m {
			summary[k] = v
		}
		if num(m["expected"]) > 0 {
			onTime := count(automatic, func(r Object) bool {
				if r["source"] != "routine" || r["effective_check"] != true || r["state"] != "completed" || r["completed_at"] == nil {
					return false
				}
				due, completed := date(r["due_at"]), date(r["completed_at"])
				return !completed.Before(due) && !completed.After(due.Add(grace(r)+time.Duration(runtimeNumber(r, "roundSeconds"))*time.Second))
			})
			summary["onTimeRate"] = float64(onTime) / float64(num(m["expected"]))
		}
		groups := map[string][]Object{}
		for _, r := range automatic {
			at := date(r["created_at"]).Add(8*time.Hour).Format("2006-01-02") + "T00:00:00+08:00"
			groups[at] = append(groups[at], r)
		}
		keys := []string{}
		for k := range groups {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		timeline := []Object{}
		for _, at := range keys {
			items := groups[at]
			v := measure(items)
			v["at"] = at
			v["failed"] = count(items, func(r Object) bool { return r["state"] == "failed" })
			timeline = append(timeline, v)
		}
		view := func(list []Object) ([]Object, error) {
			out := []Object{}
			for i, row := range list {
				if i >= 20 {
					break
				}
				v, e := s.taskViewWithin(ctx, tx, row, actor, true, false)
				if e != nil {
					return nil, e
				}
				out = append(out, v)
			}
			return out, nil
		}
		usageRows := filter(window, func(r Object) bool { return r["model_usage"] != nil })
		points := []Object{}
		for _, r := range usageRows {
			usage := obj(r["model_usage"])
			v := Object{"at": iso(r["created_at"])}
			for _, k := range usageKeys {
				v[k] = finite(usage[k])
			}
			points = append(points, v)
		}
		tracked := filter(window, func(r Object) bool {
			return r["mode"] != "code" && (r["dispatch_started_at"] != nil || r["model_usage"] != nil)
		})
		unknownTasks := count(tracked, func(r Object) bool {
			for _, k := range usageKeys {
				if finite(obj(r["model_usage"])[k]) == nil {
					return true
				}
			}
			return false
		})
		totals, subtotal := Object{}, Object{}
		for _, k := range usageKeys {
			valid := unknownTasks == 0 && len(withheld) == 0 && len(current) < 1000 && len(points) > 0
			seen := false
			sum := float64(0)
			for _, p := range points {
				if p[k] == nil {
					valid = false
				} else {
					seen = true
					switch v := p[k].(type) {
					case float64:
						sum += v
					case int64:
						sum += float64(v)
					case int:
						sum += float64(v)
					}
				}
			}
			totals[k] = nil
			subtotal[k] = nil
			if valid {
				totals[k] = sum
			}
			if seen {
				subtotal[k] = sum
			}
		}
		if _, e = s.actor(ctx, tx, a, "autonomy.read", nil); e != nil {
			return nil, e
		}
		if len(withheld) > 0 || len(current) == 1000 {
			for k := range summary {
				summary[k] = nil
			}
		}
		if len(withheld) > 0 {
			timeline = []Object{}
		}
		modes, results := []Object{}, []Object{}
		for _, k := range []string{"code", "ai", "ai-human", "human-ai"} {
			var n any
			if len(withheld) == 0 {
				n = count(automatic, func(r Object) bool { return r["mode"] == k })
			}
			modes = append(modes, Object{"key": k, "count": n})
		}
		for _, k := range []string{"not-started", "pending", "completed", "failed", "unknown", "no-action"} {
			var n any
			if len(withheld) == 0 {
				n = count(automatic, func(r Object) bool { return r["business_state"] == k })
			}
			results = append(results, Object{"key": k, "count": n})
		}
		recent, e := view(rows)
		if e != nil {
			return nil, e
		}
		human, e := view(filter(rows, func(r Object) bool { return r["state"] == "waiting-human" }))
		if e != nil {
			return nil, e
		}
		exceptions, e := view(filter(rows, func(r Object) bool { return has([]string{"failed", "unknown", "blocked"}, str(r["state"])) }))
		if e != nil {
			return nil, e
		}
		coverage := "complete-window"
		if len(current) == 1000 {
			coverage = "latest-1000"
		}
		availability := "available"
		if len(withheld) > 0 {
			availability = "partial"
		}
		var unknownOut any = unknownTasks
		var trackedOut any = len(tracked)
		if len(withheld) > 0 {
			unknownOut, trackedOut = nil, nil
		}
		return s.stamp(Object{"accounts": accounts, "summary": summary, "runtime": Object{"state": runtime["state"], "modelState": runtime["modelState"]}, "timeline": timeline, "modes": modes, "results": results, "usage": Object{"points": points, "totals": totals, "observedSubtotal": subtotal, "unknownTasks": unknownOut, "coverage": Object{"trackedTasks": trackedOut, "observedTasks": len(usageRows), "complete": unknownTasks == 0 && len(withheld) == 0 && len(current) < 1000, "history": "ledger-window-only"}}, "recentTasks": recent, "humanTasks": human, "exceptions": exceptions, "capabilities": Object{"canConfigure": has(actor.Permissions, "autonomy.configure"), "canEnable": has(actor.Permissions, "autonomy.configure"), "canControl": has(actor.Permissions, "autonomy.control")}, "basis": Object{"from": from.UTC().Format("2006-01-02T15:04:05.000Z"), "until": until.UTC().Format("2006-01-02T15:04:05.000Z"), "tasks": "persisted-intents-only", "expected": "persisted-routine-intents-in-created-window", "onTimeRate": "effective-routine-completed-within-frozen-due-grace-round-over-expected", "late": "persisted-routine-start-grace-exceeded-not-missed-schedule-slots", "recovery": "single-coalesced-catch-up-with-original-due-no-historical-slot-count", "businessCompleted": "automatic-task-with-actual-business-receipt-excluding-workbench-cards", "inspectionCompleted": "effective-tool-read-and-completed-round", "coverage": coverage, "availability": availability, "calls": "observed-native-metadata-only", "history": "not-backfilled"}}), nil
	})
}
func (s *Service) WorkbenchSummary(ctx context.Context, a Actor) (Object, error) {
	data, e := s.Overview(ctx, a, 7)
	if e != nil {
		var f *fault.Error
		if !errors.As(e, &f) || f.Status != 403 {
			return nil, e
		}
		return s.stamp(Object{"summary": nil, "accounts": []any{}, "recentTasks": []any{}, "humanTasks": []any{}, "timeline": []any{}, "basis": Object{"availability": "not-authorized"}}), nil
	}
	out := Object{}
	for _, k := range []string{"summary", "accounts", "runtime", "timeline", "basis"} {
		out[k] = data[k]
	}
	for _, k := range []string{"recentTasks", "humanTasks"} {
		items, _ := data[k].([]Object)
		if len(items) > 6 {
			items = items[:6]
		}
		out[k] = items
	}
	return s.stamp(out), nil
}
