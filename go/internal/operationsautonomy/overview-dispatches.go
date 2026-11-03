package operationsautonomy

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// A workbench assignment owns its schedule independently of routine duty.
// This projection never enables or edits either source of work.
func (s *Service) overviewDispatchesWithin(ctx context.Context, tx pgx.Tx, actor Actor, configs, visible []Object, runtime Object, alive bool) (map[string][]Object, error) {
	assignments, err := many(ctx, tx, `SELECT to_jsonb(d)||jsonb_build_object('latest_task_id',(SELECT t.id FROM operations_autonomy_tasks_v1 t WHERE t.endpoint=d.endpoint AND t.configuration->'dispatch'->>'id'=d.id::text ORDER BY t.created_at DESC,t.id DESC LIMIT 1)) FROM operations_autonomy_dispatches_v1 d WHERE endpoint=$1 ORDER BY created_at DESC,id DESC`, s.Endpoint)
	if err != nil {
		return nil, err
	}
	byDomain := map[string][]Object{}
	for _, d := range assignments {
		var base Object
		for _, cfg := range configs {
			if cfg["domain"] == d["domain"] {
				base = obj(clone(cfg))
				break
			}
		}
		if base == nil {
			continue
		}
		base["configuration"] = dispatchConfiguration(base, obj(d["configuration"]))
		ready, err := s.readinessWithin(ctx, tx, base, runtime)
		if err != nil {
			return nil, err
		}
		var latest, valid Object
		for _, row := range visible {
			if str(obj(obj(row["configuration"])["dispatch"])["id"]) != str(d["id"]) {
				continue
			}
			if row["id"] == d["latest_task_id"] {
				latest = row
			}
			if row["state"] == "completed" && row["effective_check"] == true && (valid == nil || date(row["completed_at"]).After(date(valid["completed_at"]))) {
				valid = row
			}
		}
		// Another operator's assignment is only projected through a currently
		// readable round; it must not expose materials excluded from the ledger.
		if str(d["operator_id"]) != actor.ID && latest == nil {
			continue
		}
		state := "ready"
		switch {
		case d["enabled"] != true:
			state = "disabled"
		case !alive:
			state = "unavailable"
		case ready["ready"] != true:
			state = "blocked"
		case d["latest_task_id"] != nil && latest == nil:
			state = "unknown"
		case latest != nil && has([]string{"failed", "unknown", "waiting-human", "blocked"}, str(latest["state"])):
			state = "attention"
		case latest != nil && latest["state"] == "running":
			state = "running"
		case latest != nil && latest["state"] == "queued" && s.now().Sub(date(latest["due_at"])) > time.Duration(s.defaultNumber("startGraceSeconds"))*time.Second:
			state = "attention"
		case d["next_due_at"] != nil && s.now().Sub(date(d["next_due_at"])) > time.Duration(s.defaultNumber("startGraceSeconds"))*time.Second:
			state = "attention"
		case valid != nil:
			state = "healthy"
		}
		var last any
		if latest != nil {
			last = Object{"id": latest["id"], "state": latest["state"], "updatedAt": iso(latest["updated_at"]), "completedAt": iso(latest["completed_at"])}
		}
		active := d["enabled"] == true && !(obj(obj(d["configuration"])["trigger"])["kind"] == "once" && latest != nil && has(terminal, str(latest["state"])))
		byDomain[str(d["domain"])] = append(byDomain[str(d["domain"])], Object{"id": d["id"], "title": d["title"], "enabled": d["enabled"], "active": active, "trigger": obj(d["configuration"])["trigger"], "health": state, "readiness": ready, "nextDueAt": iso(d["next_due_at"]), "lastValidAt": iso(valid["completed_at"]), "latestTask": last})
	}
	return byDomain, nil
}

func mergeDispatchRuntime(account Object, dispatches []Object) {
	account["dispatches"] = dispatches
	if dispatches == nil {
		account["dispatches"] = []Object{}
	}
	for _, d := range dispatches {
		if d["active"] != true {
			continue
		}
		wasEnabled := account["enabled"] == true
		account["enabled"] = true
		priority := map[string]int{"healthy": 0, "ready": 1, "running": 2, "attention": 3, "unknown": 4, "blocked": 5, "unavailable": 6}
		if !wasEnabled || priority[str(d["health"])] > priority[str(account["health"])] {
			account["health"] = d["health"]
		}
		if d["nextDueAt"] != nil && (account["nextDueAt"] == nil || date(d["nextDueAt"]).Before(date(account["nextDueAt"]))) {
			account["nextDueAt"] = d["nextDueAt"]
		}
		if d["lastValidAt"] != nil && (account["lastValidAt"] == nil || date(d["lastValidAt"]).After(date(account["lastValidAt"]))) {
			account["lastValidAt"] = d["lastValidAt"]
		}
	}
}
