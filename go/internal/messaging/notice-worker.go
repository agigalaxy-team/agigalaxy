package messaging

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) noticeApprover(ctx context.Context, tx pgx.Tx, id string) (Actor, error) {
	authority := s.Approver
	if authority == nil {
		authority = s.Authority
	}
	if authority == nil {
		return Actor{}, failure("operations_authorization_unavailable", 503)
	}
	actor, e := authority.PersonWithin(ctx, tx, id, false)
	if e != nil {
		return Actor{}, e
	}
	if actor.ID != id || actor.Endpoint != s.Endpoint {
		return Actor{}, failure("business_admin_denied", 403)
	}
	if !has(actor, "notices.publish") {
		return Actor{}, failure("operations_permission_denied", 403)
	}
	return actor, nil
}
func (s *Service) DeliverNotice(ctx context.Context, id string) (Object, error) {
	if !uuidOK(id) {
		return nil, productInvalid()
	}
	result, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, e := s.noticeRow(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if !contains([]string{"queued", "delivering"}, str(row["state"])) {
			return Object{"state": row["state"]}, nil
		}
		actor, e := s.noticeApprover(ctx, tx, str(row["published_by"]))
		if e != nil {
			return nil, e
		}
		expires, _ := date(row["expires_at"])
		if !expires.After(s.now()) {
			if _, e = tx.Exec(ctx, "UPDATE operations_notices_v1 SET state='expired',updated_at=$2,last_attempt_at=$2 WHERE id=$1", id, s.now()); e != nil {
				return nil, e
			}
			if e = s.audit(ctx, tx, actor, "notice-delivery", nil, nil, Object{"noticeId": id, "execution": "worker"}, Object{"state": "expired", "deliveredCount": 0}); e != nil {
				return nil, e
			}
			return Object{"state": "expired"}, nil
		}
		selected, e := many(ctx, tx, `SELECT to_jsonb(r) FROM account_operations_notices_v1 r WHERE notice_id=$1 AND delivered_at IS NULL ORDER BY sequence LIMIT 100 FOR UPDATE`, id)
		if e != nil {
			return nil, e
		}
		if len(selected) > 0 {
			ids := []string{}
			for _, recipient := range selected {
				ids = append(ids, str(recipient["account_id"]))
			}
			if _, e = tx.Exec(ctx, "UPDATE account_operations_notices_v1 SET delivered_at=$3 WHERE notice_id=$1 AND account_id=ANY($2::uuid[]) AND delivered_at IS NULL", id, ids, s.now()); e != nil {
				return nil, e
			}
		}
		var remaining bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM account_operations_notices_v1 WHERE notice_id=$1 AND delivered_at IS NULL LIMIT 1)", id).Scan(&remaining); e != nil {
			return nil, e
		}
		jobID := row["job_id"]
		state := "delivered"
		if remaining {
			state = "delivering"
			jobID, e = s.enqueue(ctx, tx, jobs.AccountNotice, id, "notice:"+id+":"+str(selected[len(selected)-1]["sequence"]), 0, s.now())
			if e != nil {
				return nil, e
			}
			if str(jobID) == "" {
				return nil, failure("operations_notice_queue_unavailable", 503)
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE operations_notices_v1 SET state=$2,updated_at=$3,job_id=$4,delivery_error_code=NULL,last_attempt_at=$3 WHERE id=$1", id, state, s.now(), jobID); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, actor, "notice-delivery", nil, nil, Object{"noticeId": id, "execution": "worker"}, Object{"state": state, "deliveredCount": len(selected)}); e != nil {
			return nil, e
		}
		return Object{"state": state, "deliveredCount": len(selected)}, nil
	})
	if err == nil {
		return result, nil
	}
	code := fault.Code(err)
	if !contains([]string{"operations_permission_denied", "business_admin_denied", "identity_directory_unavailable", "operations_authorization_unavailable"}, code) {
		code = "operations_notice_delivery_failed"
	}
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		row, e := s.noticeRow(ctx, tx, id, true)
		if e != nil {
			return false, e
		}
		if !contains([]string{"queued", "delivering"}, str(row["state"])) {
			return false, nil
		}
		if _, e = tx.Exec(ctx, "UPDATE operations_notices_v1 SET delivery_error_code=$2,last_attempt_at=$3 WHERE id=$1", id, code, s.now()); e != nil {
			return false, e
		}
		var role *string
		if e = tx.QueryRow(ctx, "SELECT galaxy_notice_original_operator_role($1,$2::uuid,$3)", s.Endpoint, id, row["published_by"]).Scan(&role); e != nil {
			return false, e
		}
		if role != nil && contains([]string{"administrator", "reader"}, *role) {
			reason := "execution_failed"
			if code == "business_admin_denied" || code == "operations_permission_denied" {
				reason = "authority_changed"
			} // This is original recorded attribution, never current authorization.
			actor := Actor{ID: str(row["published_by"]), Role: *role, Endpoint: s.Endpoint}
			if e = s.audit(ctx, tx, actor, "notice-delivery", nil, nil, Object{"noticeId": id, "execution": "worker", "reason": reason}, Object{"state": "failed", "code": code, "deliveredCount": 0}); e != nil {
				return false, e
			}
		}
		return false, nil
	})
	if e != nil {
		return nil, e
	}
	status := 503
	if code == "business_admin_denied" || code == "operations_permission_denied" {
		status = 403
	}
	return nil, failure(code, status)
}

// CancelNoticeWithin is a domain cancellation, in the same tx as queue cancel.
// Queue permission alone never replaces the current publication-withdraw grant.
func (s *Service) CancelNoticeWithin(ctx context.Context, tx pgx.Tx, a Actor, id string) error {
	if _, e := s.require(ctx, tx, a, "notices.withdraw"); e != nil {
		return e
	}
	row, e := s.noticeRow(ctx, tx, id, true)
	if e != nil {
		return e
	}
	if contains([]string{"delivered", "expired"}, str(row["state"])) {
		return failure("operations_notice_not_cancellable")
	}
	if str(row["state"]) != "withdrawn" {
		_, e = tx.Exec(ctx, "UPDATE operations_notices_v1 SET state='withdrawn',version=version+1,updated_at=$2 WHERE id=$1", id, s.now())
	}
	return e
}
func (s *Service) NoticeOverview(ctx context.Context, a Actor) (Object, error) {
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		rows, e := many(ctx, tx, `SELECT jsonb_build_object('state',state,'count',count(*)::integer) FROM operations_notices_v1 WHERE endpoint=$1 AND expires_at>$2 GROUP BY state`, s.Endpoint, s.now())
		if e != nil {
			return nil, e
		}
		counts := Object{}
		for _, row := range rows {
			counts[str(row["state"])] = row["count"]
		}
		return Object{"counts": counts, "checkedAt": s.now().Unix()}, nil
	})
}
func (s *Service) Work(ctx context.Context, task jobs.Task) (jobs.Outcome, error) {
	if task.Endpoint != s.Endpoint || !uuidOK(task.ID) || !uuidOK(task.SourceID) {
		return jobs.Outcome{}, failure("operations_job_payload_invalid", 400)
	}
	var result Object
	var e error
	switch task.Action {
	case jobs.MessagingRun:
		result, e = s.ExecutePlan(ctx, task)
	case jobs.MessagingDelivery:
		if task.PlanVersion != 0 {
			return jobs.Outcome{}, failure("operations_job_payload_invalid", 400)
		}
		result, e = s.Deliver(ctx, task.SourceID)
	case jobs.AccountNotice:
		if task.PlanVersion != 0 {
			return jobs.Outcome{}, failure("operations_job_payload_invalid", 400)
		}
		result, e = s.DeliverNotice(ctx, task.SourceID)
	default:
		return jobs.Outcome{}, failure("operations_job_consumer_unavailable", 503)
	}
	return jobs.Outcome{Result: result}, e
}
