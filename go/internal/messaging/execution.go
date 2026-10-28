package messaging

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ExecutePlan(ctx context.Context, task jobs.Task) (Object, error) {
	if task.Endpoint != s.Endpoint || task.Action != jobs.MessagingRun || !uuidOK(task.SourceID) || !uuidOK(task.ID) || task.PlanVersion < 1 || task.PlanVersion > 2147483646 {
		return nil, invalidInput()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		plan, e := s.planWithin(ctx, tx, task.SourceID, false)
		if e != nil {
			return nil, e
		}
		notExecuted := func(plan Object) Object {
			reason := str(plan["state"])
			if num(plan["version"]) != task.PlanVersion {
				reason = "version-changed"
			}
			return Object{"state": "not-executed", "reason": reason}
		}
		if num(plan["version"]) != task.PlanVersion || str(plan["state"]) != "active" {
			return notExecuted(plan), nil
		}
		config := obj(plan["config"])
		content, schedule := obj(config["content"]), obj(config["schedule"])
		expires, _ := date(content["expiresAt"])
		if !expires.After(s.now()) {
			if str(schedule["kind"]) == "recurring" {
				if s.Scheduler == nil {
					return nil, failure("operations_messaging_scheduler_unavailable", 503)
				}
				if e = s.Scheduler.UnscheduleWithin(ctx, tx, jobs.MessagingRun, "messaging:"+str(plan["id"])); e != nil {
					return nil, e
				}
			}
			return Object{"state": "not-executed", "reason": "expired"}, nil
		}
		if str(schedule["kind"]) == "once" {
			at, _ := date(schedule["at"])
			if at.After(s.now()) {
				return Object{"state": "not-executed", "reason": "not-due"}, nil
			}
		}
		if _, e = s.approvalWithin(ctx, tx, plan); e != nil {
			return nil, e
		}
		plan, e = s.planWithin(ctx, tx, task.SourceID, true)
		if e != nil {
			return nil, e
		}
		if num(plan["version"]) != task.PlanVersion || str(plan["state"]) != "active" {
			return notExecuted(plan), nil
		}
		actor, e := s.approvalWithin(ctx, tx, plan)
		if e != nil {
			return nil, e
		}
		occurrence := "initial"
		if str(schedule["kind"]) == "recurring" {
			occurrence = task.ID
		}
		existing, e := one(ctx, tx, "SELECT to_jsonb(r) FROM operations_messaging_runs_v1 r WHERE plan_id=$1 AND plan_version=$2 AND occurrence_key=$3", plan["id"], plan["version"], occurrence)
		if e == nil {
			if contains([]string{"running", "blocked", "paused"}, str(existing["state"])) {
				if _, e = s.enqueueDelivery(ctx, tx, str(existing["id"]), "replay:"+decimal(num(existing["revision"])), s.now()); e != nil {
					return nil, e
				}
			}
			view, e := s.runView(ctx, tx, existing)
			return Object{"run": view, "replayed": true}, e
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		id := uuid.NewString()
		var role, approvedAI any = actor.Actor.Role, nil
		if actor.Kind == "operations-ai-service" {
			role = nil
			approvedAI = encode(plan["approved_ai"])
		}
		_, e = tx.Exec(ctx, `INSERT INTO operations_messaging_runs_v1(id,endpoint,plan_id,plan_version,occurrence_key,state,approved_by,approved_role,frozen_at,audience_count,created_at,updated_at,approved_ai) VALUES($1,$2,$3,$4,$5,'running',$6,$7,$8,0,$8,$8,$9)`, id, s.Endpoint, plan["id"], plan["version"], occurrence, actor.Actor.ID, role, s.now(), approvedAI)
		if e != nil {
			return nil, e
		}
		channels := []string{}
		for _, channel := range list(config["channels"]) {
			if channel != "announcement" {
				channels = append(channels, channel)
			}
		}
		audience := obj(config["audience"])
		if len(channels) > 0 {
			_, e = tx.Exec(ctx, `INSERT INTO operations_messaging_recipients_v1(id,run_id,account_id,channel,state,updated_at) SELECT gen_random_uuid(),$1,a.id,c.channel,'pending',$2 FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id CROSS JOIN unnest($3::text[]) AS c(channel) WHERE a.endpoint=$4 AND ($5::text<>'accounts' OR a.id=ANY($6::uuid[])) AND ($5::text<>'attributes' OR p.subject_type=ANY($7::text[]))`, id, s.now(), channels, s.Endpoint, audience["kind"], list(audience["accountIds"]), list(audience["subjectTypes"]))
			if e != nil {
				return nil, e
			}
		}
		var count int
		if e = tx.QueryRow(ctx, "SELECT count(DISTINCT account_id) FROM operations_messaging_recipients_v1 WHERE run_id=$1", id).Scan(&count); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE operations_messaging_runs_v1 SET audience_count=$2 WHERE id=$1", id, count); e != nil {
			return nil, e
		}
		if contains(list(config["channels"]), "announcement") {
			if _, e = tx.Exec(ctx, `INSERT INTO operations_messaging_announcements_v1(id,endpoint,run_id,plan_id,plan_version,content,published_at,expires_at) VALUES($1,$2,$1,$3,$4,$5,$6,$7)`, id, s.Endpoint, plan["id"], plan["version"], encode(content), s.now(), content["expiresAt"]); e != nil {
				return nil, e
			}
		}
		if contains(channels, "inapp") {
			noticeContent := obj(clone(content))
			noticeContent["audience"] = audience
			noticeContent["messagingRunId"] = id
			if _, e = tx.Exec(ctx, `INSERT INTO operations_notices_v1(id,endpoint,version,content,state,created_by,updated_by,published_by,published_at,expires_at,audience_count,created_at,updated_at) VALUES($1,$2,1,$3,CASE WHEN $7::integer=0 THEN 'delivered' ELSE 'queued' END,$4,$4,$4,$5,$6,$7,$5,$5)`, id, s.Endpoint, encode(noticeContent), actor.Actor.ID, s.now(), content["expiresAt"], count); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO account_operations_notices_v1(notice_id,account_id) SELECT run_id,account_id FROM operations_messaging_recipients_v1 WHERE run_id=$1 AND channel='inapp'`, id); e != nil {
				return nil, e
			}
		}
		state := "completed"
		if count > 0 {
			state = "running"
		}
		if e = s.auditApproved(ctx, tx, actor, Object{"kind": "run", "planId": plan["id"], "runId": id, "planVersion": plan["version"]}, Object{"audienceCount": count, "state": state}, nil); e != nil {
			return nil, e
		}
		if len(channels) > 0 && count > 0 {
			if _, e = s.enqueueDelivery(ctx, tx, id, "start", s.now()); e != nil {
				return nil, e
			}
		} else {
			if _, e = tx.Exec(ctx, `UPDATE operations_messaging_runs_v1 SET state='completed',completed_at=$2,updated_at=$2 WHERE id=$1`, id, s.now()); e != nil {
				return nil, e
			}
		}
		run, e := s.runWithin(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		view, e := s.runView(ctx, tx, run)
		return Object{"run": view, "replayed": false}, e
	})
}
