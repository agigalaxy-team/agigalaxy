package operationsretention

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"regexp"
	"strconv"
	"strings"
)

func (s *Service) readable(ctx context.Context, a Actor) error {
	if s.Authority == nil {
		return fail("operations_authorization_unavailable", 503)
	}
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.Authority.RequireWithin(ctx, tx, a, "retention.read") })
	return e
}
func (s *Service) row(ctx context.Context, q Reader, id string, lock bool) (Object, error) {
	if _, e := uuid.Parse(id); e != nil {
		return nil, invalid()
	}
	sql := `SELECT to_jsonb(r) FROM operations_retention_runs_v1 r WHERE endpoint=$1 AND id=$2`
	if lock {
		sql += " FOR UPDATE"
	}
	r, e := one(ctx, q, sql, s.Endpoint, id)
	if e == nil && r == nil {
		e = fail("operations_retention_not_found", 404)
	}
	return r, e
}
func (s *Service) Get(ctx context.Context, a Actor, id string) (Object, error) {
	if e := s.readable(ctx, a); e != nil {
		return nil, e
	}
	r, e := s.row(ctx, s.Pool, id, false)
	if e != nil {
		return nil, e
	}
	return Object{"run": view(r)}, nil
}

var pageAfter = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

func page(input Object) (any, int, error) {
	limit := 30
	var after any
	for k, v := range input {
		switch k {
		case "limit":
			if !integer(v, 1, 100) {
				return nil, 0, invalid()
			}
			limit = int(num(v))
		case "after":
			text := str(v)
			n, e := strconv.ParseInt(text, 10, 64)
			if e != nil || !pageAfter.MatchString(text) {
				return nil, 0, invalid()
			}
			after = n
		default:
			return nil, 0, invalid()
		}
	}
	return after, limit, nil
}
func (s *Service) List(ctx context.Context, a Actor, input Object) (Object, error) {
	if e := s.readable(ctx, a); e != nil {
		return nil, e
	}
	after, limit, e := page(input)
	if e != nil {
		return nil, e
	}
	rows, e := s.Pool.Query(ctx, `SELECT to_jsonb(r)||jsonb_build_object('sequence',sequence::text) FROM operations_retention_runs_v1 r WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3`, s.Endpoint, after, limit+1)
	if e != nil {
		return nil, e
	}
	records, e := collect(rows)
	if e != nil {
		return nil, e
	}
	var next any
	if len(records) > limit {
		next = records[limit-1]["sequence"]
		records = records[:limit]
	}
	items := []any{}
	for _, r := range records {
		items = append(items, view(r))
	}
	return Object{"items": items, "nextAfter": next, "checkedAt": s.now().Unix()}, nil
}
func (s *Service) Request(ctx context.Context, a Actor, input Object) (Object, error) {
	if len(input) != 2 || !has(targets, str(input["target"])) || !uuidValid(str(input["operationId"])) {
		return nil, invalid()
	}
	if s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.domain().Operation(ctx, tx, a, "retention-request", input)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, s.Endpoint+":operations-product:"+str(input["operationId"])); e != nil {
			return nil, e
		}
		old, e := one(ctx, tx, `SELECT to_jsonb(c) FROM operations_product_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, input["operationId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			if old["operator_id"] != actor.ID || old["action"] != "retention-request" || !same(old["input"], input) {
				return nil, fail("operations_command_changed", 409)
			}
			out := clone(obj(old["result"]))
			out["replayed"] = true
			return out, nil
		}
		saved := Object{"kind": "business-operator", "operatorId": actor.ID, "endpoint": actor.Endpoint, "role": actor.Role, "httpRequestId": actor.RequestID}
		if actor.AIProof != nil || s.domain().IsDuty(actor) || s.domain().IsExecution(actor) {
			return nil, fail("business_admin_denied", 403)
		}
		r, e := one(ctx, tx, `INSERT INTO operations_retention_runs_v1 AS r(id,endpoint,target,state,requested_by,request_actor,created_at,updated_at) VALUES($1,$2,$3,'queued',$4,$5,$6,$6) RETURNING to_jsonb(r)`, input["operationId"], s.Endpoint, input["target"], actor.ID, saved, s.now())
		if e != nil {
			return nil, e
		}
		if s.EnqueueWithin == nil {
			return nil, fail("operations_retention_queue_unavailable", 503)
		}
		jobID, e := s.EnqueueWithin(ctx, tx, str(r["id"]))
		if e != nil {
			return nil, e
		}
		if jobID == "" {
			return nil, fail("operations_retention_queue_unavailable", 503)
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_retention_runs_v1 SET job_id=$2 WHERE id=$1`, r["id"], jobID); e != nil {
			return nil, e
		}
		r["job_id"] = jobID
		result := Object{"run": view(r)}
		var maxRows, maxRoots any = 100, nil
		if input["target"] == "information-watches" {
			maxRows, maxRoots = nil, 100
		}
		if e = s.domain().Record(ctx, tx, actor, "retention-request", Object{"runId": r["id"], "target": input["target"]}, Object{"state": "queued", "maximumRowsPerRun": maxRows, "maximumRootsPerRun": maxRoots}, input["operationId"]); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_product_commands_v1(endpoint,operation_id,operator_id,action,input,result,created_at) VALUES($1,$2,$3,'retention-request',$4,$5,$6)`, s.Endpoint, input["operationId"], actor.ID, input, result, s.now()); e != nil {
			return nil, e
		}
		result["replayed"] = false
		return result, nil
	})
}
func uuidValid(s string) bool {
	u, e := uuid.Parse(s)
	return e == nil && len(s) == 36 && (u == uuid.Nil || strings.EqualFold(s, "ffffffff-ffff-ffff-ffff-ffffffffffff") || u.Variant() == uuid.RFC4122 && u.Version() >= 1 && u.Version() <= 8)
}

// CancelWithin is invoked only by the owning queue's existing authorized
// cancellation transaction; it does not add a public cancellation route.
func (s *Service) CancelWithin(ctx context.Context, tx pgx.Tx, runID string) error {
	r, e := s.row(ctx, tx, runID, true)
	if e != nil {
		return e
	}
	if r["state"] == "completed" {
		return fail("operations_retention_not_cancellable", 409)
	}
	if r["state"] != "cancelled" {
		_, e = tx.Exec(ctx, `UPDATE operations_retention_runs_v1 SET state='cancelled',updated_at=$2,finished_at=$2 WHERE id=$1`, runID, s.now())
	}
	return e
}
