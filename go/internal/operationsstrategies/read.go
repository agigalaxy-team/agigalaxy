package operationsstrategies

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"strconv"
)

func many(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, sql string, args ...any) ([]Object, error) {
	rows, e := q.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var raw []byte
		if e = rows.Scan(&raw); e != nil {
			return nil, e
		}
		var o Object
		if e = json.Unmarshal(raw, &o); e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
func (s *Service) Versions(ctx context.Context, a Actor, input Object) (Object, error) {
	if _, e := s.current(ctx, a, "strategies.read"); e != nil {
		return nil, e
	}
	x, e := ParsePage(input)
	if e != nil {
		return nil, e
	}
	rows, e := many(ctx, s.Pool, `SELECT to_jsonb(q) FROM(SELECT v.*,p.display_name AS created_by_display_name FROM operations_p13_strategy_versions_v1 v LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=v.endpoint AND p.operator_id=v.created_by WHERE v.endpoint=$1 AND ($2::text::integer IS NULL OR v.version<$2::text::integer) ORDER BY v.version DESC LIMIT $3)q`, s.Endpoint, x["after"], num(x["limit"])+1)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "strategies.read"); e != nil {
		return nil, e
	}
	limit := int(num(x["limit"]))
	var next any
	if len(rows) > limit {
		next = strconv.FormatInt(num(rows[limit-1]["version"]), 10)
		rows = rows[:limit]
	}
	items := []any{}
	for _, r := range rows {
		items = append(items, VersionView(r))
	}
	return s.metadata(Object{"items": items, "nextAfter": next}), nil
}
func (s *Service) Records(ctx context.Context, a Actor, input Object) (Object, error) {
	if _, e := s.current(ctx, a, "strategies.read"); e != nil {
		return nil, e
	}
	x, e := ParsePage(input)
	if e != nil {
		return nil, e
	}
	rows, e := many(ctx, s.Pool, `SELECT to_jsonb(q) FROM(SELECT e.sequence::text,e.id,e.version_id,e.strategy_id,e.run_id,e.kind,e.operator_id,e.metadata,e.created_at,p.display_name AS operator_display_name FROM operations_p13_strategy_events_v1 e LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=e.endpoint AND p.operator_id=e.operator_id WHERE e.endpoint=$1 AND ($2::bigint IS NULL OR e.sequence<$2) AND ($3::uuid IS NULL OR e.strategy_id=$3) ORDER BY e.sequence DESC LIMIT $4)q`, s.Endpoint, x["after"], x["strategyId"], num(x["limit"])+1)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "strategies.read"); e != nil {
		return nil, e
	}
	limit := int(num(x["limit"]))
	var next any
	if len(rows) > limit {
		next = rows[limit-1]["sequence"]
		rows = rows[:limit]
	}
	items := []any{}
	for _, r := range rows {
		items = append(items, Object{"id": r["id"], "sequence": r["sequence"], "versionId": r["version_id"], "strategyId": r["strategy_id"], "runId": r["run_id"], "kind": r["kind"], "operatorId": r["operator_id"], "operatorDisplayName": r["operator_display_name"], "metadata": r["metadata"], "createdAt": iso(r["created_at"])})
	}
	return s.metadata(Object{"items": items, "nextAfter": next}), nil
}
func (s *Service) Operation(ctx context.Context, a Actor, id string) (Object, error) {
	actor, e := s.current(ctx, a, "strategies.read")
	if e != nil {
		return nil, e
	}
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	row, e := one(ctx, s.Pool, `SELECT to_jsonb(c) FROM operations_p13_strategy_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if row != nil {
		if row["operator_id"] != actor.ID {
			return nil, fail("p13_operation_not_found", 404)
		}
		var continuation Object
		if row["kind"] == "continue" {
			_, owned, e := s.ownedRun(ctx, a, str(obj(row["result"])["runId"]), "strategies.read")
			if e != nil {
				return nil, e
			}
			continuation, e = s.continuationReceipt(ctx, owned, row, true)
			if e != nil {
				return nil, e
			}
		}

		if _, e = s.current(ctx, a, "strategies.read"); e != nil {
			return nil, e
		}
		out := Object{"state": "recorded", "kind": row["kind"], "result": row["result"]}
		if continuation != nil {
			out["continuation"] = continuation
		}
		return s.metadata(out), nil
	}
	run, e := one(ctx, s.Pool, `SELECT to_jsonb(r) FROM(SELECT operator_id FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND id=$2)r`, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if run["operator_id"] == actor.ID {
		out, e := s.RunDetail(ctx, a, id)
		if e != nil {
			return nil, e
		}
		out["state"], out["kind"] = "recorded", "run"
		return out, nil
	}
	if _, e = s.current(ctx, a, "strategies.read"); e != nil {
		return nil, e
	}
	return s.metadata(Object{"state": "not-recorded", "operationId": id}), nil
}
func (s *Service) Options(ctx context.Context, a Actor) (Object, error) {
	actor, e := s.current(ctx, a, "strategies.read")
	if e != nil {
		return nil, e
	}
	rows, e := many(ctx, s.Pool, `SELECT to_jsonb(e) FROM(SELECT id,prepared_command FROM operations_agentos_executions_v1 WHERE endpoint=$1 AND created_by=$2 AND state='active' AND prepared_command IS NOT NULL ORDER BY created_at DESC,id LIMIT 100)e`, s.Endpoint, actor.ID)
	if e != nil {
		return nil, e
	}
	items := []any{}
	expires := s.now().Unix() + 30
	for _, row := range rows {
		bound, e := one(ctx, s.Pool, `SELECT to_jsonb(r) FROM(SELECT id,state FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND execution_id=$2)r`, s.Endpoint, row["id"])
		if e != nil {
			return nil, e
		}
		var current, label Object
		var unavailable error
		if s.Effects == nil {
			unavailable = fail("p13_effects_not_configured", 503)
		} else {
			current, unavailable = s.Effects.Inspect(ctx, str(row["id"]), actor.ID, nil)
			if unavailable == nil {
				label, unavailable = s.Effects.Describe(ctx, str(row["id"]))
			}
		}
		if unavailable != nil {
			items = append(items, Object{"executionId": row["id"], "domain": nil, "target": nil, "available": false, "boundRunId": bound["id"], "code": "currently-unavailable"})
			continue
		}
		if num(label["readExpiresAt"]) < expires {
			expires = num(label["readExpiresAt"])
		}
		qualified := true
		for _, v := range obj(current["facts"]) {
			qualified = qualified && v == true
		}
		var code any
		if bound != nil {
			code = "already-bound"
		} else if !qualified {
			code = "qualification-required"
		}
		items = append(items, Object{"executionId": row["id"], "domain": current["domain"], "grantId": current["grantId"], "grantVersion": current["grantVersion"], "executorKind": current["executorKind"], "mode": current["grantMode"], "target": current["target"], "title": label["title"], "createdAt": label["createdAt"], "sourceExpiresAt": label["sourceExpiresAt"], "commandUntil": label["commandUntil"], "action": current["action"], "sourceVersion": current["sourceVersion"], "decisionRevision": current["decisionRevision"], "canRehearse": qualified, "available": bound == nil && qualified, "boundRunId": bound["id"], "code": code})
	}
	if _, e = s.current(ctx, a, "strategies.read"); e != nil {
		return nil, e
	}
	out := s.metadata(Object{"items": items, "nextAfter": nil, "basis": Object{"scope": "owned-active-prepared-executions", "limit": 100, "complete": len(rows) < 100}})
	out["readExpiresAt"] = expires
	return out, nil
}
