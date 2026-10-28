package messaging

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"strconv"
	"time"
)

var permissions = map[string]string{"create": "notices.create", "save": "notices.update", "activate": "notices.publish", "resume": "notices.publish", "pause": "notices.withdraw", "stop": "notices.withdraw", "withdraw": "notices.withdraw", "retry": "notices.publish"}
var auditActions = map[string]string{"create": "notice-create", "save": "notice-save", "activate": "notice-publish", "resume": "notice-publish", "pause": "notice-withdraw", "stop": "notice-withdraw", "withdraw": "notice-withdraw", "retry": "notice-delivery"}

func (s *Service) audit(ctx context.Context, tx pgx.Tx, actor Actor, action string, operation, account any, selection, result Object) error {
	if account == nil {
		return s.businessDomain().Record(ctx, tx, actor, action, selection, result, operation)
	}
	return s.businessDomain().RecordAccountOperation(ctx, tx, actor, action, selection, result, account, operation)
}
func (s *Service) command(ctx context.Context, a Actor, kind string, input Object, operation func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.require(ctx, tx, a, permissions[kind])
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912411))", s.Endpoint+":messaging:"+str(input["operationId"])); e != nil {
			return nil, e
		}
		prior, e := one(ctx, tx, "SELECT to_jsonb(c) FROM operations_messaging_commands_v1 c WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, input["operationId"])
		if e == nil {
			if str(prior["operator_id"]) != actor.ID || str(prior["kind"]) != kind || !same(prior["input"], input) {
				return nil, failure("operations_messaging_operation_changed")
			}
			result := obj(clone(prior["result"]))
			result["replayed"] = true
			return result, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		if duty := s.duty(actor); duty != nil {
			if kind == "create" || kind == "save" {
				if e = s.assertDutyDraft(ctx, tx, actor, input, kind); e != nil {
					return nil, e
				}
			}
			if kind == "retry" {
				return nil, failure("operations_agentos_human_review_required")
			}
			businessAction := auditActions[kind]
			actor, e = duty.RequireDutyOperation(ctx, tx, actor, []string{permissions[kind]}, Object{"operationId": input["operationId"], "planId": input["planId"]}, &businessAction)
			if e != nil {
				return nil, e
			}
		}
		result, e := operation(tx, actor)
		if e != nil {
			return nil, e
		}
		actor, e = s.require(ctx, tx, a, permissions[kind])
		if e != nil {
			return nil, e
		}
		plan, run := obj(result["plan"]), obj(result["run"])
		selection := Object{"kind": kind, "planId": nil, "runId": nil, "planVersion": nil}
		outcome := Object{}
		if plan != nil {
			selection["planId"] = plan["id"]
			selection["planVersion"] = plan["version"]
			outcome = Object{"state": plan["state"], "version": plan["version"], "revision": plan["revision"]}
		} else if run != nil {
			selection["planId"] = run["planId"]
			selection["runId"] = run["id"]
			selection["planVersion"] = run["planVersion"]
			outcome = Object{"state": run["state"], "version": run["planVersion"], "revision": run["revision"]}
		}
		if e = s.audit(ctx, tx, actor, auditActions[kind], input["operationId"], nil, selection, outcome); e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, "INSERT INTO operations_messaging_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", s.Endpoint, input["operationId"], actor.ID, kind, encode(input), encode(result), s.now())
		if e != nil {
			return nil, e
		}
		result["replayed"] = false
		return result, nil
	})
}
func (s *Service) eventWithin(ctx context.Context, tx pgx.Tx, row Object, actor Actor, kind string, operation any) error {
	actorKind := "business-operator"
	var role any = actor.Role
	var metadata any
	if duty := s.duty(actor); duty != nil {
		m, e := duty.DutyMetadata(actor)
		if e != nil {
			return e
		}
		actorKind, role, metadata = "operations-ai-service", nil, encode(m)
	}
	_, e := tx.Exec(ctx, `INSERT INTO operations_messaging_events_v1(id,plan_id,operator_id,operator_role,kind,version,revision,created_at,actor_kind,ai_context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, operation, row["id"], actor.ID, role, kind, row["version"], row["revision"], s.now(), actorKind, metadata)
	return e
}
func (s *Service) Create(ctx context.Context, a Actor, input Object) (Object, error) {
	return s.create(ctx, a, input, "")
}
func (s *Service) create(ctx context.Context, a Actor, input Object, planID string) (Object, error) {
	if !keys(input, "operationId", "config") || !uuidOK(input["operationId"]) {
		return nil, invalidInput()
	}
	config, e := normalizeConfig(input["config"])
	if e != nil {
		return nil, e
	}
	clean := Object{"operationId": input["operationId"], "config": config}
	if planID != "" {
		clean["planId"] = planID
	}
	return s.command(ctx, a, "create", clean, func(tx pgx.Tx, actor Actor) (Object, error) {
		if e := s.validateConfig(ctx, tx, config, false); e != nil {
			return nil, e
		}
		if s.duty(actor) != nil && planID == "" {
			return nil, failure("operations_ai_duty_operation_denied", 403)
		}
		id := planID
		if id == "" {
			id = uuid.NewString()
		}
		if _, e := tx.Exec(ctx, `INSERT INTO operations_messaging_plans_v1(id,endpoint,version,revision,state,created_by,updated_by,created_at,updated_at) VALUES($1,$2,1,1,'draft',$3,$3,$4,$4)`, id, s.Endpoint, actor.ID, s.now()); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, "INSERT INTO operations_messaging_versions_v1(plan_id,version,config,created_by,created_at) VALUES($1,1,$2,$3,$4)", id, encode(config), actor.ID, s.now()); e != nil {
			return nil, e
		}
		row, e := s.planWithin(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		if e = s.eventWithin(ctx, tx, row, actor, "create", input["operationId"]); e != nil {
			return nil, e
		}
		return Object{"plan": s.planView(row, actor)}, nil
	})
}
func (s *Service) Save(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	if !keys(input, "operationId", "expectedVersion", "expectedRevision", "config") || !uuidOK(input["operationId"]) || !uuidOK(id) || !intOK(input["expectedVersion"], 1, 2147483646) || !intOK(input["expectedRevision"], 1, 2147483646) {
		return nil, invalidInput()
	}
	config, e := normalizeConfig(input["config"])
	if e != nil {
		return nil, e
	}
	clean := obj(clone(input))
	clean["config"] = config
	clean["planId"] = id
	return s.command(ctx, a, "save", clean, func(tx pgx.Tx, actor Actor) (Object, error) {
		row, e := s.planWithin(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if num(row["version"]) != num(input["expectedVersion"]) || num(row["revision"]) != num(input["expectedRevision"]) {
			return nil, failure("operations_messaging_version_changed")
		}
		if str(row["state"]) == "active" {
			return nil, failure("operations_messaging_pause_required")
		}
		if s.duty(actor) != nil && row["state"] != "draft" {
			return nil, failure("operations_agentos_human_review_required")
		}
		if e = s.validateConfig(ctx, tx, config, false); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO operations_messaging_versions_v1(plan_id,version,config,created_by,created_at) VALUES($1,$2,$3,$4,$5)", id, num(row["version"])+1, encode(config), actor.ID, s.now()); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_messaging_plans_v1 SET version=version+1,revision=revision+1,state='draft',approved_by=NULL,approved_role=NULL,approved_ai=NULL,approved_at=NULL,job_id=NULL,updated_by=$2,updated_at=$3 WHERE id=$1`, id, actor.ID, s.now()); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_messaging_runs_v1 SET state='cancelled',revision=revision+1,error_code='operations_messaging_version_changed',updated_at=$2 WHERE plan_id=$1 AND state IN ('running','paused','blocked')`, id, s.now()); e != nil {
			return nil, e
		}
		if e = s.stopUnsent(ctx, tx, id, "operations_messaging_version_changed"); e != nil {
			return nil, e
		}
		row, e = s.planWithin(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		if e = s.eventWithin(ctx, tx, row, actor, "save", input["operationId"]); e != nil {
			return nil, e
		}
		return Object{"plan": s.planView(row, actor)}, nil
	})
}
func (s *Service) stopUnsent(ctx context.Context, tx pgx.Tx, id, code string) error {
	_, e := tx.Exec(ctx, `UPDATE operations_messaging_recipients_v1 x SET state='skipped',retryable=false,retry_at=NULL,error_code=$2,completed_at=$3,updated_at=$3 FROM operations_messaging_runs_v1 r WHERE r.id=x.run_id AND r.plan_id=$1 AND (x.state IN ('pending','blocked') OR x.state='failed' AND x.retryable)`, id, code, s.now())
	return e
}
func (s *Service) enqueue(ctx context.Context, tx pgx.Tx, action, source, key string, version int64, at time.Time) (string, error) {
	if s.Jobs == nil {
		return "", failure("operations_messaging_scheduler_unavailable", 503)
	}
	id := uuid.NewSHA1(uuid.NameSpaceURL, []byte(encode([]string{s.Endpoint, action, key}))).String()
	return s.Jobs.EnqueueWithin(ctx, tx, jobs.Task{ID: id, Endpoint: s.Endpoint, Action: action, SourceID: source, OperationID: id, PlanVersion: version}, at)
}
func (s *Service) enqueueDelivery(ctx context.Context, tx pgx.Tx, runID, key string, at time.Time) (string, error) {
	id, e := s.enqueue(ctx, tx, jobs.MessagingDelivery, runID, "messaging:"+runID+":"+key, 0, at)
	if e != nil {
		return "", e
	}
	_, e = tx.Exec(ctx, "UPDATE operations_messaging_runs_v1 SET job_id=$2 WHERE id=$1", runID, id)
	return id, e
}
func (s *Service) scheduleWithin(ctx context.Context, tx pgx.Tx, row Object) (any, error) {
	config := obj(row["config"])
	schedule := obj(config["schedule"])
	id := str(row["id"])
	if str(schedule["kind"]) == "recurring" {
		if s.Scheduler == nil {
			return nil, failure("operations_messaging_scheduler_unavailable", 503)
		}
		task := jobs.Task{Endpoint: s.Endpoint, Action: jobs.MessagingRun, SourceID: id, PlanVersion: num(row["version"])}
		return nil, s.Scheduler.ScheduleWithin(ctx, tx, jobs.MessagingRun, str(schedule["cron"]), str(schedule["timezone"]), "messaging:"+id, task, "skip")
	}
	at := s.now()
	if str(schedule["kind"]) == "once" {
		scheduled, _ := date(schedule["at"])
		if scheduled.After(at) {
			at = scheduled
		}
	}
	return s.enqueue(ctx, tx, jobs.MessagingRun, id, "messaging:"+id+":v"+strconv.FormatInt(num(row["version"]), 10)+":r"+strconv.FormatInt(num(row["revision"]), 10), num(row["version"]), at)
}
