package operationsautonomy

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) Operation(ctx context.Context, a Actor, id string) (Object, error) {
	if !schemaUUID.MatchString(id) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.read", nil)
		if e != nil {
			return nil, e
		}
		row, e := optional(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, id)
		if e != nil {
			return nil, e
		}
		if row == nil {
			return s.stamp(Object{"state": "not-recorded", "operationId": id}), nil
		}
		if row["operator_id"] != actor.ID {
			return nil, fault.New("operations_autonomy_operation_not_found", 404)
		}
		if taskID := str(obj(obj(row["result"])["task"])["id"]); taskID != "" {
			task, e := s.taskWithin(ctx, tx, taskID, "")
			if e != nil {
				return nil, e
			}
			if e = s.checkTargetWithin(ctx, tx, actor, task, true); e != nil {
				return nil, e
			}
		}
		return s.stamp(Object{"state": "recorded", "operationId": id, "kind": row["kind"], "result": row["result"]}), nil
	})
}
func (s *Service) Run(ctx context.Context, a Actor, domain string, input Object, authorize Authorize) (Object, error) {
	if !closed(input, []string{"operationId"}, nil) || !schemaUUID.MatchString(str(input["operationId"])) {
		return nil, invalid()
	}
	if _, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "autonomy.control", authorize) }); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.control", authorize)
		if e != nil {
			return nil, e
		}
		intent := obj(clone(input))
		intent["domain"] = domain
		prior, e := s.previousWithin(ctx, tx, actor, str(input["operationId"]), "run", intent)
		if e != nil || prior != nil {
			return prior, e
		}
		if e = s.EnsureWithin(ctx, tx); e != nil {
			return nil, e
		}
		cfg, e := s.configWithin(ctx, tx, domain, "")
		if e != nil {
			return nil, e
		}
		if cfg["enabled"] != true {
			return nil, fail("operations_autonomy_plan_disabled")
		}
		task, e := s.createTaskWithin(ctx, tx, cfg, TaskInput{ID: str(input["operationId"]), Source: "routine", Key: "manual:" + str(input["operationId"])})
		if e != nil {
			return nil, e
		}
		view, e := s.taskViewWithin(ctx, tx, task, actor, true, true)
		if e != nil {
			return nil, e
		}
		return s.recordWithin(ctx, tx, actor, str(input["operationId"]), "run", intent, Object{"operationId": input["operationId"], "task": view, "replayed": false})
	})
}
func (s *Service) enqueueReconcileWithin(ctx context.Context, tx pgx.Tx, row Object) error {
	if s.EnqueueWithin == nil {
		return nil
	}
	return s.EnqueueWithin(ctx, tx, "autonomy-task", Object{"taskId": row["id"], "reconcile": true}, fmt.Sprintf("%s:reconcile:%d", str(row["id"]), s.now().Unix()/30), nil)
}
func parseControl(input Object) (Object, error) {
	if !closed(input, []string{"operationId", "expectedRevision", "kind"}, nil) || !schemaUUID.MatchString(str(input["operationId"])) || !integer(input["expectedRevision"], 1, 9007199254740991) || !has([]string{"pause", "resume", "stop", "takeover", "reconcile"}, str(input["kind"])) {
		return nil, invalid()
	}
	return obj(clone(input)), nil
}
func (s *Service) Control(ctx context.Context, a Actor, id string, input Object, authorize Authorize) (Object, error) {
	if !schemaUUID.MatchString(id) {
		return nil, invalid()
	}
	x, e := parseControl(input)
	if e != nil {
		return nil, e
	}
	if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "autonomy.control", authorize) }); e != nil {
		return nil, e
	}
	var nativeBefore, continueTask Object
	if x["kind"] == "resume" {
		candidate, e := s.readTask(ctx, id)
		if e != nil {
			return nil, e
		}
		if candidate["source"] != "workbench" && str(candidate["native_run_id"]) != "" && candidate["state"] == "waiting-human" && obj(candidate["human_decision"])["kind"] != "takeover" {
			if s.Native == nil {
				return nil, fault.New("operations_agentos_not_configured", 503)
			}
			nativeBefore, e = s.Native.Read(ctx, candidate)
			if e != nil {
				return nil, e
			}
		}
	}
	result, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.control", authorize)
		if e != nil {
			return nil, e
		}
		intent := obj(clone(x))
		intent["id"] = id
		prior, e := s.previousWithin(ctx, tx, actor, str(x["operationId"]), "control", intent)
		if e != nil || prior != nil {
			return prior, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912483))`, s.Endpoint); e != nil {
			return nil, e
		}
		reference, e := s.taskWithin(ctx, tx, id, "")
		if e != nil {
			return nil, e
		}
		cfg, e := s.configWithin(ctx, tx, str(reference["domain"]), " FOR SHARE")
		if e != nil {
			return nil, e
		}
		row, e := s.taskWithin(ctx, tx, id, " FOR UPDATE")
		if e != nil {
			return nil, e
		}
		if e = s.checkTargetWithin(ctx, tx, actor, row, true); e != nil {
			return nil, e
		}
		if num(row["revision"]) != num(x["expectedRevision"]) {
			return nil, fail("operations_autonomy_revision_changed")
		}
		finish := func(task Object) (Object, error) {
			view, e := s.taskViewWithin(ctx, tx, task, actor, true, true)
			if e != nil {
				return nil, e
			}
			return s.recordWithin(ctx, tx, actor, str(x["operationId"]), "control", intent, Object{"operationId": x["operationId"], "task": view, "replayed": false})
		}
		if x["kind"] == "reconcile" {
			if e = s.enqueueReconcileWithin(ctx, tx, row); e != nil {
				return nil, e
			}
			return finish(row)
		}
		if has(terminal, str(row["state"])) {
			return nil, fail("operations_autonomy_task_terminal")
		}
		state := map[string]string{"stop": "stopped", "takeover": "waiting-human", "pause": "paused", "resume": "queued"}[str(x["kind"])]
		if x["kind"] == "resume" {
			if !has([]string{"paused", "waiting-human", "unknown"}, str(row["state"])) {
				return nil, fail("operations_autonomy_not_paused")
			}
			if row["source"] == "workbench" {
				return nil, fail("operations_autonomy_workbench_continuation_required")
			}
			if cfg["enabled"] != true {
				return nil, fail("operations_autonomy_plan_disabled")
			}
			if row["dispatch_started_at"] != nil {
				continuation, e := s.TaskContinuationWithin(ctx, tx, id)
				if e != nil {
					return nil, e
				}
				if nativeBefore["status"] != "PAUSED" || nativeBefore["continuable"] != true || nativeBefore["nativeRunId"] != row["native_run_id"] || continuation["allowed"] != true {
					return nil, fail("operations_autonomy_original_run_not_resumable")
				}
				settings, e := s.RuntimeSettingsWithin(ctx, tx)
				if e != nil {
					return nil, e
				}
				busy, e := many(ctx, tx, `SELECT to_jsonb(t) FROM(SELECT domain FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND state IN ('running','unknown') AND dispatch_started_at IS NOT NULL AND source<>'workbench' AND id<>$2)t`, s.Endpoint, row["id"])
				if e != nil {
					return nil, e
				}
				if int64(len(busy)) >= num(settings["concurrency"]) {
					return nil, fail("operations_autonomy_concurrency_busy")
				}
				for _, r := range busy {
					if r["domain"] == row["domain"] {
						return nil, fail("operations_autonomy_concurrency_busy")
					}
				}
				state = "running"
			}
		}
		decision := row["human_decision"]
		if x["kind"] == "takeover" {
			decision = Object{"kind": "takeover", "operatorId": actor.ID, "at": s.now().UTC().Format("2006-01-02T15:04:05.000Z")}
		} else if x["kind"] == "resume" {
			decision = nil
		}
		var decisionJSON, lease any
		if decision != nil {
			decisionJSON = jsonText(decision)
		}
		if state == "running" {
			round := obj(obj(row["configuration"])["runtime"])["roundSeconds"]
			if round == nil {
				settings, e := s.RuntimeSettingsWithin(ctx, tx)
				if e != nil {
					return nil, e
				}
				round = settings["roundSeconds"]
			}
			lease = s.now().Add(time.Duration(num(round)) * time.Second)
		}
		saved, e := one(ctx, tx, `UPDATE operations_autonomy_tasks_v1 SET state=$3,human_decision=$4,native_continuable=false,lease_owner=NULL,lease_until=$6,revision=revision+1,updated_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_autonomy_tasks_v1)`, s.Endpoint, id, state, decisionJSON, s.now(), lease)
		if e != nil {
			return nil, e
		}
		if state == "running" && x["kind"] == "resume" {
			if _, e = s.DutyForTaskWithin(ctx, tx, str(saved["id"]), "query"); e != nil {
				return nil, e
			}
			continueTask = saved
		}
		if state == "queued" && s.EnqueueWithin != nil {
			if e = s.EnqueueWithin(ctx, tx, "autonomy-task", Object{"taskId": id}, fmt.Sprintf("%s:resume:%d", id, num(saved["revision"])), nil); e != nil {
				return nil, e
			}
		}
		return finish(saved)
	})
	if e != nil {
		return nil, e
	}
	if has([]string{"stop", "pause", "takeover"}, str(x["kind"])) && str(obj(result["task"])["nativeRunId"]) != "" && s.Native != nil {
		row, e := s.readTask(ctx, id)
		if e != nil {
			return nil, e
		}
		_, _ = s.Native.Cancel(ctx, row)
	}
	if continueTask != nil {
		var value Object
		if s.Native == nil {
			e = fault.New("operations_agentos_not_configured", 503)
		} else {
			value, e = s.Native.Continue(ctx, continueTask)
		}
		if e == nil {
			model := value["modelState"]
			if model == nil {
				model = "accepted"
			}
			_, e = s.Report(ctx, Object{"taskId": id, "nativeRunId": continueTask["native_run_id"], "modelState": model, "status": "running"})
		}
		if e != nil {
			if _, save := s.Pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='unknown',model_state='unknown',code=$3,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 AND state='running'`, s.Endpoint, id, errorCode(e), s.now()); save != nil {
				return nil, save
			}
		}
	}
	return result, nil
}
func (s *Service) Decide(ctx context.Context, a Actor, id string, input Object, authorize Authorize) (Object, error) {
	if !closed(input, []string{"operationId", "expectedRevision", "callId", "decision"}, nil) || !schemaUUID.MatchString(str(input["operationId"])) || !schemaUUID.MatchString(str(input["callId"])) || !integer(input["expectedRevision"], 1, 9007199254740991) || !has([]string{"rejected", "cancelled", "no-action"}, str(input["decision"])) {
		return nil, invalid()
	}
	x := obj(clone(input))
	if _, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "autonomy.control", authorize) }); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.control", authorize)
		if e != nil {
			return nil, e
		}
		intent := obj(clone(x))
		intent["id"] = id
		prior, e := s.previousWithin(ctx, tx, actor, str(x["operationId"]), "decision", intent)
		if e != nil || prior != nil {
			return prior, e
		}
		reference, e := s.taskWithin(ctx, tx, id, "")
		if e != nil {
			return nil, e
		}
		if _, e = s.configWithin(ctx, tx, str(reference["domain"]), " FOR SHARE"); e != nil {
			return nil, e
		}
		row, e := s.taskWithin(ctx, tx, id, " FOR UPDATE")
		if e != nil {
			return nil, e
		}
		if e = s.checkTargetWithin(ctx, tx, actor, row, true); e != nil {
			return nil, e
		}
		if num(row["revision"]) != num(x["expectedRevision"]) {
			return nil, fail("operations_autonomy_revision_changed")
		}
		if row["state"] != "waiting-human" || row["source"] == "workbench" || obj(row["human_decision"])["kind"] == "takeover" {
			return nil, fail("operations_autonomy_decision_not_pending")
		}
		call, e := optional(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_tool_calls_v1 c WHERE endpoint=$1 AND task_id=$2 AND call_id=$3 AND state='waiting-human' FOR UPDATE`, s.Endpoint, id, x["callId"])
		if e != nil {
			return nil, e
		}
		if call == nil {
			return nil, fail("operations_autonomy_decision_not_pending")
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_autonomy_decisions_v1(endpoint,task_id,call_id,operation_id,decision_operation_id,operator_id,decision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(endpoint,task_id,call_id) DO NOTHING`, s.Endpoint, id, x["callId"], call["operation_id"], x["operationId"], actor.ID, x["decision"], s.now()); e != nil {
			return nil, e
		}
		recorded, e := one(ctx, tx, `SELECT to_jsonb(d) FROM operations_autonomy_decisions_v1 d WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, s.Endpoint, id, x["callId"])
		if e != nil {
			return nil, e
		}
		if recorded["decision_operation_id"] != x["operationId"] {
			return nil, fail("operations_autonomy_decision_already_recorded")
		}
		saved, e := one(ctx, tx, `UPDATE operations_autonomy_tasks_v1 SET human_decision=$3,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_autonomy_tasks_v1)`, s.Endpoint, id, jsonText(Object{"kind": "resolved", "operatorId": actor.ID, "operationId": call["operation_id"], "decision": x["decision"], "at": s.now().UTC().Format("2006-01-02T15:04:05.000Z")}), s.now())
		if e != nil {
			return nil, e
		}
		view, e := s.taskViewWithin(ctx, tx, saved, actor, true, true)
		if e != nil {
			return nil, e
		}
		return s.recordWithin(ctx, tx, actor, str(x["operationId"]), "decision", intent, Object{"operationId": x["operationId"], "task": view, "replayed": false})
	})
}
