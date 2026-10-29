package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// A recovery proof is a read-only capability for one original call. It cannot
// be minted from HTTP fields or used to bind or execute another operation.
func (s *Service) recoveryDutyAuthorizationWithin(ctx context.Context, tx pgx.Tx, p *dutyProof) error {
	r, err := s.taskWithin(ctx, tx, p.input.TaskID, " FOR SHARE")
	if err != nil {
		return err
	}
	if r["source"] == "workbench" || !has([]string{"unknown", "failed"}, str(r["state"])) || r["domain"] != p.input.Domain || r["ai_account_id"] != p.input.AIAccountID || r["config_id"] != p.input.PlanID || num(r["plan_version"]) != p.input.PlanVersion || obj(r["configuration"])["purpose"] != p.input.Purpose || str(r["native_run_id"]) != p.recoveryRun || p.recoveryRun == "" || p.input.AccessPurpose != "query" {
		return dutyFail("operations_ai_duty_operation_denied")
	}
	if err = RequireNativeAttempt(r, Object{"nativeAttemptId": p.input.NativeAttemptID}); err != nil {
		return err
	}
	c, err := optional(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_tool_calls_v1 c WHERE endpoint=$1 AND task_id=$2 AND call_id=$3 AND operation_id=$4`, s.Endpoint, r["id"], p.audit["callId"], p.audit["operationId"])
	if err != nil {
		return err
	}
	if c == nil || !has(dutyWriters, str(c["tool"])) || c["state"] == "not-admitted" {
		return dutyFail("operations_ai_duty_operation_denied")
	}
	matched, err := s.originalCallCoordinatesWithin(ctx, tx, r, c, p.recoveryRun)
	if err != nil {
		return err
	}
	if !matched {
		return dutyFail("operations_ai_duty_operation_denied")
	}
	return nil
}

func (s *Service) originalCallCoordinatesWithin(ctx context.Context, tx pgx.Tx, row, call Object, runID string) (bool, error) {
	if str(call["native_run_id"]) == "" && str(call["native_attempt_id"]) == "" && str(row["native_attempt_id"]) == "" && row["native_run_id"] == runID && runID != "" {
		var retried bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_autonomy_commands_v1 WHERE endpoint=$1 AND kind='control' AND input->>'id'=$2 AND input->>'kind'='retry')`, s.Endpoint, row["id"]).Scan(&retried); err != nil {
			return false, err
		}
		return !retried, nil
	}
	return call["native_run_id"] == runID && str(call["native_attempt_id"]) == str(row["native_attempt_id"]), nil
}

func (s *Service) dutyForOriginalRecoveryWithin(ctx context.Context, tx pgx.Tx, row, call Object, runID string) (Actor, error) {
	cfg := obj(row["configuration"])
	var delegation *int64
	if row["delegation_version"] != nil {
		v := num(row["delegation_version"])
		delegation = &v
	}
	p := &dutyProof{owner: s, recovery: true, recoveryRun: runID, audit: Object{"kind": "ai", "callId": call["call_id"], "operationId": call["operation_id"]}, input: DutyInput{Domain: str(row["domain"]), AIAccountID: str(row["ai_account_id"]), TaskID: str(row["id"]), Purpose: str(cfg["purpose"]), AccessPurpose: "query", PlanID: str(row["config_id"]), PlanVersion: num(row["plan_version"]), DelegationVersion: delegation, NativeAttemptID: str(row["native_attempt_id"]), ResourceIDs: texts(obj(cfg["plan"])["resourceIds"])}}
	return s.currentDuty(ctx, tx, p)
}

// ReconcileOriginalWrites reads only the task's already recorded operations;
// it never creates or executes a replacement and does not change task state.
func (s *Service) ReconcileOriginalWrites(ctx context.Context, taskID, runID string) (Object, error) {
	calls, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) ([]Object, error) {
		row, e := s.taskWithin(ctx, tx, taskID, " FOR SHARE")
		if e != nil {
			return nil, e
		}
		if !has([]string{"unknown", "failed"}, str(row["state"])) || row["native_run_id"] != runID || runID == "" {
			return nil, fail("operations_autonomy_task_inactive")
		}
		return many(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_tool_calls_v1 c LEFT JOIN operations_autonomy_receipts_v1 r ON r.endpoint=c.endpoint AND r.task_id=c.task_id AND r.operation_id=c.operation_id WHERE c.endpoint=$1 AND c.task_id=$2 AND c.tool=ANY($3::text[]) AND c.state NOT IN ('waiting-human','not-admitted') AND (r.state IS NULL OR r.state='unknown') ORDER BY c.created_at,c.call_id LIMIT 20`, s.Endpoint, taskID, dutyWriters)
	})
	if err != nil {
		return nil, err
	}
	out := []Object{}
	for _, call := range calls {
		actor, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) {
			row, e := s.taskWithin(ctx, tx, taskID, " FOR SHARE")
			if e != nil {
				return Actor{}, e
			}
			a, e := s.dutyForOriginalRecoveryWithin(ctx, tx, row, call, runID)
			if e != nil {
				return Actor{}, e
			}
			if e = s.checkTargetWithin(ctx, tx, a, row, true); e != nil {
				return Actor{}, e
			}
			return a, nil
		})
		if e != nil {
			out = append(out, Object{"callId": call["call_id"], "state": "unknown"})
			continue
		}
		result, e := s.dutyTool(ctx, Object{"id": taskID, "ai_account_id": actor.ID[3:]}, actor, str(call["operation_id"]), str(call["tool"]), obj(call["arguments"]), true)
		if e != nil || result == nil || !has([]string{"completed", "failed"}, str(result["effectState"])) || obj(result["businessReceipt"]) == nil {
			out = append(out, Object{"callId": call["call_id"], "state": "unknown"})
			continue
		}
		_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
			row, e := s.taskWithin(ctx, tx, taskID, " FOR UPDATE")
			if e != nil {
				return false, e
			}
			fresh, e := s.dutyForOriginalRecoveryWithin(ctx, tx, row, call, runID)
			if e != nil {
				return false, e
			}
			if e = s.checkTargetWithin(ctx, tx, fresh, row, true); e != nil {
				return false, e
			}
			receipt := obj(result["businessReceipt"])
			if result["operationId"] != call["operation_id"] {
				return false, fail("operations_autonomy_operation_conflict")
			}
			if e = s.RecordBusinessReceiptWithin(ctx, tx, BusinessReceipt{TaskID: taskID, OperationID: str(call["operation_id"]), Action: str(receipt["action"]), TargetType: ptr(receipt["targetType"]), TargetID: ptr(receipt["targetId"]), State: str(receipt["state"]), Basis: str(receipt["basis"]), Details: obj(receipt["details"])}); e != nil {
				return false, e
			}
			_, e = tx.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET state=$5,updated_at=$6 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3 AND operation_id=$4 AND state IN ('started','unknown')`, s.Endpoint, taskID, call["call_id"], call["operation_id"], result["effectState"], s.now())
			return e == nil, e
		})
		state := "unknown"
		if e == nil {
			state = str(result["effectState"])
		}
		out = append(out, Object{"callId": call["call_id"], "state": state})
	}
	return Object{"operations": out, "basis": "original-operation-query"}, nil
}
