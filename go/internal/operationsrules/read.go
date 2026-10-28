package operationsrules

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"regexp"
	"strconv"
	"time"
)

func collect(rows pgx.Rows) ([]Object, error) {
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var raw []byte
		if e := rows.Scan(&raw); e != nil {
			return nil, e
		}
		var x Object
		if e := json.Unmarshal(raw, &x); e != nil {
			return nil, e
		}
		out = append(out, x)
	}
	return out, rows.Err()
}
func VersionView(r Object) any {
	if r == nil {
		return nil
	}
	return Object{"id": r["id"], "key": r["policy_key"], "version": r["version"], "policy": r["policy"], "source": r["source"], "createdBy": r["created_by"], "createdAt": iso(r["created_at"]), "restoredFrom": r["restored_from"], "publishedVersion": r["published_version"]}
}
func processView(r Object, version any, now int64) Object {
	t, _ := time.Parse(time.RFC3339Nano, str(r["checked_at"]))
	fresh := now-t.Unix() <= 120
	return Object{"component": r["component"], "instanceId": r["instance_id"], "adoptedVersion": r["adopted_version"], "attemptedVersion": r["attempted_version"], "errorCode": r["error_code"], "checkedAt": iso(r["checked_at"]), "fresh": fresh, "current": same(r["adopted_version"], version) && r["error_code"] == nil && fresh}
}
func (s *Service) detailWithin(ctx context.Context, tx pgx.Tx, key string, a Actor) (Object, error) {
	h, e := s.head(ctx, tx, key)
	if e != nil {
		return nil, e
	}
	active, e := s.version(ctx, tx, key, h["active_id"])
	if e != nil {
		return nil, e
	}
	draft, e := s.version(ctx, tx, key, h["draft_id"])
	if e != nil {
		return nil, e
	}
	processes := []any{}
	observed := []any{}
	mode := "process-refresh"
	if key == "business-controls" {
		mode = "current-transaction"
		rows, e := tx.Query(ctx, `SELECT to_jsonb(r) FROM(SELECT target,policy_version,count(*)::integer AS count,max(created_at) AS last_applied_at FROM operations_p14_rule_decisions_v1 WHERE endpoint=$1 GROUP BY target,policy_version ORDER BY last_applied_at DESC LIMIT 30)r`, s.Endpoint)
		if e != nil {
			return nil, e
		}
		records, e := collect(rows)
		if e != nil {
			return nil, e
		}
		for _, r := range records {
			observed = append(observed, Object{"target": r["target"], "publishedVersion": r["policy_version"], "count": r["count"], "lastAppliedAt": iso(r["last_applied_at"])})
		}
	} else {
		rows, e := tx.Query(ctx, `SELECT to_jsonb(r) FROM operations_policy_processes_v1 r WHERE endpoint=$1 AND policy_key=$2 ORDER BY component,checked_at DESC,instance_id LIMIT 100`, s.Endpoint, key)
		if e != nil {
			return nil, e
		}
		records, e := collect(rows)
		if e != nil {
			return nil, e
		}
		for _, r := range records {
			processes = append(processes, processView(r, active["published_version"], s.now().Unix()))
		}
	}
	edit := has(a.Permissions, "rules.write")
	return s.metadata(Object{"key": key, "revision": h["revision"], "active": VersionView(active), "draft": VersionView(draft), "capabilities": Object{"canEdit": edit, "canPublish": edit, "canRestore": edit, "canTest": true}, "processes": processes, "adoption": Object{"mode": mode, "publishedVersion": active["published_version"], "observed": observed}, "catalog": Catalog()}), nil
}
func (s *Service) Get(ctx context.Context, a Actor, key string) (Object, error) {
	if !has(Keys, key) {
		return nil, invalid()
	}
	actor, e := s.readable(ctx, a)
	if e != nil {
		return nil, e
	}
	out, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.detailWithin(ctx, tx, key, actor) })
	if e != nil {
		return nil, e
	}
	_, e = s.readable(ctx, a)
	return out, e
}
func (s *Service) Overview(ctx context.Context, a Actor) (Object, error) {
	actor, e := s.readable(ctx, a)
	if e != nil {
		return nil, e
	}
	out, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		items := []any{}
		for _, key := range Keys {
			v, e := s.detailWithin(ctx, tx, key, actor)
			if e != nil {
				return nil, e
			}
			item := Object{}
			for _, k := range []string{"key", "revision", "active", "draft", "capabilities", "adoption"} {
				item[k] = v[k]
			}
			items = append(items, item)
		}
		return s.metadata(Object{"items": items, "catalog": Catalog()}), nil
	})
	if e != nil {
		return nil, e
	}
	_, e = s.readable(ctx, a)
	return out, e
}

var afterPattern = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

func formatSequence(v any) string { return strconv.FormatInt(num(v), 10) }

func page(x Object, max, def int) (any, int, error) {
	if x == nil {
		x = Object{}
	}
	if !closed(x, nil, []string{"after", "limit"}) {
		return nil, 0, invalid()
	}
	limit := def
	if v, ok := x["limit"]; ok {
		if !integer(v, 1, int64(max)) {
			return nil, 0, invalid()
		}
		limit = int(num(v))
	}
	var after any
	if v, ok := x["after"]; ok {
		s, ok := v.(string)
		n, e := strconv.ParseInt(s, 10, 64)
		if !ok || !afterPattern.MatchString(s) || e != nil || n > 2147483647 {
			return nil, 0, invalid()
		}
		after = n
	}
	return after, limit, nil
}
func (s *Service) Versions(ctx context.Context, a Actor, key string, x Object) (Object, error) {
	if !has(Keys, key) {
		return nil, invalid()
	}
	if _, e := s.readable(ctx, a); e != nil {
		return nil, e
	}
	after, limit, e := page(x, 50, 20)
	if e != nil {
		return nil, e
	}
	rows, e := s.Pool.Query(ctx, `SELECT to_jsonb(r) FROM(SELECT v.*,e.id AS event_id,e.kind,e.operator_id,e.reason,e.changes FROM operations_p14_rule_versions_v1 v LEFT JOIN operations_p14_rule_events_v1 e ON e.version_id=v.id WHERE v.endpoint=$1 AND v.policy_key=$2 AND ($3::integer IS NULL OR v.version<$3) ORDER BY v.version DESC LIMIT $4)r`, s.Endpoint, key, after, limit+1)
	if e != nil {
		return nil, e
	}
	records, e := collect(rows)
	if e != nil {
		return nil, e
	}
	baseline, e := one(ctx, s.Pool, `SELECT to_jsonb(v) FROM operations_p14_rule_versions_v1 v WHERE endpoint=$1 AND policy_key=$2 AND source='configured-baseline' ORDER BY version LIMIT 1`, s.Endpoint, key)
	if e != nil {
		return nil, e
	}
	items := []any{}
	var next any
	if len(records) > limit {
		next = strconv.FormatInt(num(records[limit-1]["version"]), 10)
		records = records[:limit]
	}
	for _, r := range records {
		id, kind, owner, delta := r["event_id"], r["kind"], r["operator_id"], r["changes"]
		if id == nil {
			id = r["id"]
		}
		if kind == nil {
			kind = "legacy-published"
			if r["source"] == "configured-baseline" {
				kind = "configured-baseline"
			}
		}
		if owner == nil {
			owner = r["created_by"]
		}
		if delta == nil {
			delta = Object{}
		}
		items = append(items, Object{"id": id, "sequence": strconv.FormatInt(num(r["version"]), 10), "kind": kind, "operatorId": owner, "reason": r["reason"], "changes": delta, "createdAt": iso(r["created_at"]), "version": VersionView(r)})
	}
	if _, e = s.readable(ctx, a); e != nil {
		return nil, e
	}
	return s.metadata(Object{"items": items, "baseline": VersionView(baseline), "nextAfter": next}), nil
}
func (s *Service) Operation(ctx context.Context, a Actor, id string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	actor, e := s.readable(ctx, a)
	if e != nil {
		return nil, e
	}
	row, e := one(ctx, s.Pool, `SELECT to_jsonb(c) FROM operations_p14_rule_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return s.metadata(Object{"state": "not-recorded", "operationId": id}), nil
	}
	if row["operator_id"] != actor.ID {
		return nil, fail("not_found", 404)
	}
	if _, e = s.readable(ctx, a); e != nil {
		return nil, e
	}
	out := clone(obj(row["result"]))
	out["state"] = "recorded"
	return s.metadata(out), nil
}
