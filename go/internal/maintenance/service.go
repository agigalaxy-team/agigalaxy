package maintenance

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) require(ctx context.Context, tx pgx.Tx, a Actor, permission string) (Actor, error) {
	d := s.domain()
	if s.Duty != nil {
		if _, ok := d.Authority.(*p.BusinessAuthority); !ok {
			d.Authority = &p.BusinessAuthority{Human: d.Authority, Duty: s.Duty}
		}
	}
	return d.Fresh(ctx, tx, a, permission)
}
func (s *Service) current(ctx context.Context, a Actor, permission string) (Actor, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.require(ctx, tx, a, permission) })
}
func (s *Service) human(a Actor) error {
	if s.domain().IsDuty(a) {
		return failure("maintenance_human_required", 403)
	}
	return nil
}
func (s *Service) Capabilities(ctx context.Context, a Actor) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var current Actor
		var e error
		d := s.domain()
		human := !d.IsDuty(a)
		if !human {
			current, e = d.DutyAuthority().RequireDutyAction(ctx, tx, a, "workbench.read", "")
		} else if s.Authority != nil {
			current, e = s.Authority.EffectiveWithin(ctx, tx, a)
		} else {
			return nil, failure("operations_authorization_unavailable", 503)
		}
		if e != nil {
			return nil, e
		}
		return Object{"canReadLogs": includes(current.Permissions, "maintenance.logs.read"), "canCreateBackup": human && includes(current.Permissions, "maintenance.backups.create"), "canVerifyBackup": human && includes(current.Permissions, "maintenance.backups.verify"), "canPlanRestore": human && includes(current.Permissions, "maintenance.restore.plan"), "canApproveRestore": human && includes(current.Permissions, "maintenance.restore.approve"), "canExecuteRestore": human && includes(current.Permissions, "maintenance.restore.execute")}, nil
	})
}
func (s *Service) nativeRead(ctx context.Context, input Object) (Object, error) {
	if s.Native == nil {
		return nil, nil
	}
	r, e := s.Native.Call(ctx, input)
	if e != nil && fault.Status(e) != 409 {
		return nil, nil
	}
	return r, e
}
func (s *Service) record(ctx context.Context, tx pgx.Tx, a Actor, action string, values Object) error {
	return s.domain().Record(ctx, tx, a, action, Object{"planId": values["planId"], "revision": values["revision"], "kind": values["kind"]}, Object{"state": values["state"], "count": values["count"]}, values["operationId"])
}
func (s *Service) recordRead(ctx context.Context, a Actor, action string, values Object) error {
	return within(ctx, s.Pool, func(tx pgx.Tx) error { return s.record(ctx, tx, a, action, values) })
}
func (s *Service) Overview(ctx context.Context, a Actor) (Object, error) {
	actor, e := s.current(ctx, a, "maintenance.read")
	if e != nil {
		return nil, e
	}
	source, e := s.nativeRead(ctx, Object{"kind": "overview"})
	if e != nil {
		return nil, e
	}
	queues := Object{"scope": "registered-business-pg-boss-queues", "includesAllPlatformQueues": false, "availability": Availability("unavailable", "maintenance_queue_query_failed"), "items": []any{}}
	if s.QueueSnapshot != nil {
		if current, e := s.QueueSnapshot(ctx); e == nil && current != nil {
			queues = current
		}
	}
	if _, e = s.current(ctx, actor, "maintenance.read"); e != nil {
		return nil, e
	}
	var count any
	if source != nil {
		if array(source["components"]) {
			count = len(list(source["components"]))
		}
	}
	if e = s.recordRead(ctx, actor, "maintenance-query", Object{"kind": "overview", "count": count}); e != nil {
		return nil, e
	}
	var incident Object
	if s.IncidentSnapshot != nil {
		incident = s.IncidentSnapshot()
	}
	state := "unknown"
	if includes([]string{"normal", "contained", "recovery", "resolved"}, str(incident["state"])) {
		state = str(incident["state"])
	}
	modeSource := "not-connected"
	if incident != nil {
		modeSource = "existing-incident-controller"
	}
	var writes, revision any
	if v, ok := incident["businessWritesAccepted"].(bool); ok {
		writes = v
	}
	if whole(incident["revision"], -9007199254740991, 9007199254740991) {
		revision = incident["revision"]
	}
	permissions, e := s.Capabilities(ctx, actor)
	if e != nil {
		return nil, e
	}
	out := Overview(source)
	out["queues"], out["maintenanceMode"], out["permissions"] = queues, Object{"state": state, "source": modeSource, "businessWritesAccepted": writes, "revision": revision}, permissions
	return s.envelope(out), nil
}
func (s *Service) Logs(ctx context.Context, a Actor, input Object) (Object, error) {
	actor, e := s.current(ctx, a, "maintenance.logs.read")
	if e != nil {
		return nil, e
	}
	query, e := ParseQuery("logs", input)
	if e != nil {
		return nil, e
	}
	source, e := s.nativeRead(ctx, Object{"kind": "logs", "query": query})
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, actor, "maintenance.logs.read"); e != nil {
		return nil, e
	}
	items := []any{}
	for _, v := range list(source["items"]) {
		if row := Log(obj(v)); row != nil {
			items = append(items, row)
		}
	}
	if e = s.recordRead(ctx, actor, "maintenance-logs-query", Object{"kind": "logs", "count": len(items)}); e != nil {
		return nil, e
	}
	availability := Availability("unavailable", "maintenance_native_not_connected")
	if source != nil {
		availability = Availability("available", nil)
	}
	var next any
	if regexpBefore.MatchString(str(source["nextBefore"])) {
		next = source["nextBefore"]
	}
	components := filtered(source["components"], componentPattern)
	return s.envelope(Object{"availability": availability, "items": items, "nextBefore": next, "pageBasis": "native-loki-time-range", "components": components, "query": query}), nil
}
func (s *Service) Backups(ctx context.Context, a Actor, input Object) (Object, error) {
	actor, e := s.current(ctx, a, "maintenance.read")
	if e != nil {
		return nil, e
	}
	query, e := ParseQuery("backups", input)
	if e != nil {
		return nil, e
	}
	source, e := s.nativeRead(ctx, Object{"kind": "catalog", "query": query})
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, actor, "maintenance.read"); e != nil {
		return nil, e
	}
	items := []any{}
	for _, v := range list(source["items"]) {
		if point := Point(obj(v)); point != nil {
			items = append(items, point)
		}
	}
	caps, e := s.Capabilities(ctx, actor)
	if e != nil {
		return nil, e
	}
	if e = s.recordRead(ctx, actor, "maintenance-query", Object{"kind": "backups", "count": len(items)}); e != nil {
		return nil, e
	}
	availability := Availability("unavailable", "maintenance_native_not_connected")
	if source != nil {
		availability = Availability("available", nil)
	}
	caps["canCreateBackup"] = caps["canCreateBackup"] == true && obj(source["capabilities"])["backupCreate"] == true
	caps["canVerifyBackup"] = caps["canVerifyBackup"] == true && obj(source["capabilities"])["backupVerify"] == true
	var next any
	if pointPattern.MatchString(str(source["nextAfter"])) {
		next = source["nextAfter"]
	}
	return s.envelope(Object{"availability": availability, "policy": Policy(obj(source["policy"])), "currentCoverage": Coverage(source["coverage"]), "items": items, "total": number(source["total"]), "nextAfter": next, "permissions": caps}), nil
}
func (s *Service) Backup(ctx context.Context, a Actor, id string) (Object, error) {
	actor, e := s.current(ctx, a, "maintenance.read")
	if e != nil {
		return nil, e
	}
	if !pointPattern.MatchString(id) {
		return nil, invalid()
	}
	source, e := s.nativeRead(ctx, Object{"kind": "point", "pointId": id})
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, actor, "maintenance.read"); e != nil {
		return nil, e
	}
	point := Point(obj(source["point"]))
	if point == nil {
		if source == nil {
			return nil, unavailable()
		}
		return nil, failure("maintenance_backup_not_found", 404)
	}
	if e = s.recordRead(ctx, actor, "maintenance-query", Object{"kind": "backup"}); e != nil {
		return nil, e
	}
	return s.envelope(Object{"point": point}), nil
}
func (s *Service) rowWithin(ctx context.Context, q Reader, id string, lock bool) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	r, e := optional(ctx, q, "SELECT to_jsonb(p) FROM operations_maintenance_plans_v1 p WHERE endpoint=$1 AND id=$2"+suffix, s.Endpoint, id)
	if e == nil && r == nil {
		return nil, failure("maintenance_plan_not_found", 404)
	}
	return r, e
}
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
		var r Object
		if e = json.Unmarshal(raw, &r); e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (s *Service) Plans(ctx context.Context, a Actor, input Object) (Object, error) {
	actor, e := s.current(ctx, a, "maintenance.read")
	if e != nil {
		return nil, e
	}
	query, e := ParseQuery("plans", input)
	if e != nil {
		return nil, e
	}
	var anchor Object
	if query["after"] != nil {
		anchor, e = s.rowWithin(ctx, s.Pool, str(query["after"]), false)
		if e != nil {
			return nil, e
		}
	}
	rows, e := many(ctx, s.Pool, `SELECT to_jsonb(p) FROM operations_maintenance_plans_v1 p WHERE endpoint=$1 AND ($2::text::timestamptz IS NULL OR (created_at,id)<($2::text::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`, s.Endpoint, anchor["created_at"], anchor["id"], num(query["limit"])+1)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, actor, "maintenance.read"); e != nil {
		return nil, e
	}
	limit := int(num(query["limit"]))
	var next any
	if len(rows) > limit {
		next = rows[limit-1]["id"]
		rows = rows[:limit]
	}
	items := []any{}
	for _, r := range rows {
		items = append(items, PlanProjection(r))
	}
	return s.envelope(Object{"items": items, "nextAfter": next}), nil
}
func (s *Service) Plan(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	actor, e := s.current(ctx, a, "maintenance.read")
	if e != nil {
		return nil, e
	}
	query, e := ParseQuery("page", input)
	if e != nil {
		return nil, e
	}
	row, e := s.rowWithin(ctx, s.Pool, id, false)
	if e != nil {
		return nil, e
	}
	rows, e := many(ctx, s.Pool, `SELECT to_jsonb(q) FROM(SELECT sequence::text,operator_id,action,revision,result,created_at FROM operations_maintenance_events_v1 WHERE endpoint=$1 AND plan_id=$2 AND ($3::bigint IS NULL OR sequence<$3) ORDER BY sequence DESC LIMIT $4)q`, s.Endpoint, id, query["after"], num(query["limit"])+1)
	if e != nil {
		return nil, e
	}
	var nativeOperation Object
	if row["execution_id"] != nil {
		nativeOperation, e = s.nativeRead(ctx, Object{"kind": "operation", "operationId": row["execution_id"]})
		if e != nil {
			return nil, e
		}
	}
	if _, e = s.current(ctx, actor, "maintenance.read"); e != nil {
		return nil, e
	}
	caps, e := s.Capabilities(ctx, actor)
	if e != nil {
		return nil, e
	}
	plan := PlanProjection(row)
	var operation any
	if nativeOperation != nil {
		projected := SafeNativeOperation(nativeOperation)
		operation = projected
		if projected["planState"] != nil {
			plan["state"] = projected["planState"]
		}
		activation := "unknown"
		if projected["publicActivation"] == true {
			activation = "recorded-by-approved-executor"
		} else if projected["publicActivation"] == false {
			activation = "not-opened"
		}
		plan["productionActivation"] = activation
	}
	var next any
	limit := int(num(query["limit"]))
	if len(rows) > limit {
		next = rows[limit-1]["sequence"]
		rows = rows[:limit]
	}
	items := []any{}
	for _, r := range rows {
		items = append(items, Object{"sequence": r["sequence"], "operatorId": r["operator_id"], "action": r["action"], "revision": r["revision"], "state": obj(r["result"])["state"], "createdAt": Iso(r["created_at"])})
	}
	return s.envelope(Object{"plan": plan, "operation": operation, "history": Object{"items": items, "nextAfter": next}, "permissions": Object{"canApprove": caps["canApproveRestore"] == true && row["state"] == "awaiting-approval", "canExecute": caps["canExecuteRestore"] == true && row["state"] == "approved", "canCancel": caps["canPlanRestore"] == true && includes([]string{"blocked", "awaiting-approval", "approved"}, str(row["state"]))}}), nil
}
