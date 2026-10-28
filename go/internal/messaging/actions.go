package messaging

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Action(ctx context.Context, a Actor, id, kind string, input Object) (Object, error) {
	if !contains([]string{"activate", "pause", "resume", "stop", "withdraw"}, kind) || !uuidOK(id) || !keys(input, "operationId", "expectedVersion", "expectedRevision") || !uuidOK(input["operationId"]) || !intOK(input["expectedVersion"], 1, 2147483646) || !intOK(input["expectedRevision"], 1, 2147483646) {
		return nil, invalidInput()
	}
	clean := obj(clone(input))
	clean["planId"] = id
	return s.command(ctx, a, kind, clean, func(tx pgx.Tx, actor Actor) (Object, error) {
		row, e := s.planWithin(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if num(row["version"]) != num(input["expectedVersion"]) || num(row["revision"]) != num(input["expectedRevision"]) {
			return nil, failure("operations_messaging_version_changed")
		}
		if s.duty(actor) != nil {
			if e = s.assertDutyPlan(ctx, tx, actor, row, kind); e != nil {
				return nil, e
			}
		}
		oldState := str(row["state"])
		if kind == "activate" && oldState != "draft" || kind == "pause" && oldState != "active" || kind == "resume" && oldState != "paused" || kind == "stop" && !contains([]string{"active", "paused"}, oldState) {
			return nil, failure("operations_messaging_state_changed")
		}
		state := "stopped"
		if kind == "activate" || kind == "resume" {
			state = "active"
		} else if kind == "pause" {
			state = "paused"
		}
		config := obj(row["config"])
		if state == "active" {
			if e = s.validateConfig(ctx, tx, config, kind == "activate"); e != nil {
				return nil, e
			}
		} else if str(obj(config["schedule"])["kind"]) == "recurring" {
			if s.Scheduler == nil {
				return nil, failure("operations_messaging_scheduler_unavailable", 503)
			}
			if e = s.Scheduler.UnscheduleWithin(ctx, tx, jobs.MessagingRun, "messaging:"+id); e != nil {
				return nil, e
			}
		}
		var role any = actor.Role
		var metadata any
		if state == "active" && s.duty(actor) != nil {
			m, err := s.approvalMetadata(actor, row)
			if err != nil {
				return nil, err
			}
			role, metadata = nil, encode(m)
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_messaging_plans_v1 SET state=$2,revision=revision+1,updated_by=$3,updated_at=$4,approved_by=CASE WHEN $2='active' THEN $3 ELSE approved_by END,approved_role=CASE WHEN $2='active' THEN $5 ELSE approved_role END,approved_ai=CASE WHEN $2='active' THEN $6::jsonb ELSE approved_ai END,approved_at=CASE WHEN $2='active' THEN $4 ELSE approved_at END WHERE id=$1`, id, state, actor.ID, s.now(), role, metadata); e != nil {
			return nil, e
		}
		next, e := s.planWithin(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		if state == "active" {
			jobID, e := s.scheduleWithin(ctx, tx, next)
			if e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE operations_messaging_plans_v1 SET job_id=$2 WHERE id=$1", id, jobID); e != nil {
				return nil, e
			}
			rows, e := many(ctx, tx, `WITH changed AS(UPDATE operations_messaging_runs_v1 SET state='running',revision=revision+1,updated_at=$3 WHERE plan_id=$1 AND plan_version=$2 AND state IN ('paused','blocked') RETURNING id) SELECT to_jsonb(changed) FROM changed`, id, next["version"], s.now())
			if e != nil {
				return nil, e
			}
			for _, run := range rows {
				if _, e = s.enqueueDelivery(ctx, tx, str(run["id"]), "resume:"+decimal(num(next["revision"])), s.now()); e != nil {
					return nil, e
				}
			}
		} else {
			runState := "cancelled"
			if state == "paused" {
				runState = "paused"
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_messaging_runs_v1 SET state=$2,revision=revision+1,updated_at=$3 WHERE plan_id=$1 AND state IN ('running','paused','blocked')`, id, runState, s.now()); e != nil {
				return nil, e
			}
			if state == "stopped" {
				if e = s.stopUnsent(ctx, tx, id, "operations_messaging_stopped"); e != nil {
					return nil, e
				}
			}
		}
		if kind == "withdraw" {
			if _, e = tx.Exec(ctx, "UPDATE operations_messaging_announcements_v1 SET withdrawn_at=COALESCE(withdrawn_at,$2) WHERE plan_id=$1", id, s.now()); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_notices_v1 SET state='withdrawn',version=version+1,updated_by=$3,updated_at=$2 WHERE id IN(SELECT id FROM operations_messaging_runs_v1 WHERE plan_id=$1) AND state<>'withdrawn'`, id, s.now(), actor.ID); e != nil {
				return nil, e
			}
		}
		next, e = s.planWithin(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		if e = s.eventWithin(ctx, tx, next, actor, kind, input["operationId"]); e != nil {
			return nil, e
		}
		return Object{"plan": s.planView(next, actor), "effects": Object{"futureExecutionStopped": state != "active", "alreadySubmittedEmailRetracted": false, "existingPublicationsWithdrawn": kind == "withdraw"}}, nil
	})
}
func (s *Service) approvalWithin(ctx context.Context, tx pgx.Tx, plan Object) (ApprovedActor, error) {
	if plan["approved_by"] == nil {
		return ApprovedActor{}, failure("operations_messaging_approval_unavailable", 403)
	}
	if metadata := obj(plan["approved_ai"]); metadata != nil {
		if str(metadata["messagePlanId"]) != str(plan["id"]) || num(metadata["messageVersion"]) != num(plan["version"]) || plan["approved_role"] != nil || str(plan["approved_by"]) != "ai:"+str(metadata["aiAccountId"]) || s.ContinueAIApproval == nil {
			return ApprovedActor{}, failure("operations_messaging_approval_unavailable", 403)
		}
		clean := obj(clone(metadata))
		delete(clean, "messagePlanId")
		delete(clean, "messageVersion")
		a, e := s.ContinueAIApproval(ctx, tx, clean)
		if e != nil {
			return a, e
		}
		if a.Kind != "operations-ai-service" || a.Actor.ID != str(plan["approved_by"]) || a.Actor.Endpoint != s.Endpoint || a.Actor.Role != "" || !validAuditContext(a.Context, a.Actor.ID) || !has(a.Actor, "notices.publish") {
			return ApprovedActor{}, failure("operations_messaging_approval_unavailable", 403)
		}
		return a, nil
	}
	if plan["approved_role"] == nil {
		return ApprovedActor{}, failure("operations_messaging_approval_unavailable", 403)
	}
	authority := s.Approver
	if authority == nil {
		authority = s.Authority
	}
	if authority == nil {
		return ApprovedActor{}, failure("operations_authorization_unavailable", 503)
	}
	actor, e := authority.PersonWithin(ctx, tx, str(plan["approved_by"]), false)
	if e != nil {
		return ApprovedActor{}, e
	}
	if actor.Endpoint != s.Endpoint || actor.ID != str(plan["approved_by"]) || !contains([]string{"administrator", "reader"}, actor.Role) {
		return ApprovedActor{}, failure("business_admin_denied", 403)
	}
	if !has(actor, "notices.publish") {
		return ApprovedActor{}, failure("operations_permission_denied", 403)
	}
	return ApprovedActor{Actor: actor, Kind: "business-operator"}, nil
}
func (s *Service) runtimeWithin(ctx context.Context, tx pgx.Tx, run Object) (Object, ApprovedActor, error) {
	plan, e := s.planWithin(ctx, tx, str(run["plan_id"]), false)
	if e != nil {
		return nil, ApprovedActor{}, e
	}
	if _, e = s.approvalWithin(ctx, tx, plan); e != nil {
		return nil, ApprovedActor{}, e
	}
	plan, e = s.planWithin(ctx, tx, str(run["plan_id"]), true)
	if e != nil {
		return nil, ApprovedActor{}, e
	}
	if num(plan["version"]) != num(run["plan_version"]) {
		return nil, ApprovedActor{}, failure("operations_messaging_version_changed")
	}
	switch str(plan["state"]) {
	case "active":
	case "paused":
		return nil, ApprovedActor{}, failure("operations_messaging_paused")
	default:
		return nil, ApprovedActor{}, failure("operations_messaging_stopped")
	}
	expires, _ := date(obj(obj(run["config"])["content"])["expiresAt"])
	if !expires.After(s.now()) {
		return nil, ApprovedActor{}, failure("operations_messaging_expired")
	}
	actor, e := s.approvalWithin(ctx, tx, plan)
	return plan, actor, e
}
func (s *Service) auditApproved(ctx context.Context, tx pgx.Tx, a ApprovedActor, selection, result Object, account any) error {
	if a.Kind == "business-operator" {
		return s.audit(ctx, tx, a.Actor, "notice-delivery", nil, account, selection, result)
	}
	if a.Kind != "operations-ai-service" || a.Actor.Role != "" || !validAuditContext(a.Context, a.Actor.ID) {
		return failure("operations_messaging_approval_unavailable", 403)
	}
	_, e := tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,http_request_id,selection,result,created_at,actor_kind,execution_id,grant_id,actor_context) VALUES($1,$2,$3,NULL,'notice-delivery',$4,$5,$6,$7,$8,'operations-ai-service',$9,$10,$11)`, uuid.NewString(), s.Endpoint, a.Actor.ID, account, a.Actor.RequestID, encode(selection), encode(result), s.now(), a.ExecutionID, a.GrantID, encode(a.Context))
	return e
}
func (s *Service) Retry(ctx context.Context, a Actor, runID string, input Object) (Object, error) {
	if !uuidOK(runID) || !keys(input, "operationId", "expectedRevision") || !uuidOK(input["operationId"]) || !intOK(input["expectedRevision"], 1, 2147483646) {
		return nil, invalidInput()
	}
	clean := obj(clone(input))
	clean["runId"] = runID
	return s.command(ctx, a, "retry", clean, func(tx pgx.Tx, _ Actor) (Object, error) {
		row, e := s.runWithin(ctx, tx, runID, true)
		if e != nil {
			return nil, e
		}
		if num(row["revision"]) != num(input["expectedRevision"]) {
			return nil, failure("operations_messaging_version_changed")
		}
		if _, _, e = s.runtimeWithin(ctx, tx, row); e != nil {
			return nil, e
		}
		if _, e = s.recoverSubmissions(ctx, tx, runID); e != nil {
			return nil, e
		}
		tag, e := tx.Exec(ctx, `UPDATE operations_messaging_recipients_v1 SET state='pending',retryable=false,retry_at=NULL,error_code=NULL,completed_at=NULL,updated_at=$2 WHERE run_id=$1 AND (state='blocked' OR state='failed' AND retryable) AND attempt_count<$3`, runID, s.now(), maxSubmitAttempts)
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() == 0 {
			return nil, failure("operations_messaging_retry_not_allowed")
		}
		if tag.RowsAffected() > 0 {
			if _, e = tx.Exec(ctx, `UPDATE operations_messaging_runs_v1 SET state='running',error_code=NULL,completed_at=NULL,revision=revision+1,updated_at=$2 WHERE id=$1`, runID, s.now()); e != nil {
				return nil, e
			}
			if _, e = s.enqueueDelivery(ctx, tx, runID, "retry:"+str(input["operationId"]), s.now()); e != nil {
				return nil, e
			}
		}
		row, e = s.runWithin(ctx, tx, runID, false)
		if e != nil {
			return nil, e
		}
		view, e := s.runView(ctx, tx, row)
		if e != nil {
			return nil, e
		}
		return Object{"run": view, "retriedRecipients": tag.RowsAffected()}, nil
	})
}

func validAuditContext(value Object, actorID string) bool {
	if value == nil || !keys(value, "schemaVersion", "aiAccountId", "domain", "taskId", "planId", "planVersion", "grantId", "grantVersion", "strategyId", "strategyVersionId", "toolCallId", "toolOperationId", "judgmentKind") || !intOK(value["schemaVersion"], 1, 1) || !contains([]string{"overview", "governance", "messaging", "discovery", "maintenance"}, str(value["domain"])) || actorID != "ai:"+str(value["aiAccountId"]) {
		return false
	}
	for _, key := range []string{"aiAccountId", "taskId", "planId"} {
		if !uuidOK(value[key]) {
			return false
		}
	}
	if !intOK(value["planVersion"], 1, 9007199254740991) {
		return false
	}
	for _, key := range []string{"grantId", "strategyId", "strategyVersionId", "toolCallId", "toolOperationId"} {
		if v, exists := value[key]; exists && !uuidOK(v) {
			return false
		}
	}
	if v, exists := value["grantVersion"]; exists && !intOK(v, 1, 9007199254740991) {
		return false
	}

	if v, exists := value["judgmentKind"]; exists && !contains([]string{"ai", "code"}, str(v)) {
		return false
	}
	return true
}
