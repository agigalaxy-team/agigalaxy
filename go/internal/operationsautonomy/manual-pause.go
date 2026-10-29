package operationsautonomy

import (
	"context"
	"github.com/jackc/pgx/v5"
)

func manualWriterSettled(call, receipt Object) bool {
	return call["state"] == "not-admitted" && call["code"] == "operations_autonomy_pause_requested" || receipt != nil && has([]string{"completed", "failed", "no-action"}, str(receipt["state"])) && has([]string{"persisted-domain-operation-receipt", "original-operation-query", "persisted-ai-role-delegation-event"}, str(receipt["basis"]))
}

func (s *Service) manualPauseBlockedWithin(ctx context.Context, tx pgx.Tx, row, completion Object) (bool, error) {
	if has([]string{"unknown", "waiting-human"}, str(completion["disposition"])) || row["human_decision"] != nil {
		return true, nil
	}
	var pending bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_autonomy_tool_calls_v1 c LEFT JOIN operations_autonomy_receipts_v1 r ON r.endpoint=c.endpoint AND r.task_id=c.task_id AND r.operation_id=c.operation_id LEFT JOIN operations_autonomy_decisions_v1 d ON d.endpoint=c.endpoint AND d.task_id=c.task_id AND d.call_id=c.call_id AND d.operation_id=c.operation_id WHERE c.endpoint=$1 AND c.task_id=$2 AND c.state='waiting-human' AND d.decision IS NULL AND COALESCE(r.state,'') NOT IN ('completed','failed','no-action'))`, s.Endpoint, row["id"]).Scan(&pending)
	return pending, err
}

// manualPauseAnchorsWithin exposes only bounded original call coordinates.
// The native side intersects these with its actual current provider batch.
func (s *Service) manualPauseAnchorsWithin(ctx context.Context, tx pgx.Tx, row, completion Object) ([]string, error) {
	blocked, err := s.manualPauseBlockedWithin(ctx, tx, row, completion)
	if err != nil || blocked {
		return []string{}, err
	}
	calls, err := many(ctx, tx, `SELECT to_jsonb(t) FROM (SELECT c.call_id,c.tool,c.state,c.code,r.state AS receipt_state,r.basis AS receipt_basis FROM operations_autonomy_tool_calls_v1 c LEFT JOIN operations_autonomy_receipts_v1 r ON r.endpoint=c.endpoint AND r.task_id=c.task_id AND r.operation_id=c.operation_id WHERE c.endpoint=$1 AND c.task_id=$2 ORDER BY c.updated_at DESC,c.call_id DESC LIMIT 64)t`, s.Endpoint, row["id"])
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, call := range calls {
		if has(dutyWriters, str(call["tool"])) {
			if !manualWriterSettled(call, Object{"state": call["receipt_state"], "basis": call["receipt_basis"]}) {
				continue
			}
		} else if !has([]string{"completed", "failed", "invalid-request"}, str(call["state"])) {
			continue
		}
		ids = append(ids, str(call["call_id"]))
	}
	return ids, nil
}

// settleManualPauseWithin verifies the original native checkpoint against the
// same task's durable call/receipt ledger; it never manufactures an effect.
func (s *Service) settleManualPauseWithin(ctx context.Context, tx pgx.Tx, row, x, completion Object) (bool, error) {
	control, marker := obj(row["control_state"]), obj(x["manualPause"])
	if control["kind"] != "manual-pause" || control["phase"] != "requested" || marker == nil || marker["pauseOperationId"] != control["pauseOperationId"] || x["status"] != "waiting-human" || str(x["nativeRunId"]) == "" {
		return false, nil
	}
	if str(row["native_run_id"]) != "" && row["native_run_id"] != x["nativeRunId"] {
		return false, nil
	}
	if str(control["nativeRunId"]) != "" && control["nativeRunId"] != x["nativeRunId"] {
		return false, nil
	}
	blocked, err := s.manualPauseBlockedWithin(ctx, tx, row, completion)
	if err != nil {
		return false, err
	}
	if blocked {
		return false, nil
	}
	ids := texts(marker["checkpointCallIds"])
	if len(ids) != 1 || !schemaUUID.MatchString(ids[0]) {
		return false, nil
	}
	call, e := optional(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_tool_calls_v1 c WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, s.Endpoint, row["id"], ids[0])
	if e != nil {
		return false, e
	}
	if call == nil {
		return false, nil
	}
	if has(dutyWriters, str(call["tool"])) {
		if !manualWriterSettled(call, nil) {
			receipt, err := optional(ctx, tx, `SELECT to_jsonb(r) FROM operations_autonomy_receipts_v1 r WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3`, s.Endpoint, row["id"], call["operation_id"])
			if err != nil {
				return false, err
			}
			if !manualWriterSettled(call, receipt) {
				return false, nil
			}
		}
	} else if !has([]string{"completed", "failed", "invalid-request"}, str(call["state"])) {
		return false, nil
	}
	control = obj(clone(control))
	control["phase"] = "paused"
	control["nativeRunId"] = x["nativeRunId"]
	control["checkpointCallIds"] = ids
	_, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET control_state=$3,state='paused',model_state=$4,native_run_id=COALESCE(native_run_id,$5),native_continuable=true,lease_until=NULL,revision=revision+1,updated_at=$6,business_state=$7 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], jsonText(control), x["modelState"], x["nativeRunId"], s.now(), completion["businessState"])
	return e == nil, e
}
