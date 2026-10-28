package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"regexp"
)

var nativeRunPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var modelStates = []string{"not-started", "dispatching", "accepted", "running", "completed", "failed", "cancelled", "unknown", "not-required"}

func parseReport(input Object) (Object, error) {
	if !closed(input, []string{"taskId", "modelState", "status"}, []string{"nativeRunId", "code", "summary"}) || !schemaUUID.MatchString(str(input["taskId"])) || !has(modelStates, str(input["modelState"])) || !has([]string{"running", "waiting-human", "completed", "failed", "unknown"}, str(input["status"])) {
		return nil, invalid()
	}
	if v, ok := input["nativeRunId"]; ok && !nativeRunPattern.MatchString(str(v)) {
		return nil, invalid()
	}
	if v, ok := input["code"]; ok && !safeCode.MatchString(str(v)) {
		return nil, invalid()
	}
	if v, ok := input["summary"]; ok {
		if _, ok := text(v, 0, 4000, false); !ok {
			return nil, invalid()
		}
	}
	return obj(clone(input)), nil
}
func (s *Service) Report(ctx context.Context, input Object) (Object, error) {
	x, e := parseReport(input)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, e := s.taskWithin(ctx, tx, str(x["taskId"]), " FOR UPDATE")
		if e != nil {
			return nil, e
		}
		if row["dispatch_started_at"] == nil {
			return nil, fail("operations_autonomy_task_inactive")
		}
		if str(row["native_run_id"]) != "" && str(x["nativeRunId"]) != "" && row["native_run_id"] != x["nativeRunId"] {
			return nil, fail("operations_autonomy_operation_conflict")
		}
		if has(terminal, str(row["state"])) || has([]string{"paused", "waiting-human"}, str(row["state"])) && row["human_decision"] != nil {
			if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET native_run_id=COALESCE(native_run_id,$3),model_state=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], x["nativeRunId"], x["modelState"]); e != nil {
				return nil, e
			}
			return s.stamp(Object{"taskId": row["id"], "state": row["state"]}), nil
		}
		receipts, e := many(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT state FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2)r`, s.Endpoint, row["id"])
		if e != nil {
			return nil, e
		}
		business := str(row["business_state"])
		for _, state := range []string{"unknown", "failed", "completed", "no-action"} {
			found := false
			for _, r := range receipts {
				found = found || r["state"] == state
			}
			if found {
				business = state
				break
			}
		}
		state := str(x["status"])
		if state == "completed" && row["effective_check"] != true && business != "completed" && business != "no-action" {
			state = "waiting-human"
		}
		done := state == "completed" || state == "failed"
		code := x["code"]
		if code == nil && state == "waiting-human" && x["status"] == "completed" {
			code = "effective-check-required"
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state=$3,model_state=$4,business_state=$5,native_run_id=COALESCE(native_run_id,$6),code=$7,lease_until=CASE WHEN $8 OR $3='waiting-human' THEN NULL ELSE lease_until END,completed_at=CASE WHEN $8 THEN $9 ELSE completed_at END,revision=revision+1,updated_at=$9 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], state, x["modelState"], business, x["nativeRunId"], code, done, s.now()); e != nil {
			return nil, e
		}
		if state == "completed" && row["effective_check"] == true {
			if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET last_valid_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["config_id"], s.now()); e != nil {
				return nil, e
			}
		}
		return s.stamp(Object{"taskId": row["id"], "state": state, "modelState": x["modelState"], "businessState": business}), nil
	})
}
func (s *Service) WaitForHumanWithin(ctx context.Context, tx pgx.Tx, taskID, operationID, code string) error {
	if code == "" {
		code = "operations_autonomy_human_required"
	}
	row, e := s.taskWithin(ctx, tx, taskID, " FOR UPDATE")
	if e != nil {
		return e
	}
	if has(terminal, str(row["state"])) {
		return nil
	}
	_, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='waiting-human',human_decision=$3,lease_until=NULL,revision=revision+1,code=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2`, s.Endpoint, taskID, jsonText(Object{"kind": "decision-required", "operationId": operationID, "code": code, "at": s.now().UTC().Format("2006-01-02T15:04:05.000Z")}), code, s.now())
	return e
}
