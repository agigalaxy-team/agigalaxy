package maintenance

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
)

func (s *Service) CommandResult(ctx context.Context, a Actor, id string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, failure("invalid_operations_command_receipt", 400)
	}
	if e := s.human(a); e != nil {
		return nil, e
	}
	actor, e := s.current(ctx, a, "maintenance.read")
	if e != nil {
		return nil, e
	}
	rows, e := many(ctx, s.Pool, `SELECT to_jsonb(e) FROM(SELECT operator_id,action,plan_id,revision,jsonb_build_object('planId',result->'planId','revision',result->'revision','state',result->'state') AS receipt FROM operations_maintenance_events_v1 WHERE endpoint=$1 AND operation_id=$2)e`, s.Endpoint, id)
	unavailable := false
	if e != nil {
		var p *pgconn.PgError
		if errors.As(e, &p) && p.Code == "42P01" {
			unavailable = true
		} else {
			return nil, failure("operations_command_receipt_unavailable", 503)
		}
	}
	state := "unknown"
	var kind, result any
	if !unavailable {
		if len(rows) == 0 {
			state = "not-recorded"
		}
		for _, r := range rows {
			if r["operator_id"] != actor.ID {
				if _, e = s.current(ctx, actor, "maintenance.read"); e != nil {
					return nil, e
				}
				return nil, failure("operations_command_receipt_not_found", 404)
			}
		}
		if len(rows) == 1 {
			r := rows[0]
			k := map[string]string{"backup-create": "create", "backup-verify": "verify", "restore-plan": "plan", "restore-approve": "approve", "restore-execute": "execute", "restore-cancel": "cancel"}[str(r["action"])]
			x := obj(r["receipt"])
			if k != "" && x != nil {
				var projected Object
				if includes([]string{"create", "verify"}, k) {
					if x["state"] == "accepted" {
						projected = Object{"state": "accepted"}
					}
				} else if uuidPattern.MatchString(str(x["planId"])) && x["planId"] == r["plan_id"] && whole(x["revision"], 1, 9007199254740991) && sameValues(x["revision"], r["revision"]) && includes([]string{"blocked", "awaiting-approval", "approved", "preparing", "cancelled"}, str(x["state"])) {
					projected = Object{"planId": x["planId"], "revision": x["revision"], "state": x["state"]}
				}
				if projected != nil && projected["planId"] != nil {
					var found bool
					err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_maintenance_plans_v1 WHERE endpoint=$1 AND id=$2)`, s.Endpoint, projected["planId"]).Scan(&found)
					if err != nil {
						var p *pgconn.PgError
						if !errors.As(err, &p) || p.Code != "42P01" {
							return nil, failure("operations_command_receipt_unavailable", 503)
						}
						found = false
					}
					if !found {
						projected = nil
					}
				}
				if projected != nil {
					state, kind, result = "recorded", k, projected
				}
			}
		}
	}
	if _, e = s.current(ctx, actor, "maintenance.read"); e != nil {
		return nil, e
	}
	return s.envelope(Object{"state": state, "operationId": id, "kind": kind, "result": result}), nil
}
