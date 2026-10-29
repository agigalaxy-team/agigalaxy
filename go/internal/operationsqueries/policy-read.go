package operationsqueries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
)

func ruleDetail(x Object) Object {
	out := object(project(x, Object{"key": "s", "revision": "n", "active": merge(shape("id key source createdAt", "s"), shape("version publishedVersion", "n")), "draft": merge(shape("id key createdAt", "s"), Object{"version": "n"}), "adoption": Object{"mode": "s", "publishedVersion": "n", "observed": []any{merge(shape("target lastAppliedAt", "s"), shape("publishedVersion count", "n"))}}}))
	var policy any
	if p, e := operationsrules.ParsePolicy(str(x["key"]), object(object(x["active"])["policy"])); e == nil {
		policy = p
	}
	out["activePolicy"] = policy
	return out
}
func (s *Service) rules(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if s.Rules == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	x := s.Rules
	reader := &operationsrules.Service{Pool: x.Pool, Endpoint: x.Endpoint, Authority: s.reader(a), Now: x.Now}
	if args.kind == "rule" {
		value, e := reader.Get(ctx, a, args.id)
		if e != nil {
			return queryResult{}, e
		}
		value, e = queryWireSource(value)
		return queryResult{source: value, data: ruleDetail(value), refs: []reference{{kind: "rule", id: args.id, row: value, filters: args.filters}}}, e
	}
	if args.view == "overview" {
		value, e := reader.Overview(ctx, a)
		if e != nil {
			return queryResult{}, e
		}
		source, e := queryWireSource(value)
		if e != nil {
			return queryResult{}, e
		}
		items, e := extensionArray(source["items"], 100000)
		if e != nil {
			return queryResult{}, e
		}
		rows, refs := []any{}, []reference{}
		for _, v := range items {
			x := object(v)
			rows = append(rows, ruleDetail(x))
			refs = append(refs, reference{kind: "rule", id: str(x["key"]), row: x})
		}
		return queryResult{source: source, data: Object{"items": rows}, refs: refs}, nil
	}
	filters := merge(args.filters)
	key := str(filters["key"])
	delete(filters, "key")
	value, e := reader.Versions(ctx, a, key, filters)
	if e != nil {
		return queryResult{}, e
	}
	return typedList(args, value, func(x Object) Object {
		return merge(historyItem(x), Object{"version": project(x["version"], merge(shape("id key source createdAt", "s"), shape("version publishedVersion", "n")))})
	}, nil)
}
func (s *Service) strategies(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if s.Strategies == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	view := args.view
	if args.kind == "strategy-run" || args.kind == "strategy-version" {
		view = args.kind
	}
	value, e := s.Strategies.QueryRead(ctx, a, s.reader(a), view, args.id, args.filters)
	if e != nil {
		return queryResult{}, e
	}
	value, e = queryWireSource(value)
	if e != nil {
		return queryResult{}, e
	}
	if args.kind == "strategy-version" {
		version := object(value["version"])
		data := object(project(version, Object{"id": "s", "version": "n", "createdAt": "s"}))
		data["configuration"] = version["configuration"]
		return queryResult{source: value, data: data}, nil
	}
	if args.kind != "" {
		row := object(value["run"])
		data := object(project(row, merge(shape("id strategyId state code createdAt updatedAt", "s"), Object{"strategy": shape("id name domain mode", "s"), "target": merge(shape("kind id", "s"), Object{"sourceVersion": "n"}), "canContinue": "b", "continueCode": "s", "native": merge(shape("runId status pauseKind", "s"), Object{"awaitingHuman": "b"})})))
		return queryResult{source: value, data: data, refs: []reference{{kind: args.kind, id: args.id, row: row, filters: args.filters}}}, nil
	}
	if args.view == "overview" {
		data := object(project(value, Object{"revision": "n", "paused": "b", "active": Object{"id": "s", "version": "n", "createdAt": "s"}, "draft": Object{"id": "s", "version": "n", "createdAt": "s"}, "native": Object{"state": "s"}}))
		data["configuration"] = value["configuration"]
		if draft := object(value["draft"]); draft != nil {
			object(data["draft"])["configuration"] = draft["configuration"]
		}
		return queryResult{source: value, data: data}, nil
	}
	if args.view == "versions" {
		return typedList(args, value, func(x Object) Object { return object(project(x, Object{"id": "s", "version": "n", "createdAt": "s"})) }, nil)
	}
	return typedList(args, value, func(x Object) Object {
		return merge(historyItem(x), Object{"version": project(x["version"], Object{"id": "s", "version": "n", "createdAt": "s"}), "strategyId": text(x["strategyId"]), "runId": text(x["runId"])})
	}, nil)
}
func pointItem(x Object) Object {
	return object(project(x, merge(shape("id createdAt", "s"), shape("logicalBytes logicalFileCount", "n"), Object{"integrity": shape("state checkedAt", "s"), "coverage": []any{merge(shape("id label state method", "s"), Object{"reasonCodes": []any{"s"}})}, "productionRestore": Object{"available": "b", "blockers": []any{"s"}}})))
}
func restorePlanItem(x Object) Object {
	return object(project(x, merge(shape("id state scope productionActivation createdAt updatedAt", "s"), Object{"revision": "n", "moduleIds": []any{"s"}, "point": shape("id createdAt", "s"), "possibleLoss": merge(shape("from observedAt through basis", "s"), shape("observedWindowSeconds maximumSeconds", "n")), "blockers": []any{"s"}, "openingConditions": []any{shape("id state", "s")}})))
}
func (s *Service) maintenance(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if s.Maintenance == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	x := s.Maintenance
	reader := &maintenance.Service{Pool: x.Pool, Endpoint: x.Endpoint, Authority: s.reader(a), StoredAuthority: x.StoredAuthority, Duty: x.Duty, PrincipalWithin: x.PrincipalWithin, Native: x.Native, IncidentSnapshot: x.IncidentSnapshot, QueueSnapshot: x.QueueSnapshot, ChatProbe: x.ChatProbe, Now: x.Now}
	if args.kind != "" {
		var value Object
		var e error
		if args.kind == "backup-point" {
			value, e = reader.Backup(ctx, a, args.id)
		} else {
			value, e = reader.Plan(ctx, a, args.id, Object{})
		}
		if e != nil {
			return queryResult{}, e
		}
		value, e = queryWireSource(value)
		if e != nil {
			return queryResult{}, e
		}
		row := object(value["point"])
		projector := pointItem
		if args.kind == "restore-plan" {
			row = object(value["plan"])
			if row == nil {
				row = value
			}
			projector = restorePlanItem
		}
		return queryResult{source: value, data: projector(row), refs: []reference{{kind: args.kind, id: args.id, row: row, filters: args.filters}}}, nil
	}
	var value Object
	var e error
	switch args.view {
	case "overview":
		value, e = reader.Overview(ctx, a)
	case "backups":
		value, e = reader.Backups(ctx, a, args.filters)
	case "plans":
		value, e = reader.Plans(ctx, a, args.filters)
	case "logs":
		value, e = reader.Logs(ctx, a, args.filters)
	default:
		return queryResult{}, invalid()
	}
	if e != nil {
		return queryResult{}, e
	}
	value, e = queryWireSource(value)
	if e != nil {
		return queryResult{}, e
	}
	if args.view == "overview" {
		return queryResult{source: value, data: maintenanceProjection(value)}, nil
	}
	if args.view == "backups" {
		return typedList(args, value, pointItem, fixedKind("backup-point"))
	}
	if args.view == "plans" {
		return typedList(args, value, restorePlanItem, fixedKind("restore-plan"))
	}
	copy := merge(value, Object{"nextAfter": value["nextBefore"]})
	out, e := typedList(args, copy, func(x Object) Object {
		return object(project(x, merge(shape("at component level event diagnostic code sqlState", "s"), Object{"status": "n"})))
	}, nil)
	if e != nil {
		return queryResult{}, e
	}
	out.source = value
	var next any
	if value["nextBefore"] != nil && value["nextBefore"] != "" {
		next = Object{"module": args.module, "view": args.view, "filters": merge(args.filters, Object{"before": value["nextBefore"]})}
	}
	out.pagination["next"] = next
	return out, nil
}
