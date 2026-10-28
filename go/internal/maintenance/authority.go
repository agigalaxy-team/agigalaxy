package maintenance

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"unicode/utf8"
)

func ParseNativeAuthorization(input Object) (Object, error) {
	optional := []string{"planId", "revision", "planDigest", "pointId", "moduleIds", "footprintDigest", "openingConditions", "approvedAt"}
	if !closed(input, []string{"operationId", "operatorId", "kind"}, optional) || !uuidPattern.MatchString(str(input["operationId"])) || !includes([]string{"backup-create", "backup-verify", "restore-execute"}, str(input["kind"])) {
		return nil, invalid()
	}
	id, ok := input["operatorId"].(string)
	if !ok || utf8.RuneCountInString(id) < 1 || utf8.RuneCountInString(id) > 500 {
		return nil, invalid()
	}
	for _, key := range []string{"planId"} {
		if v, ok := input[key]; ok && !uuidPattern.MatchString(str(v)) {
			return nil, invalid()
		}
	}
	for _, key := range []string{"planDigest", "pointId", "footprintDigest"} {
		if v, ok := input[key]; ok && !pointPattern.MatchString(str(v)) {
			return nil, invalid()
		}
	}
	if v, ok := input["revision"]; ok && !whole(v, 1, 9007199254740991) {
		return nil, invalid()
	}
	if v, ok := input["approvedAt"]; ok && !isoDate(v) {
		return nil, invalid()
	}
	if v, ok := input["moduleIds"]; ok && !modules(v, 0, 9007199254740991) {
		return nil, invalid()
	}
	if v, ok := input["openingConditions"]; ok {
		if _, ok := v.([]any); !ok {
			if _, ok := v.([]string); !ok {
				return nil, invalid()
			}
		}
		for _, id := range texts(v) {
			if !includes(OpeningConditions(), id) {
				return nil, invalid()
			}
		}
	}
	return clone(input), nil
}
func (s *Service) AuthorizeNative(ctx context.Context, input Object) (Object, error) {
	x, e := ParseNativeAuthorization(input)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, e := optional(ctx, tx, `SELECT to_jsonb(e) FROM operations_maintenance_events_v1 e WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, x["operationId"])
		if e != nil {
			return nil, e
		}
		denied := func() (Object, error) { return nil, failure("maintenance_execution_not_authorized", 403) }
		if row == nil || row["operator_id"] != x["operatorId"] || row["action"] != x["kind"] {
			return denied()
		}
		if s.StoredAuthority == nil {
			return nil, failure("maintenance_authorization_unavailable", 503)
		}
		permission := str(obj(catalog()["maintenanceActionPermissions"])["maintenance-"+str(x["kind"])])
		if e = s.StoredAuthority.Revalidate(ctx, tx, str(row["operator_id"]), permission); e != nil {
			return nil, e
		}
		actor, e := s.StoredAuthority.PersonWithin(ctx, tx, str(row["operator_id"]), false)
		if e != nil {
			return nil, e
		}
		if actor.ID != row["operator_id"] || actor.Endpoint != s.Endpoint || !includes(actor.Permissions, permission) {
			return denied()
		}
		if x["kind"] == "backup-verify" && x["pointId"] != obj(row["input"])["pointId"] {
			return denied()
		}
		if x["kind"] == "restore-execute" {
			plan, e := s.rowWithin(ctx, tx, str(row["plan_id"]), false)
			if e != nil {
				return nil, e
			}
			data := obj(plan["plan"])
			if x["planId"] != plan["id"] || !sameValues(x["revision"], plan["approved_revision"]) || x["planDigest"] != plan["plan_digest"] || plan["execution_id"] != x["operationId"] || plan["approved_by"] == nil || !includes([]string{"preparing", "restoring", "validating", "ready-to-open", "opening"}, str(plan["state"])) || x["pointId"] != plan["point_id"] || x["footprintDigest"] != data["footprintDigest"] || !sameValues(x["moduleIds"], data["moduleIds"]) || !sameValues(x["openingConditions"], OpeningConditions()) || x["approvedAt"] != Iso(plan["approved_at"]) {
				return denied()
			}
		}
		return Object{"authorized": true, "operationId": x["operationId"], "operatorId": actor.ID, "kind": x["kind"], "endpoint": s.Endpoint}, nil
	})
}
func (s *Service) Operation(ctx context.Context, a Actor, id string) (Object, error) {
	actor, e := s.current(ctx, a, "maintenance.read")
	if e != nil {
		return nil, e
	}
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	row, e := optional(ctx, s.Pool, `SELECT to_jsonb(e) FROM(SELECT operator_id,action,plan_id FROM operations_maintenance_events_v1 WHERE endpoint=$1 AND operation_id=$2)e`, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return nil, failure("maintenance_operation_not_found", 404)
	}
	raw, e := s.nativeRead(ctx, Object{"kind": "operation", "operationId": id})
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, actor, "maintenance.read"); e != nil {
		return nil, e
	}
	var operation any
	availability := Availability("unavailable", "maintenance_native_not_connected")
	if raw != nil {
		operation = SafeNativeOperation(raw)
		availability = Availability("available", nil)
	}
	return s.envelope(Object{"operation": operation, "availability": availability}), nil
}
