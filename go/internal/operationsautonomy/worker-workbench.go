package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (w *Worker) ReconcileWorkbench(ctx context.Context) error {
	s := w.Service
	if s.WorkbenchRunDetail == nil {
		return nil
	}
	rows, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) ([]Object, error) {
		return many(ctx, tx, `SELECT to_jsonb(t) FROM(SELECT t.id,t.domain,r.native_run_id,r.turn_operation_id FROM operations_autonomy_workbench_runs_v1 r JOIN operations_autonomy_tasks_v1 t ON t.endpoint=r.endpoint AND t.id=r.task_id WHERE r.endpoint=$1 AND r.native_run_id IS NOT NULL AND r.state IN ('running','unknown','waiting-human') AND t.state NOT IN ('stopped','blocked') ORDER BY r.updated_at LIMIT 10)t`, s.Endpoint)
	})
	if e != nil {
		return e
	}
	for _, row := range rows {
		e := func() error {
			value, e := s.WorkbenchRunDetail(ctx, str(row["native_run_id"]))
			if e != nil {
				return e
			}
			run := obj(value["run"])
			if run == nil || run["runId"] != row["native_run_id"] || str(run["domain"]) != "" && run["domain"] != row["domain"] {
				return nil
			}
			model := map[string]string{"PENDING": "accepted", "RUNNING": "running", "COMPLETED": "completed", "PAUSED": "running", "CANCELLED": "cancelled", "ERROR": "failed"}[str(run["state"])]
			if model == "" {
				model = "unknown"
			}
			status := "unknown"
			switch run["state"] {
			case "COMPLETED":
				status = "completed"
			case "PAUSED":
				status = "waiting-human"
			case "CANCELLED", "ERROR":
				status = "failed"
			case "RUNNING", "PENDING":
				status = "running"
			}
			tokens := obj(run["tokens"])
			usage := Object{"calls": finite(run["calls"]), "inputTokens": finite(tokens["input"]), "outputTokens": finite(tokens["output"]), "totalTokens": finite(tokens["total"]), "durationMs": finite(run["durationMs"])}
			_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
				if _, e := s.UpdateWorkbenchWithin(ctx, tx, WorkbenchUpdate{OperationID: str(row["id"]), TurnOperationID: ptr(row["turn_operation_id"]), NativeRunID: ptr(row["native_run_id"]), ModelState: &model, Status: &status, Usage: usage}); e != nil {
					return false, e
				}
				receipts, e := many(ctx, tx, `SELECT to_jsonb(r) FROM public.galaxy_autonomy_workbench_receipts_v1($1,$2)r`, s.Endpoint, row["id"])
				if e != nil {
					return false, e
				}
				for _, r := range receipts {
					state := "waiting-human"
					if r["state"] == "completed" {
						state = "completed"
					}
					receipt := &BusinessReceipt{OperationID: str(r["operation_id"]), Action: str(r["action"]), TargetType: ptr(r["target_type"]), TargetID: ptr(r["target_id"]), State: str(r["state"]), Details: obj(r["details"]), Basis: "workbench-original-domain-receipt"}
					if _, e = s.UpdateWorkbenchWithin(ctx, tx, WorkbenchUpdate{OperationID: str(row["id"]), TurnOperationID: ptr(row["turn_operation_id"]), Status: &state, Receipt: receipt}); e != nil {
						return false, e
					}
				}
				return true, nil
			})
			return e
		}()
		if e != nil {
			s.log(Object{"event": "autonomy_workbench_reconcile_deferred", "taskId": row["id"], "code": errorCode(e)})
		}
	}
	return nil
}
