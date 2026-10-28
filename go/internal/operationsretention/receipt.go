package operationsretention

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5/pgconn"
)

// Operation projects only the immutable original product command, never the
// later cleanup result or current run as a substitute for an unknown receipt.
func (s *Service) Operation(ctx context.Context, a Actor, id string) (Object, error) {
	if !uuidValid(id) {
		return nil, fail("invalid_operations_command_receipt", 400)
	}
	if e := s.readable(ctx, a); e != nil {
		return nil, e
	}
	r, e := one(ctx, s.Pool, `SELECT to_jsonb(c) FROM operations_product_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, id)
	state := "not-recorded"
	var kind, result any
	if e != nil {
		var pg *pgconn.PgError
		if !errors.As(e, &pg) || pg.Code != "42P01" {
			return nil, fail("operations_command_receipt_unavailable", 503)
		}
		state = "unknown"
	} else if r != nil {
		state = "unknown"
		if r["operator_id"] != a.ID {
			if e = s.readable(ctx, a); e != nil {
				return nil, e
			}
			return nil, fail("operations_command_receipt_not_found", 404)
		}
		input, run := obj(r["input"]), obj(obj(r["result"])["run"])
		recorded := iso(r["created_at"])
		valid := r["action"] == "retention-request" && len(input) == 2 && input["operationId"] == id && has(targets, str(input["target"])) && run["id"] == id && run["target"] == input["target"] && run["state"] == "queued" && uuidValid(str(run["jobId"])) && iso(run["createdAt"]) != nil && recorded != nil
		if valid {
			canonical, e := identity.Canonical(Object{"action": "retention-request", "input": input})
			if e == nil {
				state, kind = "recorded", "retention-request"
				result = Object{"runId": id, "target": run["target"], "state": "queued", "jobId": run["jobId"], "createdAt": iso(run["createdAt"]), "recordedAt": recorded, "intentHash": identity.Digest(canonical)}
			}
		}
	}
	if e = s.readable(ctx, a); e != nil {
		return nil, e
	}
	now := s.now().Unix()
	return Object{"state": state, "operationId": id, "kind": kind, "result": result, "checkedAt": now, "readExpiresAt": now + 30, "metadataOnly": true}, nil
}
