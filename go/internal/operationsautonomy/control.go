package operationsautonomy

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
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
	return s.EnqueueWithin(ctx, tx, "autonomy-task", taskJobInput(row, true), fmt.Sprintf("%s:reconcile:%d", str(row["id"]), s.now().Unix()/30), nil)
}
func parseControl(input Object) (Object, error) {
	if !closed(input, []string{"operationId", "kind"}, []string{"expectedRevision", "expectedControlRevision", "expectedNativeRunId", "expectedNativeAttemptId"}) || !schemaUUID.MatchString(str(input["operationId"])) || !has([]string{"pause", "resume", "stop", "takeover", "reconcile", "retry"}, str(input["kind"])) {
		return nil, invalid()
	}
	if input["expectedControlRevision"] != nil {
		_, hasRun := input["expectedNativeRunId"]
		_, hasAttempt := input["expectedNativeAttemptId"]
		if !has([]string{"pause", "resume"}, str(input["kind"])) || !hasRun || !hasAttempt || !integer(input["expectedControlRevision"], 1, 9007199254740991) || input["expectedRevision"] != nil {
			return nil, invalid()
		}
		if input["expectedNativeRunId"] != nil && (str(input["expectedNativeRunId"]) == "" || len(str(input["expectedNativeRunId"])) > 128) {
			return nil, invalid()
		}
		if input["expectedNativeAttemptId"] != nil && !uuidPattern.MatchString(str(input["expectedNativeAttemptId"])) {
			return nil, invalid()
		}
	} else if !integer(input["expectedRevision"], 1, 9007199254740991) || input["expectedNativeRunId"] != nil || input["expectedNativeAttemptId"] != nil {
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
	if x["kind"] == "retry" {
		if !uuidPattern.MatchString(str(x["operationId"])) {
			return nil, invalid()
		}
		// Same control operation is replayed before consulting a changed native.
		prior, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
			actor, err := s.actor(ctx, tx, a, "autonomy.control", authorize)
			if err != nil {
				return nil, err
			}
			intent := obj(clone(x))
			intent["id"] = id
			prior, err := s.previousWithin(ctx, tx, actor, str(x["operationId"]), "control", intent)
			if err != nil || prior != nil {
				return prior, err
			}
			row, err := s.taskWithin(ctx, tx, id, "")
			if err != nil {
				return nil, err
			}
			if err = s.checkTargetWithin(ctx, tx, actor, row, true); err != nil {
				return nil, err
			}
			if num(row["revision"]) != num(x["expectedRevision"]) {
				return nil, fail("operations_autonomy_revision_changed")
			}
			return nil, nil
		})
		if err != nil || prior != nil {
			return prior, err
		}
		candidate, err := s.readTask(ctx, id)
		if err != nil {
			return nil, err
		}
		if s.Native == nil {
			return nil, fault.New("operations_agentos_not_configured", 503)
		}
		nativeBefore, err = s.Native.Read(ctx, candidate)
		if err != nil {
			return nil, err
		}
		if nativeBefore["status"] != "ERROR" || nativeBefore["taskId"] != candidate["id"] || nativeBefore["nativeRunId"] != candidate["native_run_id"] || nativeBefore["sessionId"] != candidate["session_id"] || RequireNativeAttempt(candidate, nativeBefore) != nil {
			return nil, fail("operations_autonomy_original_run_not_retryable")
		}
		if _, err = s.ReconcileOriginalWrites(ctx, id, str(candidate["native_run_id"])); err != nil {
			return nil, err
		}
	}
	if x["kind"] == "resume" {
		candidate, e := s.readTask(ctx, id)
		if e != nil {
			return nil, e
		}
		if candidate["source"] != "workbench" && str(candidate["native_run_id"]) != "" && (candidate["state"] == "waiting-human" && obj(candidate["human_decision"])["kind"] != "takeover" || candidate["state"] == "paused" && obj(candidate["control_state"])["phase"] == "paused") {
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
		if x["expectedControlRevision"] != nil {
			if num(row["control_revision"]) != num(x["expectedControlRevision"]) || str(row["native_run_id"]) != str(x["expectedNativeRunId"]) || str(row["native_attempt_id"]) != str(x["expectedNativeAttemptId"]) {
				return nil, fail("operations_autonomy_revision_changed")
			}
		} else if num(row["revision"]) != num(x["expectedRevision"]) {
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
		if x["kind"] == "retry" {
			if row["source"] == "workbench" || row["mode"] != "ai" || !has([]string{"failed", "unknown"}, str(row["state"])) || row["human_decision"] != nil || cfg["enabled"] != true || str(row["native_run_id"]) == "" || str(row["session_id"]) == "" {
				return nil, fail("operations_autonomy_original_run_not_retryable")
			}
			if nativeBefore["status"] != "ERROR" || nativeBefore["taskId"] != row["id"] || nativeBefore["nativeRunId"] != row["native_run_id"] || nativeBefore["sessionId"] != row["session_id"] || RequireNativeAttempt(row, nativeBefore) != nil {
				return nil, fail("operations_autonomy_original_run_not_retryable")
			}
			if s.AIWork == nil {
				return nil, fault.New("operations_ai_work_unavailable", 503)
			}
			account := str(row["ai_account_id"])
			currentRole, err := s.AIWork.AuthorizationWithin(ctx, tx, str(row["domain"]), &account)
			if err != nil {
				return nil, err
			}
			if !currentRole.Enabled || currentRole.AccountID != account {
				return nil, dutyFail("operations_ai_work_disabled")
			}
			for _, action := range texts(obj(obj(row["configuration"])["plan"])["actions"]) {
				if !has(currentRole.Permissions, action) {
					return nil, dutyFail("operations_permission_denied")
				}
			}
			if err := s.ResolvePreDispatchAbsenceWithin(ctx, tx, row); err != nil {
				return nil, err
			}
			unresolved, err := s.unresolvedDutyWriteWithin(ctx, tx, row, "")
			if err != nil {
				return nil, err
			}
			if unresolved {
				return nil, fail("operations_autonomy_original_operation_unknown")
			}
			var pending bool
			err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_autonomy_tool_calls_v1 c WHERE c.endpoint=$1 AND c.task_id=$2 AND c.state='waiting-human' AND NOT EXISTS(SELECT 1 FROM operations_autonomy_decisions_v1 d WHERE d.endpoint=c.endpoint AND d.task_id=c.task_id AND d.call_id=c.call_id AND d.operation_id=c.operation_id))`, s.Endpoint, id).Scan(&pending)
			if err != nil {
				return nil, err
			}
			if pending {
				return nil, fail("operations_autonomy_human_required")
			}
			if s.EnqueueWithin == nil {
				return nil, fault.New("operations_autonomy_unavailable", 503)
			}
			var previousPrimary any
			if run := obj(nativeBefore["run"]); run != nil && run["runId"] == row["native_run_id"] {
				usage := nativeUsageFromView(run)
				if validNativeUsage(usage) && nativeUsageNotOlder(obj(row["primary_model_usage"]), usage) {
					if err = s.storeNativeUsageWithin(ctx, tx, row, str(row["native_run_id"]), usage); err != nil {
						return nil, err
					}
					previousPrimary = usage
					row, err = s.taskWithin(ctx, tx, id, "")
					if err != nil {
						return nil, err
					}
				}
			}
			previous := Object{"nativeRunId": row["native_run_id"], "nativeAttemptId": row["native_attempt_id"], "sessionId": row["session_id"], "status": "ERROR", "modelState": row["model_state"], "modelUsage": row["model_usage"], "primaryModelUsage": previousPrimary, "code": row["code"]}
			session := uuid.NewString()
			saved, err := one(ctx, tx, `UPDATE operations_autonomy_tasks_v1 SET state='queued',native_attempt_id=$3,session_id=$4,native_run_id=NULL,dispatch_started_at=NULL,model_state='not-started',native_continuable=false,primary_model_usage=NULL,lease_owner=NULL,lease_until=NULL,control_state=NULL,code=NULL,completed_at=NULL,control_revision=control_revision+1,revision=revision+1,updated_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_autonomy_tasks_v1)`, s.Endpoint, id, x["operationId"], session, s.now())
			if err != nil {
				return nil, err
			}
			if previousPrimary == nil {
				unknown := Object{"calls": nil, "inputTokens": nil, "outputTokens": nil, "totalTokens": nil, "durationMs": nil}
				if _, err = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET model_usage=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, id, jsonText(unknown)); err != nil {
					return nil, err
				}
				saved["model_usage"] = unknown
			}
			if err = s.EnqueueWithin(ctx, tx, "autonomy-task", taskJobInput(saved, false), fmt.Sprintf("%s:retry:%s", id, x["operationId"]), nil); err != nil {
				return nil, err
			}
			view, err := s.taskViewWithin(ctx, tx, saved, actor, true, true)
			if err != nil {
				return nil, err
			}
			view["previousAttempt"] = Object{"nativeRunId": previous["nativeRunId"], "nativeAttemptId": previous["nativeAttemptId"], "sessionId": previous["sessionId"], "status": previous["status"], "modelState": previous["modelState"]}
			return s.recordWithin(ctx, tx, actor, str(x["operationId"]), "control", intent, Object{"operationId": x["operationId"], "task": view, "previousAttempt": previous, "replayed": false})
		}
		if x["kind"] == "pause" && x["expectedControlRevision"] != nil && (has(terminal, str(row["state"])) || has([]string{"completed", "failed", "cancelled"}, str(row["model_state"])) || row["state"] == "waiting-human") {
			outcome := "native-ended"
			if row["state"] == "waiting-human" {
				outcome = "human-review-waiting"
			}
			view, err := s.taskViewWithin(ctx, tx, row, actor, true, true)
			if err != nil {
				return nil, err
			}
			return s.recordWithin(ctx, tx, actor, str(x["operationId"]), "control", intent, Object{"operationId": x["operationId"], "task": view, "applied": false, "outcome": outcome, "replayed": false})
		}
		if has(terminal, str(row["state"])) {
			return nil, fail("operations_autonomy_task_terminal")
		}
		if x["kind"] == "pause" {
			if row["source"] == "workbench" {
				return nil, fail("operations_autonomy_workbench_continuation_required")
			}
			if has([]string{"paused", "waiting-human"}, str(row["state"])) {
				return nil, fail("operations_autonomy_invalid_control_state")
			}
			if has([]string{"requested", "paused", "resuming"}, str(obj(row["control_state"])["phase"])) {
				return nil, fail("operations_autonomy_pause_requested")
			}
			phase, nextState := "requested", str(row["state"])
			if row["dispatch_started_at"] == nil {
				phase, nextState = "paused", "paused"
			}
			control := Object{"kind": "manual-pause", "phase": phase, "pauseOperationId": x["operationId"], "operatorId": actor.ID, "nativeRunId": row["native_run_id"], "checkpointCallIds": []string{}}
			saved, err := one(ctx, tx, `UPDATE operations_autonomy_tasks_v1 SET control_state=$3,state=$4,control_revision=control_revision+1,revision=revision+1,updated_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_autonomy_tasks_v1)`, s.Endpoint, id, jsonText(control), nextState, s.now())
			if err != nil {
				return nil, err
			}
			return finish(saved)
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
				if control := obj(row["control_state"]); control["kind"] == "manual-pause" && control["phase"] == "paused" {
					marker := obj(nativeBefore["manualPause"])
					if continuation["manualPause"] != true || marker["pauseOperationId"] != control["pauseOperationId"] || !sameValue(marker["checkpointCallIds"], control["checkpointCallIds"]) {
						return nil, fail("operations_autonomy_original_run_not_resumable")
					}
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
		var controlJSON any
		if control := obj(row["control_state"]); control != nil {
			control = obj(clone(control))
			if x["kind"] == "resume" && control["phase"] == "paused" {
				if state == "running" {
					control["phase"] = "resuming"
					control["resumeOperationId"] = x["operationId"]
				} else {
					control["phase"], control["outcome"] = "ended", "resumed-before-dispatch"
				}
			} else if has([]string{"stop", "takeover"}, str(x["kind"])) && has([]string{"requested", "paused", "resuming"}, str(control["phase"])) {
				control["phase"], control["outcome"] = "ended", x["kind"]
			}
			controlJSON = jsonText(control)
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
		saved, e := one(ctx, tx, `UPDATE operations_autonomy_tasks_v1 SET state=$3,human_decision=$4,native_continuable=false,lease_owner=NULL,lease_until=$6,control_state=$7,control_revision=control_revision+1,revision=revision+1,updated_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_autonomy_tasks_v1)`, s.Endpoint, id, state, decisionJSON, s.now(), lease, controlJSON)
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
			if e = s.EnqueueWithin(ctx, tx, "autonomy-task", taskJobInput(saved, false), fmt.Sprintf("%s:resume:%d", id, num(saved["revision"])), nil); e != nil {
				return nil, e
			}
		}
		return finish(saved)
	})
	if e != nil {
		return nil, e
	}
	if x["kind"] == "reconcile" {
		task := obj(result["task"])
		if has([]string{"unknown", "failed"}, str(task["state"])) && str(task["nativeRunId"]) != "" {
			if _, err := s.ReconcileOriginalWrites(ctx, id, str(task["nativeRunId"])); err != nil {
				return nil, err
			}
		}
	}
	if has([]string{"stop", "takeover"}, str(x["kind"])) && str(obj(result["task"])["nativeRunId"]) != "" && s.Native != nil {
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
			report := Object{"taskId": id, "nativeRunId": continueTask["native_run_id"], "modelState": model, "status": "running"}
			if continueTask["native_attempt_id"] != nil {
				report["nativeAttemptId"] = continueTask["native_attempt_id"]
			}
			_, e = s.Report(ctx, report)
		}
		if e != nil {
			if _, save := s.Pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='unknown',model_state='unknown',code=$3,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 AND state='running' AND native_attempt_id IS NOT DISTINCT FROM $5::uuid AND session_id=$6`, s.Endpoint, id, errorCode(e), s.now(), continueTask["native_attempt_id"], continueTask["session_id"]); save != nil {
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
		saved, e := one(ctx, tx, `UPDATE operations_autonomy_tasks_v1 SET human_decision=$3,control_revision=control_revision+1,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_autonomy_tasks_v1)`, s.Endpoint, id, jsonText(Object{"kind": "resolved", "operatorId": actor.ID, "operationId": call["operation_id"], "decision": x["decision"], "at": s.now().UTC().Format("2006-01-02T15:04:05.000Z")}), s.now())
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
