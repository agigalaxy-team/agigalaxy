package messaging

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func missingTable(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "42P01"
}
func (s *Service) CommandResult(ctx context.Context, a Actor, operationID string) (Object, error) {
	if !uuidOK(operationID) {
		return nil, failure("invalid_operations_command_receipt", 400)
	}
	check := func() error {
		_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.require(ctx, tx, a, "notices.read") })
		return e
	}
	if e := check(); e != nil {
		return nil, e
	}
	rows, e := many(ctx, s.Pool, "SELECT to_jsonb(c) FROM operations_messaging_commands_v1 c WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, operationID)
	unavailable := missingTable(e)
	if e != nil && !unavailable {
		return nil, failure("operations_command_receipt_unavailable", 503)
	}
	state := "not-recorded"
	var kind, result any
	if unavailable {
		state = "unknown"
	} else if len(rows) > 0 {
		state = "unknown"
		for _, row := range rows {
			if str(row["operator_id"]) != a.ID {
				if e := check(); e != nil {
					return nil, e
				}
				return nil, failure("operations_command_receipt_not_found", 404)
			}
		}
		if len(rows) == 1 {
			row := rows[0]
			saved := obj(row["result"])
			plan, run := obj(saved["plan"]), obj(saved["run"])
			id, version, revision, storedState := plan["id"], plan["version"], plan["revision"], plan["state"]
			if plan == nil {
				id = run["planId"]
				version = run["planVersion"]
				revision = run["revision"]
				storedState = run["state"]
			}
			storedKind := str(row["kind"])
			valid := contains([]string{"create", "save", "activate", "pause", "resume", "stop", "withdraw", "retry"}, storedKind) && uuidOK(id) && intOK(version, 1, 9007199254740991) && intOK(revision, 1, 9007199254740991)
			if storedKind == "retry" {
				valid = valid && uuidOK(run["id"]) && contains([]string{"running", "paused", "blocked", "completed", "cancelled", "expired"}, str(storedState))
			} else {
				valid = valid && contains([]string{"draft", "active", "paused", "stopped"}, str(storedState))
			}
			if valid {
				var exists bool
				e = s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operations_messaging_plans_v1 WHERE endpoint=$1 AND id=$2)", s.Endpoint, id).Scan(&exists)
				if e != nil && !missingTable(e) {
					return nil, failure("operations_command_receipt_unavailable", 503)
				}
				valid = e == nil && exists
				if valid && run["id"] != nil {
					e = s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operations_messaging_runs_v1 WHERE endpoint=$1 AND id=$2 AND plan_id=$3)", s.Endpoint, run["id"], id).Scan(&exists)
					if e != nil && !missingTable(e) {
						return nil, failure("operations_command_receipt_unavailable", 503)
					}
					valid = e == nil && exists
				}
			}
			if valid {
				value := Object{"planId": id, "version": version, "revision": revision, "state": storedState}
				if storedKind == "retry" {
					value["runId"] = run["id"]
				}
				effects := obj(saved["effects"])
				effectView := Object{}
				for _, key := range []string{"futureExecutionStopped", "alreadySubmittedEmailRetracted", "existingPublicationsWithdrawn"} {
					if v, ok := effects[key].(bool); ok {
						effectView[key] = v
					}
				}
				if len(effectView) == 3 {
					value["effects"] = effectView
				}
				kind = storedKind
				result = value
				state = "recorded"
			}
		}
	}
	if e := check(); e != nil {
		return nil, e
	}
	return Object{"state": state, "operationId": operationID, "kind": kind, "result": result, "checkedAt": s.now().Unix(), "readExpiresAt": s.now().Unix() + 30, "metadataOnly": true}, nil
}
