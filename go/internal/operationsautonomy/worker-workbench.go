package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (w *Worker) ReconcileWorkbench(ctx context.Context) error {
	s := w.Service
	// Reconcile persisted card facts even when a worker has no native run reader.
	// The run and operation IDs remain the original ones; no operation is sent.
	pending, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) ([]Object, error) {
		return many(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT t.id,r.turn_operation_id FROM operations_autonomy_tasks_v1 t JOIN operations_autonomy_workbench_runs_v1 r ON r.endpoint=t.endpoint AND r.task_id=t.id CROSS JOIN LATERAL public.galaxy_autonomy_workbench_card_states_v1(t.endpoint,t.id) c WHERE t.endpoint=$1 AND t.state='waiting-human' AND r.model_state='completed' AND r.turn_operation_id::text=COALESCE(NULLIF(t.configuration#>>'{externalWorkbench,turnOperationId}',''),t.id::text) AND (c.processing OR c.unknown OR c.binding_invalid OR EXISTS(SELECT 1 FROM operations_autonomy_receipts_v1 u WHERE u.endpoint=t.endpoint AND u.task_id=t.id AND u.state='unknown') OR (NOT c.prepared AND (c.unavailable OR c.cancelled) AND NOT EXISTS(SELECT 1 FROM operations_autonomy_tool_calls_v1 x WHERE x.endpoint=t.endpoint AND x.task_id=t.id AND x.state='waiting-human' AND NOT EXISTS(SELECT 1 FROM operations_autonomy_decisions_v1 d WHERE d.endpoint=x.endpoint AND d.task_id=x.task_id AND d.call_id=x.call_id AND d.operation_id=x.operation_id) AND NOT EXISTS(SELECT 1 FROM operations_autonomy_receipts_v1 z WHERE z.endpoint=x.endpoint AND z.task_id=x.task_id AND z.operation_id=x.operation_id AND z.state IN ('completed','failed','no-action') AND z.basis IN ('persisted-domain-operation-receipt','original-operation-query','persisted-ai-role-delegation-event'))))) ORDER BY t.updated_at LIMIT 10) q`, s.Endpoint)
	})
	if e != nil {
		return e
	}
	for _, row := range pending {
		_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
			current, err := optional(ctx, tx, `SELECT to_jsonb(t) FROM operations_autonomy_tasks_v1 t JOIN operations_autonomy_workbench_runs_v1 r ON r.endpoint=t.endpoint AND r.task_id=t.id WHERE t.endpoint=$1 AND t.id=$2 AND t.state='waiting-human' AND r.turn_operation_id=$3 AND r.turn_operation_id::text=COALESCE(NULLIF(t.configuration#>>'{externalWorkbench,turnOperationId}',''),t.id::text) AND r.model_state='completed' FOR UPDATE OF t`, s.Endpoint, row["id"], row["turn_operation_id"])
			if err != nil || current == nil {
				return current, err
			}
			status, model := "completed", "completed"
			return s.UpdateWorkbenchWithin(ctx, tx, WorkbenchUpdate{OperationID: str(row["id"]), TurnOperationID: ptr(row["turn_operation_id"]), Status: &status, ModelState: &model})
		})
		if e != nil {
			s.log(Object{"event": "autonomy_workbench_card_reconcile_deferred", "taskId": row["id"], "code": errorCode(e)})
		}
	}
	if s.WorkbenchRunDetail == nil {
		return nil
	}
	rows, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) ([]Object, error) {
		return many(ctx, tx, `SELECT to_jsonb(t) FROM (SELECT task_id AS id,domain,native_run_id,turn_operation_id,conversation_id,session_id,operator_id,ai_account_id FROM public.galaxy_autonomy_workbench_observations_v1($1,NULL))t`, s.Endpoint)
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
			if run == nil || run["runId"] != row["native_run_id"] || run["domain"] != row["domain"] || run["componentType"] != "agent" || run["componentId"] != "galaxy-conversation-"+str(row["domain"]) || run["conversationId"] != row["conversation_id"] || run["sessionId"] != row["session_id"] {
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
				// Lock the task before rechecking the durable original binding. The
				// observer never transfers a result to a later retry turn.
				current, e := s.taskWithin(ctx, tx, str(row["id"]), " FOR UPDATE")
				if e != nil || current == nil {
					return false, e
				}
				binding, e := optional(ctx, tx, `SELECT to_jsonb(t) FROM (SELECT task_id AS id,domain,native_run_id,turn_operation_id,conversation_id,session_id,operator_id,ai_account_id FROM public.galaxy_autonomy_workbench_observations_v1($1,$2))t`, s.Endpoint, row["id"])
				if e != nil || binding == nil || !sameValue(binding, row) {
					return false, e
				}
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
