package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) recordTypedPreDispatchRejection(ctx context.Context, x Object, operationID string, rejection *PreparationRejection) (bool, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		// Match the original dispatch lock ordering before taking the task lock.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912487))`, s.Endpoint+":"+operationID); err != nil {
			return false, err
		}
		row, err := s.taskWithin(ctx, tx, str(x["taskId"]), " FOR UPDATE")
		if err != nil {
			return false, err
		}
		if err = RequireNativeAttempt(row, x); err != nil {
			return false, err
		}
		if str(row["native_run_id"]) != "" && row["native_run_id"] != x["nativeRunId"] {
			return false, fail("operations_autonomy_operation_conflict")
		}
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2)`, s.Endpoint, operationID).Scan(&exists); err != nil {
			return false, err
		}
		if exists {
			return false, nil
		}
		outcome := Object{"preDispatch": Object{"phase": rejection.Phase(), "basis": "typed-pre-dispatch-rejection"}}
		result, err := tx.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET state='not-admitted',code=$5,read_outcome=$6,updated_at=$7 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3 AND operation_id=$4 AND tool='execute-operation' AND state IN ('started','unknown')`, s.Endpoint, x["taskId"], x["callId"], operationID, errorCode(rejection), jsonText(outcome), s.now())
		return err == nil && result.RowsAffected() == 1, err
	})
}

// ResolvePreDispatchAbsenceWithin is called only under the retry task UPDATE
// fence, after the original native ERROR has been verified by its caller.
// It proves absence only for the two P13 kinds with known original ledgers.
func (s *Service) ResolvePreDispatchAbsenceWithin(ctx context.Context, tx pgx.Tx, row Object) error {
	if s.ValidateDutyRequest == nil || !has([]string{"unknown", "failed"}, str(row["state"])) || str(row["native_run_id"]) == "" {
		return nil
	}
	calls, err := many(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_tool_calls_v1 c WHERE endpoint=$1 AND task_id=$2 AND tool='execute-operation' AND state IN ('started','unknown') ORDER BY created_at,call_id LIMIT 100`, s.Endpoint, row["id"])
	if err != nil {
		return err
	}
	for _, call := range calls {
		kind := str(obj(call["arguments"])["kind"])
		if !has([]string{"ordinary-strategy-create-draft", "strategy-rehearsal"}, kind) {
			continue
		}
		if _, err = s.ValidateDutyRequest(obj(call["arguments"])); err != nil {
			continue
		}
		matched, e := s.originalCallCoordinatesWithin(ctx, tx, row, call, str(row["native_run_id"]))
		if e != nil {
			return e
		}
		if !matched {
			continue
		}
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM operations_p13_strategy_rehearsals_v1 WHERE endpoint=$1 AND id=$2) OR EXISTS(SELECT 1 FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$3 AND operation_id=$2)`, s.Endpoint, call["operation_id"], row["id"]).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		outcome := Object{"preDispatch": Object{"phase": "not-dispatched", "basis": "fenced-original-absence"}}
		if _, err = tx.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET state='not-admitted',read_outcome=$5,updated_at=$6 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3 AND operation_id=$4 AND state IN ('started','unknown')`, s.Endpoint, row["id"], call["call_id"], call["operation_id"], jsonText(outcome), s.now()); err != nil {
			return err
		}
	}
	return nil
}
