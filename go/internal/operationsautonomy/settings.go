package operationsautonomy

import (
	"context"
	"math"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Authorize func(context.Context) (Actor, error)

func (s *Service) actor(ctx context.Context, tx pgx.Tx, a Actor, action string, authorize Authorize) (Actor, error) {
	if s.AcceptsDuty(a) {
		return Actor{}, fault.New("business_admin_denied", 403)
	}
	if authorize != nil {
		fresh, e := authorize(ctx)
		if e != nil {
			return Actor{}, e
		}
		if fresh.ID != a.ID || fresh.Endpoint != s.Endpoint || fresh.AIProof != nil {
			return Actor{}, fault.New("business_admin_denied", 403)
		}
		a = fresh
	}
	queryAccepted := false
	if accept, ok := s.Authority.(interface{ AcceptsQuery(Actor) bool }); ok {
		queryAccepted = accept.AcceptsQuery(a)
	}
	if s.Authority == nil || a.AIProof != nil && !queryAccepted || s.AcceptsDuty(a) {
		return Actor{}, fault.New("business_admin_denied", 403)
	}
	return s.Authority.RequireWithin(ctx, tx, a, action)
}
func (s *Service) stamp(o Object) Object {
	o["checkedAt"] = s.now().Unix()
	o["readExpiresAt"] = s.now().Unix() + 30
	return o
}
func integer(v any, min, max int64) bool {
	switch n := v.(type) {
	case float64:
		return n >= float64(min) && n <= float64(max) && n == math.Trunc(n)
	case int:
		return int64(n) >= min && int64(n) <= max
	case int64:
		return n >= min && n <= max
	}
	return false
}
func closed(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	for k := range o {
		if !has(required, k) && !has(optional, k) {
			return false
		}
	}
	return true
}
func parseSettings(x Object) (Object, error) {
	if !closed(x, []string{"operationId", "expectedRevision", "concurrency", "healthSeconds", "startGraceSeconds", "roundSeconds", "eventCoalesceSeconds"}, nil) || !schemaUUID.MatchString(str(x["operationId"])) || !integer(x["expectedRevision"], 1, 9007199254740991) {
		return nil, fault.New("invalid_operations_autonomy_request", 400)
	}
	for k, b := range map[string][2]int64{"concurrency": {1, 2}, "healthSeconds": {10, 300}, "startGraceSeconds": {30, 1800}, "roundSeconds": {60, 3600}, "eventCoalesceSeconds": {1, 300}} {
		if !integer(x[k], b[0], b[1]) {
			return nil, fault.New("invalid_operations_autonomy_request", 400)
		}
	}
	return obj(clone(x)), nil
}
func (s *Service) Settings(ctx context.Context, a Actor) (Object, error) {
	if _, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "autonomy.read", nil) }); e != nil {
		return nil, e
	}
	settings, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.RuntimeSettingsWithin(ctx, tx) })
	if e != nil {
		return nil, e
	}
	if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "autonomy.read", nil) }); e != nil {
		return nil, e
	}
	return s.stamp(Object{"settings": settings, "limits": Object{"concurrencyMaximum": 2}}), nil
}
func (s *Service) previousWithin(ctx context.Context, tx pgx.Tx, a Actor, id, kind string, input Object) (Object, error) {
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912480))`, s.Endpoint+":"+id); e != nil {
		return nil, e
	}
	old, e := optional(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, id)
	if e != nil || old == nil {
		return nil, e
	}
	if old["operator_id"] != a.ID || old["kind"] != kind || !sameValue(old["input"], input) {
		return nil, fail("operations_autonomy_operation_conflict")
	}
	if id := str(obj(obj(old["result"])["task"])["id"]); id != "" {
		row, e := s.taskWithin(ctx, tx, id, "")
		if e != nil {
			return nil, e
		}
		if e = s.checkTargetWithin(ctx, tx, a, row, true); e != nil {
			return nil, e
		}
	}
	result := obj(clone(old["result"]))
	result["replayed"] = true
	return s.stamp(result), nil
}
func (s *Service) recordWithin(ctx context.Context, tx pgx.Tx, a Actor, id, kind string, input, result Object) (Object, error) {
	if _, e := tx.Exec(ctx, `INSERT INTO operations_autonomy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, s.Endpoint, id, a.ID, kind, jsonText(input), jsonText(result), s.now()); e != nil {
		return nil, e
	}
	target := obj(result["task"])
	if target == nil {
		target = obj(result["config"])
	}
	_, e := tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,http_request_id,selection,result,created_at,actor_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'business-operator')`, uuid.NewString(), s.Endpoint, a.ID, a.Role, "autonomy-"+kind, id, a.RequestID, jsonText(Object{"id": target["id"]}), jsonText(Object{"kind": kind, "revision": target["revision"]}), s.now())
	if e != nil {
		return nil, e
	}
	return s.stamp(result), nil
}
func (s *Service) SaveSettings(ctx context.Context, a Actor, input Object, authorize Authorize) (Object, error) {
	x, e := parseSettings(input)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.configure", authorize)
		if e != nil {
			return nil, e
		}
		previous, e := s.previousWithin(ctx, tx, actor, str(x["operationId"]), "settings", x)
		if e != nil || previous != nil {
			return previous, e
		}
		if _, e = s.RuntimeSettingsWithin(ctx, tx); e != nil {
			return nil, e
		}
		row, e := one(ctx, tx, `SELECT to_jsonb(r) FROM operations_autonomy_runtime_v1 r WHERE endpoint=$1 FOR UPDATE`, s.Endpoint)
		if e != nil {
			return nil, e
		}
		if num(row["revision"]) != num(x["expectedRevision"]) {
			return nil, fail("operations_autonomy_revision_changed")
		}
		configuration := obj(clone(x))
		delete(configuration, "operationId")
		delete(configuration, "expectedRevision")
		if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_runtime_v1 SET revision=revision+1,configuration=$2,updated_by=$3,updated_at=$4 WHERE endpoint=$1`, s.Endpoint, jsonText(configuration), actor.ID, s.now()); e != nil {
			return nil, e
		}
		revision := num(row["revision"]) + 1
		if _, e = tx.Exec(ctx, `INSERT INTO operations_autonomy_runtime_versions_v1(endpoint,revision,configuration,operator_id,created_at) VALUES($1,$2,$3,$4,$5)`, s.Endpoint, revision, jsonText(configuration), actor.ID, s.now()); e != nil {
			return nil, e
		}
		settings := obj(clone(configuration))
		settings["revision"] = revision
		return s.recordWithin(ctx, tx, actor, str(x["operationId"]), "settings", x, Object{"operationId": x["operationId"], "settings": settings, "replayed": false})
	})
}
