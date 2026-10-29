package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"time"
)

// recoverUnsent is restricted to the pre-HTTP configuration error, an
// explicitly recorded control command, and an original NOT_RECORDED lookup.
// After the CAS, any lost response is reconciled, never dispatched again.
func (w *Worker) recoverUnsent(ctx context.Context, old Object) (Object, error) {
	s := w.Service
	row, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912483))`, s.Endpoint); e != nil {
			return nil, e
		}
		ref, e := s.taskWithin(ctx, tx, str(old["id"]), "")
		if e != nil {
			return nil, e
		}
		cfg, e := s.configWithin(ctx, tx, str(ref["domain"]), " FOR SHARE")
		if e != nil {
			return nil, e
		}
		current, e := s.taskWithin(ctx, tx, str(old["id"]), " FOR UPDATE")
		if e != nil {
			return nil, e
		}
		if current["state"] != "unknown" || current["code"] != "operations_agentos_not_configured" || current["source"] == "workbench" || current["native_run_id"] != nil || current["human_decision"] != nil || current["dispatch_started_at"] == nil || cfg["enabled"] != true || num(cfg["revision"]) != num(current["config_revision"]) {
			return nil, nil
		}
		var clear bool
		if e = tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2) AND NOT EXISTS(SELECT 1 FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2)`, s.Endpoint, current["id"]).Scan(&clear); e != nil {
			return nil, e
		}
		if !clear {
			return nil, nil
		}
		command, e := optional(ctx, tx, `SELECT to_jsonb(c) FROM (SELECT operation_id FROM operations_autonomy_commands_v1 WHERE endpoint=$1 AND kind='control' AND input->>'kind'='reconcile' AND input->>'id'=$2 AND result->'task'->>'id'=$2 AND result->'task'->>'state'='unknown' AND result->'task'->>'code'='operations_agentos_not_configured' AND (result->'task'->>'revision')::bigint<=$3 ORDER BY created_at DESC LIMIT 1) c`, s.Endpoint, str(current["id"]), num(current["revision"]))
		if e != nil {
			return nil, e
		}
		if command == nil {
			return nil, nil
		}
		settings, e := s.refreshSettingsWithin(ctx, tx)
		if e != nil {
			return nil, e
		}
		var count int
		var same bool
		if e = tx.QueryRow(ctx, `SELECT count(*)::int,COALESCE(bool_or(domain=$3),false) FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id<>$2 AND state IN ('running','unknown') AND source<>'workbench' AND dispatch_started_at IS NOT NULL`, s.Endpoint, current["id"], current["domain"]).Scan(&count, &same); e != nil {
			return nil, e
		}
		if int64(count) >= num(settings["concurrency"]) || same {
			return nil, nil
		}
		round := obj(obj(current["configuration"])["runtime"])["roundSeconds"]
		if round == nil {
			round = settings["roundSeconds"]
		}
		claimed, e := one(ctx, tx, `UPDATE operations_autonomy_tasks_v1 SET state='running',model_state='dispatching',code='dispatch-recovering',lease_owner=$3,lease_until=$4,revision=revision+1,updated_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_autonomy_tasks_v1)`, s.Endpoint, current["id"], w.ownerID(), s.now().Add(time.Duration(num(round))*time.Second), s.now())
		if e != nil {
			return nil, e
		}
		if _, e = s.DutyForTaskWithin(ctx, tx, str(current["id"]), "query"); e != nil {
			return nil, e
		}
		claimed["reconcileOperationId"] = command["operation_id"]
		return claimed, nil
	})
	if e != nil {
		return nil, e
	}
	if row == nil {
		return Object{"state": "unknown"}, nil
	}
	s.log(Object{"event": "autonomy_unsent_recovery", "taskId": row["id"], "code": "dispatch-recovering", "reconcileOperationId": row["reconcileOperationId"]})
	value, e := s.Native.Run(ctx, row)
	if e != nil {
		_, save := s.Pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='unknown',model_state='unknown',code='dispatch-recovering',revision=revision+1,updated_at=$3 WHERE endpoint=$1 AND id=$2 AND state='running' AND code='dispatch-recovering'`, s.Endpoint, row["id"], s.now())
		return Object{"state": "unknown"}, save
	}
	if row["mode"] == "code" {
		state := str(value["state"])
		if state == "" {
			state = "unknown"
			switch value["status"] {
			case "COMPLETED":
				state = "completed"
			case "PAUSED":
				state = "waiting-human"
			case "ERROR":
				state = "failed"
			case "CANCELLED":
				state = "stopped"
			}
		}
		return Object{"state": state}, nil
	}
	model := value["modelState"]
	if model == nil {
		model = "accepted"
	}
	status := "running"
	if value["awaitingHuman"] == true {
		status = "waiting-human"
	}
	report := Object{"taskId": row["id"], "modelState": model, "status": status}
	run := value["nativeRunId"]
	if run == nil {
		run = value["runId"]
	}
	if str(run) != "" {
		report["nativeRunId"] = run
	}
	return s.Report(ctx, report)
}
