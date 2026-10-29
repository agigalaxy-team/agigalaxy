package operationsautonomy

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// taskEventSourcesWithin returns locators only; subsequent object reads still
// enforce current source, actor and purpose checks.
func (s *Service) taskEventSourcesWithin(ctx context.Context, tx pgx.Tx, row Object, actor Actor) (Object, error) {
	ids := texts(row["event_ids"])
	events, e := many(ctx, tx, `SELECT to_jsonb(e) FROM (SELECT id,event_type,target_type,target_id,source_version FROM operations_autonomy_events_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[]) ORDER BY created_at,id) e`, s.Endpoint, ids)
	if e != nil {
		return nil, e
	}
	targets := []Object{}
	seen := map[string]bool{}
	partial := len(events) != len(ids)
	configuration := obj(row["configuration"])
	planIDs := texts(obj(configuration["plan"])["resourceIds"])
	scope := obj(obj(configuration["strategyExecution"])["resourceScope"])
	scopeIDs := texts(scope["resourceIds"])
	allowed := func(kind, id string) bool {
		if len(planIDs) > 0 && !has(planIDs, id) {
			return false
		}
		if scope["kind"] == "selected" && !has(scopeIDs, id) {
			return false
		}
		permission := kindPermission[taskReadMap[kind]]
		if permission == "" {
			permission = modulePermission[kind]
		}
		return permission != "" && has(actor.Permissions, permission)
	}
	for _, event := range events {
		kind, id := str(event["target_type"]), str(event["target_id"])
		if kind == "" || id == "" || !allowed(kind, id) {
			partial = true
			continue
		}
		version := event["source_version"]
		if version != nil {
			if _, ok := text(version, 0, 120, false); !ok {
				version = nil
				partial = true
			}
		}
		targets = append(targets, Object{"eventId": event["id"], "eventType": event["event_type"], "targetType": kind, "targetId": id, "sourceVersion": version})
		seen[kind+":"+id] = true
	}
	kind, id := str(row["target_type"]), str(row["target_id"])
	if kind != "" && id != "" && !seen[kind+":"+id] {
		if allowed(kind, id) {
			targets = append(targets, Object{"targetType": kind, "targetId": id})
		} else {
			partial = true
		}
	}
	state := "complete"
	if partial {
		state = "partial"
	}
	if len(targets) == 0 && (len(ids) > 0 || kind != "" || row["source"] == "event") {
		state = "unavailable"
	}
	return Object{"sourceTargets": targets, "sourceCoverage": state, "basis": "task-event-locators-not-current-source-authorization"}, nil
}
