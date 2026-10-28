package filegovernance

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

func accessReceipt(r Object) Object {
	var until any
	if r["stopped_until"] != nil {
		until = timestamp(r["stopped_until"]).Unix()
	}
	return Object{"kind": r["kind"], "id": r["file_id"], "action": r["action"], "revision": r["revision"], "stopped": str(r, "action") == "stop", "until": until, "operationId": r["operation_id"], "recordedAt": iso(r["created_at"])}
}
func (s *Service) AccessOperation(ctx context.Context, a Actor, operationID string) (Object, error) {
	if !fileUUID.MatchString(operationID) {
		return nil, invalid()
	}
	return s.run(ctx, a, "file-access-read", Object{"id": operationID, "view": "operation"}, func(tx pgx.Tx, current Actor) (Object, error) {
		r, e := row(ctx, tx, "SELECT to_jsonb(e) FROM operations_file_access_events_v1 e WHERE endpoint=$1 AND operation_id=$2 AND operator_id=$3", s.Endpoint, operationID, current.ID)
		if e != nil {
			return nil, e
		}
		out := s.readMeta()
		out["state"], out["operationId"] = "not-recorded", operationID
		if r != nil {
			out["state"] = "recorded"
			for k, v := range accessReceipt(r) {
				out[k] = v
			}
		}
		return out, nil
	})
}
func (s *Service) ChangeAccess(ctx context.Context, a Actor, kind, id string, input Object) (Object, error) {
	x, e := ParseAccessChange(input)
	if e != nil || !fileUUID.MatchString(id) {
		return nil, invalid()
	}
	if _, e = s.adapter(kind, false); e != nil {
		return nil, e
	}
	action := "files.access." + str(x, "action")
	if _, e = s.current(ctx, a, action); e != nil {
		return nil, e
	}
	result, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		current, e := s.fresh(ctx, tx, a, action)
		if e != nil {
			return nil, e
		}
		if e = s.principal(ctx, tx, current); e != nil {
			return nil, e
		}
		if s.isDuty(current) {
			current, e = s.operation(ctx, tx, current, "file-access-"+str(x, "action"), Object{"id": id, "kind": kind, "operationId": x["operationId"], "command": x})
			if e != nil {
				return nil, e
			}
		}
		operation := str(x, "operationId")
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912391))", s.Endpoint+":operations:"+operation); e != nil {
			return nil, e
		}
		old, e := row(ctx, tx, "SELECT to_jsonb(e) FROM operations_file_access_events_v1 e WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, operation)
		if e != nil {
			return nil, e
		}
		if old != nil {
			var until any
			if old["stopped_until"] != nil {
				until = timestamp(old["stopped_until"]).Unix()
			}
			if str(old, "operator_id") != current.ID || str(old, "kind") != kind || str(old, "file_id") != id || old["action"] != x["action"] || str(old, "expected_version") != str(x, "expectedVersion") || num(old, "expected_revision") != num(x, "expectedRevision") || old["reason"] != x["reason"] || until != func() any {
				if x["until"] != nil {
					return num(x, "until")
				}
				return nil
			}() {
				return nil, fail("business_admin_operation_conflict", 409)
			}
			if _, e = s.fresh(ctx, tx, a, action); e != nil {
				return nil, e
			}
			receipt := accessReceipt(old)
			receipt["replayed"] = true
			return receipt, nil
		}
		var auditExists bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2)", s.Endpoint, operation).Scan(&auditExists); e != nil {
			return nil, e
		}
		if auditExists {
			return nil, fail("business_admin_operation_conflict", 409)
		}
		r, e := s.scopedRow(ctx, tx, kind, id, true)
		if e != nil {
			return nil, e
		}
		access, e := AccessWithin(ctx, tx, s.Endpoint, kind, id, s.now(), false)
		if e != nil {
			return nil, e
		}
		if ProcessingVersion(r) != str(x, "expectedVersion") {
			return nil, fail("operations_file_changed", 409)
		}
		if num(access, "revision") != num(x, "expectedRevision") {
			return nil, fail("operations_file_access_changed", 409)
		}
		stop := str(x, "action") == "stop"
		if stop {
			if num(x, "until") <= s.now() {
				return nil, fail("operations_file_access_until", 400)
			}
			pending, e := s.authorPending(ctx, tx, kind, r)
			if e != nil {
				return nil, e
			}
			if r["purged_at"] != nil || r["revoked_at"] != nil || truth(r, "purge_pending") || due(expiry(r), s.now()) || pending {
				return nil, fail("operations_file_access_unavailable", 409)
			}
			if truth(access, "stopped") {
				return nil, fail("operations_file_access_changed", 409)
			}
		} else {
			if !truth(access, "stopped") {
				return nil, fail("operations_file_access_changed", 409)
			}
			reason, e := s.blocked(ctx, tx, kind, r)
			if e != nil {
				return nil, e
			}
			if reason != nil {
				return nil, fail("operations_file_access_restore_unavailable", 409)
			}
		}
		revision := num(access, "revision") + 1
		var until any
		if stop {
			until = time.Unix(num(x, "until"), 0)
		}
		at := s.stamp()
		if _, e = s.fresh(ctx, tx, a, action); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_file_access_events_v1(id,endpoint,kind,file_id,revision,operation_id,operator_id,action,stopped_until,reason,expected_version,expected_revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, uuid.NewString(), s.Endpoint, kind, id, revision, operation, current.ID, x["action"], until, x["reason"], x["expectedVersion"], num(x, "expectedRevision"), at); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_file_access_heads_v1(endpoint,kind,file_id,revision,stopped_until,operation_id,operator_id,reason,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(endpoint,kind,file_id) DO UPDATE SET revision=EXCLUDED.revision,stopped_until=EXCLUDED.stopped_until,operation_id=EXCLUDED.operation_id,operator_id=EXCLUDED.operator_id,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at`, s.Endpoint, kind, id, revision, until, operation, current.ID, x["reason"], at); e != nil {
			return nil, e
		}
		out := Object{"kind": kind, "id": id, "action": x["action"], "revision": revision, "stopped": stop, "until": x["until"], "operationId": operation, "recordedAt": iso(at)}
		audit := Object{}
		for k, v := range out {
			audit[k] = v
		}
		audit["until"] = iso(until)
		if e = s.record(ctx, tx, current, "file-access-"+str(x, "action"), Object{"kind": kind, "id": id, "resourceId": id, "action": x["action"], "revision": revision, "until": x["until"]}, audit, operation); e != nil {
			return nil, e
		}
		if _, e = s.fresh(ctx, tx, a, action); e != nil {
			return nil, e
		}
		if stop && num(x, "until") <= s.now() {
			return nil, fail("operations_file_access_until", 400)
		}
		if !stop {
			reason, e := s.blocked(ctx, tx, kind, r)
			if e != nil {
				return nil, e
			}
			if reason != nil {
				return nil, fail("operations_file_access_restore_unavailable", 409)
			}
		}
		out["replayed"] = false
		return out, nil
	})
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, action); e != nil {
		return nil, e
	}
	result["file"], e = s.Get(ctx, a, kind, id)
	if e != nil {
		return nil, e
	}
	for k, v := range s.readMeta() {
		result[k] = v
	}
	return result, nil
}
