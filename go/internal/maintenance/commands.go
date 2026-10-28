package maintenance

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"math"
	"sort"
	"strings"
	"time"
)

type currentActor func(pgx.Tx) (Actor, error)

func (s *Service) command(ctx context.Context, a Actor, action string, input Object, authorize func() (Actor, error), fn func(pgx.Tx, Actor, currentActor) (Object, error)) (Object, error) {
	if e := s.human(a); e != nil {
		return nil, e
	}
	if authorize == nil {
		return nil, failure("maintenance_authorization_unavailable", 503)
	}
	current := func(tx pgx.Tx) (Actor, error) {
		fresh, e := authorize()
		if e != nil {
			return Actor{}, e
		}
		if fresh.ID != a.ID || fresh.Endpoint != a.Endpoint {
			return Actor{}, failure("business_admin_denied", 403)
		}
		permission := str(obj(catalog()["maintenanceActionPermissions"])[action])
		return s.require(ctx, tx, fresh, permission)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := current(tx)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912419))`, s.Endpoint+":maintenance:"+str(input["operationId"])); e != nil {
			return nil, e
		}
		old, e := optional(ctx, tx, `SELECT to_jsonb(e) FROM operations_maintenance_events_v1 e WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, input["operationId"])
		if e != nil {
			return nil, e
		}
		kind := strings.TrimPrefix(action, "maintenance-")
		if old != nil {
			if old["operator_id"] != actor.ID || old["action"] != kind || !sameValues(old["input"], input) {
				return nil, failure("maintenance_operation_conflict", 409)
			}
			if _, e = current(tx); e != nil {
				return nil, e
			}
			result := clone(obj(old["result"]))
			result["replayed"] = true
			return result, nil
		}
		result, e := fn(tx, actor, current)
		if e != nil {
			return nil, e
		}
		result["operationId"], result["recordedAt"] = input["operationId"], Iso(s.now())
		if _, e = current(tx); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_maintenance_events_v1(id,endpoint,operation_id,operator_id,operator_role,action,plan_id,revision,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, uuid.NewString(), s.Endpoint, input["operationId"], actor.ID, actor.Role, kind, result["planId"], result["revision"], input, result, s.now()); e != nil {
			return nil, e
		}
		if e = s.record(ctx, tx, actor, action, Object{"operationId": input["operationId"], "planId": result["planId"], "revision": result["revision"], "kind": kind, "state": result["state"]}); e != nil {
			return nil, e
		}
		return result, nil
	})
}
func (s *Service) freshWrite(ctx context.Context, a Actor, permission string, authorize func() (Actor, error)) (Actor, error) {
	if authorize == nil {
		return Actor{}, failure("maintenance_authorization_unavailable", 503)
	}
	fresh, e := authorize()
	if e != nil {
		return Actor{}, e
	}
	fresh, e = s.current(ctx, fresh, permission)
	if e != nil {
		return Actor{}, e
	}
	if fresh.ID != a.ID || fresh.Endpoint != s.Endpoint {
		return Actor{}, failure("business_admin_denied", 403)
	}
	return fresh, nil
}
func (s *Service) originalNative(ctx context.Context, id string) (Object, error) {
	operation, e := s.nativeRead(ctx, Object{"kind": "operation", "operationId": id})
	if e != nil {
		return nil, e
	}
	if operation == nil || operation["state"] == "not-recorded" {
		return SafeNativeOperation(Object{"id": id, "state": "unknown"}), nil
	}
	return SafeNativeOperation(operation), nil
}
func (s *Service) RunBackup(ctx context.Context, a Actor, input Object, authorize func() (Actor, error)) (Object, error) {
	x, e := ParseBackup(input)
	if e != nil {
		return nil, e
	}
	action := "maintenance-backup-" + str(x["kind"])
	if s.Native == nil {
		return nil, failure("maintenance_native_not_configured", 503)
	}
	receipt, e := s.command(ctx, a, action, x, authorize, func(pgx.Tx, Actor, currentActor) (Object, error) { return Object{"state": "accepted"}, nil })
	if e != nil {
		return nil, e
	}
	fresh, e := s.freshWrite(ctx, a, str(obj(catalog()["maintenanceActionPermissions"])[action]), authorize)
	if e != nil {
		return nil, e
	}
	var operation Object
	if receipt["replayed"] == true {
		operation, e = s.originalNative(ctx, str(x["operationId"]))
	} else {
		intent := Object{"kind": "backup-" + str(x["kind"]), "operationId": x["operationId"], "operatorId": fresh.ID}
		if x["pointId"] != nil {
			intent["pointId"] = x["pointId"]
		}
		var raw Object
		raw, e = s.Native.Call(ctx, intent)
		if e == nil {
			operation = SafeNativeOperation(raw)
		}
	}
	if e != nil {
		return nil, e
	}
	receipt["operation"] = operation
	return receipt, nil
}
func (s *Service) CreatePlan(ctx context.Context, a Actor, input Object, authorize func() (Actor, error)) (Object, error) {
	x, e := ParseCreatePlan(input)
	if e != nil {
		return nil, e
	}
	return s.command(ctx, a, "maintenance-restore-plan", x, authorize, func(tx pgx.Tx, actor Actor, _ currentActor) (Object, error) {
		if s.Native == nil {
			return nil, failure("maintenance_native_not_configured", 503)
		}
		selected := ModuleIDs()
		if x["scope"] != "whole-site" {
			selected = texts(x["moduleIds"])
		}
		preview, e := s.Native.Call(ctx, Object{"kind": "restore-preview", "pointId": x["pointId"], "moduleIds": selected})
		if e != nil {
			return nil, e
		}
		point := Point(obj(preview["point"]))
		if point == nil {
			return nil, failure("maintenance_backup_not_found", 404)
		}
		moduleIDs := selected
		if _, ok := preview["moduleIds"].([]any); ok {
			moduleIDs = []string{}
			for _, id := range ModuleIDs() {
				if includes(texts(preview["moduleIds"]), id) {
					moduleIDs = append(moduleIDs, id)
				}
			}
		} else if _, ok := preview["moduleIds"].([]string); ok {
			moduleIDs = []string{}
			for _, id := range ModuleIDs() {
				if includes(texts(preview["moduleIds"]), id) {
					moduleIDs = append(moduleIDs, id)
				}
			}
		}
		for _, id := range selected {
			if !includes(moduleIDs, id) {
				return nil, failure("maintenance_native_response_invalid", 503)
			}
		}
		modules := []any{}
		blockers := map[string]bool{}
		for _, v := range list(preview["blockers"]) {
			if regexpMaintenanceCode.MatchString(str(v)) {
				blockers[str(v)] = true
			}
		}
		for _, v := range Coverage(point["coverage"]) {
			r := obj(v)
			if includes(moduleIDs, str(r["id"])) {
				modules = append(modules, r)
				if r["state"] != "covered" {
					blockers["maintenance_point_coverage_incomplete"] = true
				}
			}
		}
		if obj(point["integrity"])["state"] != "verified" {
			blockers["maintenance_point_not_verified"] = true
		}
		if preview["productionExecutable"] != true {
			blockers["maintenance_production_adapter_unavailable"] = true
		}
		if !pointPattern.MatchString(str(preview["footprintDigest"])) {
			blockers["maintenance_current_footprint_unknown"] = true
		}
		from := obj(point["capture"])["startedAt"]
		if from == nil {
			from = point["createdAt"]
		}
		var loss any
		if from != nil {
			if started, e := time.Parse(time.RFC3339Nano, str(from)); e == nil {
				seconds := math.Ceil(s.now().Sub(started).Seconds())
				if seconds < 0 {
					seconds = 0
				}
				loss = int64(seconds)
			}
		}
		basis := "unknown"
		if from != nil {
			basis = "point-to-plan-time"
		}
		conditions := []any{}
		for _, id := range OpeningConditions() {
			conditions = append(conditions, Object{"id": id, "state": "required"})
		}
		sorted := []any{}
		keys := []string{}
		for code := range blockers {
			keys = append(keys, code)
		}
		sort.Strings(keys)
		for _, code := range keys {
			sorted = append(sorted, code)
		}
		plan := Object{"version": 1, "scope": x["scope"], "point": point, "moduleIds": moduleIDs, "modules": modules, "footprintDigest": preview["footprintDigest"], "adapterVersion": preview["adapterVersion"], "preservedCurrent": Object{"state": "declared", "items": []any{"accounts", "passwords", "current-permissions", "keys"}, "basis": "current-security-authority"}, "possibleLoss": Object{"from": from, "to": Iso(s.now()), "observedWindowSeconds": loss, "maximumSeconds": nil, "through": "related-writer-pause", "basis": basis}, "openingConditions": conditions, "blockers": sorted}
		digest, e := PlanDigest(plan)
		if e != nil {
			return nil, e
		}
		id, state := uuid.NewString(), "awaiting-approval"
		if len(blockers) > 0 {
			state = "blocked"
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_maintenance_plans_v1(id,endpoint,revision,point_id,state,plan,plan_digest,created_by,created_at,updated_at) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$8)`, id, s.Endpoint, x["pointId"], state, plan, digest, actor.ID, s.now()); e != nil {
			return nil, e
		}
		return Object{"planId": id, "revision": 1, "state": state, "planDigest": digest}, nil
	})
}
func (s *Service) recheckPlan(ctx context.Context, row Object) error {
	preserved := Object{"state": "declared", "items": []any{"accounts", "passwords", "current-permissions", "keys"}, "basis": "current-security-authority"}
	plan := obj(row["plan"])
	if !sameValues(plan["preservedCurrent"], preserved) {
		return failure("maintenance_security_preservation_not_recorded", 409)
	}
	if s.Native == nil {
		return failure("maintenance_native_not_configured", 503)
	}
	x, e := s.Native.Call(ctx, Object{"kind": "restore-preview", "pointId": row["point_id"], "moduleIds": plan["moduleIds"]})
	if e != nil {
		return e
	}
	if x["productionExecutable"] != true || !sameValues(x["footprintDigest"], plan["footprintDigest"]) || !sameValues(x["adapterVersion"], plan["adapterVersion"]) || len(list(x["blockers"])) > 0 || obj(Point(obj(x["point"]))["integrity"])["state"] != "verified" {
		return failure("maintenance_plan_changed", 409)
	}
	return nil
}
func (s *Service) ApprovePlan(ctx context.Context, a Actor, id string, input Object, authorize func() (Actor, error)) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	x, e := ParsePlanCommand("approve", input)
	if e != nil {
		return nil, e
	}
	x["planId"] = id
	return s.command(ctx, a, "maintenance-restore-approve", x, authorize, func(tx pgx.Tx, actor Actor, _ currentActor) (Object, error) {
		row, e := s.rowWithin(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if num(row["revision"]) != num(x["expectedRevision"]) || row["plan_digest"] != x["expectedPlanDigest"] {
			return nil, failure("maintenance_plan_changed", 409)
		}
		if row["state"] != "awaiting-approval" || len(list(obj(row["plan"])["blockers"])) > 0 {
			return nil, failure("maintenance_plan_not_approvable", 409)
		}
		if e = s.recheckPlan(ctx, row); e != nil {
			return nil, e
		}
		revision := num(row["revision"]) + 1
		if _, e = tx.Exec(ctx, `UPDATE operations_maintenance_plans_v1 SET state='approved',revision=$3,approved_by=$4,approved_at=$5,approved_revision=$3,updated_at=$5 WHERE endpoint=$1 AND id=$2`, s.Endpoint, id, revision, actor.ID, s.now()); e != nil {
			return nil, e
		}
		return Object{"planId": id, "revision": revision, "state": "approved"}, nil
	})
}
func (s *Service) ExecutePlan(ctx context.Context, a Actor, id string, input Object, authorize func() (Actor, error)) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	x, e := ParsePlanCommand("execute", input)
	if e != nil {
		return nil, e
	}
	x["planId"] = id
	receipt, e := s.command(ctx, a, "maintenance-restore-execute", x, authorize, func(tx pgx.Tx, _ Actor, current currentActor) (Object, error) {
		row, e := s.rowWithin(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if num(row["revision"]) != num(x["expectedRevision"]) || !sameValues(row["approved_revision"], row["revision"]) || row["state"] != "approved" {
			return nil, failure("maintenance_plan_changed", 409)
		}
		if e = s.recheckPlan(ctx, row); e != nil {
			return nil, e
		}
		if _, e = current(tx); e != nil {
			return nil, e
		}
		revision := num(row["revision"]) + 1
		if _, e = tx.Exec(ctx, `UPDATE operations_maintenance_plans_v1 SET state='preparing',revision=$3,execution_id=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2`, s.Endpoint, id, revision, x["operationId"], s.now()); e != nil {
			return nil, e
		}
		return Object{"planId": id, "revision": revision, "state": "preparing"}, nil
	})
	if e != nil {
		return nil, e
	}
	fresh, e := s.freshWrite(ctx, a, "maintenance.restore.execute", authorize)
	if e != nil {
		return nil, e
	}
	var operation Object
	if receipt["replayed"] == true {
		operation, e = s.originalNative(ctx, str(x["operationId"]))
	} else {
		row, err := s.rowWithin(ctx, s.Pool, id, false)
		if err != nil {
			return nil, err
		}
		plan := obj(row["plan"])
		var raw Object
		raw, e = s.Native.Call(ctx, Object{"kind": "restore-execute", "operationId": x["operationId"], "operatorId": fresh.ID, "planId": id, "revision": row["approved_revision"], "planDigest": row["plan_digest"], "approvedAt": Iso(row["approved_at"]), "pointId": row["point_id"], "moduleIds": plan["moduleIds"], "openingConditions": OpeningConditions(), "footprintDigest": plan["footprintDigest"]})
		if e == nil {
			operation = SafeNativeOperation(raw)
		}
	}
	if e != nil {
		return nil, e
	}
	receipt["operation"] = operation
	return receipt, nil
}
func (s *Service) CancelPlan(ctx context.Context, a Actor, id string, input Object, authorize func() (Actor, error)) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	x, e := ParsePlanCommand("cancel", input)
	if e != nil {
		return nil, e
	}
	x["planId"] = id
	return s.command(ctx, a, "maintenance-restore-cancel", x, authorize, func(tx pgx.Tx, _ Actor, _ currentActor) (Object, error) {
		row, e := s.rowWithin(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if num(row["revision"]) != num(x["expectedRevision"]) || !includes([]string{"blocked", "awaiting-approval", "approved"}, str(row["state"])) {
			return nil, failure("maintenance_plan_changed", 409)
		}
		revision := num(row["revision"]) + 1
		if _, e = tx.Exec(ctx, `UPDATE operations_maintenance_plans_v1 SET state='cancelled',revision=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, id, revision, s.now()); e != nil {
			return nil, e
		}
		return Object{"planId": id, "revision": revision, "state": "cancelled"}, nil
	})
}
