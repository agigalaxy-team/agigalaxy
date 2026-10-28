package publication

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river/rivertype"
)

func transportState(v jobs.View, j *rivertype.JobRow) string {
	if v.State == "cancelled" {
		return "cancelled"
	}
	switch string(j.State) {
	case "available", "scheduled", "pending":
		return "created"
	case "running":
		return "active"
	case "retryable":
		return "retry"
	case "completed":
		return "completed"
	case "cancelled":
		return "cancelled"
	case "discarded":
		return "failed"
	}
	return string(j.State)
}
func jobView(v jobs.View, j *rivertype.JobRow) Object {
	var failure any
	if v.ErrorCode != nil {
		failure = *v.ErrorCode
	}
	retry := j.Attempt - 1
	if retry < 0 {
		retry = 0
	}
	return Object{"id": v.ID, "queue": jobs.ContentPublication, "state": transportState(v, j), "createdAt": j.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"), "startedAt": isoPointer(j.AttemptedAt), "completedAt": isoPointer(j.FinalizedAt), "availableAt": j.ScheduledAt.UTC().Format("2006-01-02T15:04:05.000Z"), "retryCount": retry, "retryLimit": j.MaxAttempts - 1, "subjectId": nil, "resourceId": v.SourceID, "error": failure}
}
func (c *Commands) jobWithin(ctx context.Context, tx pgx.Tx, id string) (jobs.View, *rivertype.JobRow, error) {
	if c.Queue == nil {
		return jobs.View{}, nil, fault.New("operations_jobs_unavailable", 503)
	}
	v, e := c.Queue.GetWithin(ctx, tx, c.Endpoint, id)
	if errors.Is(e, pgx.ErrNoRows) {
		return v, nil, fault.New("operations_job_not_found", 404)
	}
	if e != nil {
		return v, nil, e
	}
	if v.Action != jobs.ContentPublication || v.OperationID == nil || v.SourceID != *v.OperationID {
		return v, nil, fault.New("operations_job_source_changed", 409)
	}
	j, e := c.Queue.GetTransportWithin(ctx, tx, c.Endpoint, id)
	if e != nil {
		return v, nil, e
	}
	return v, j, nil
}
func (c *Commands) Job(ctx context.Context, operator, id string) (Object, error) {
	return postgres.InTx(ctx, c.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := c.authorize(ctx, tx, operator, "jobs.read"); e != nil {
			return nil, e
		}
		v, j, e := c.jobWithin(ctx, tx, id)
		if fault.Code(e) == "operations_job_not_found" {
			return Object{"job": nil}, nil
		}
		if e != nil {
			return nil, e
		}
		return Object{"job": jobView(v, j)}, nil
	})
}
func (c *Commands) Control(ctx context.Context, operator, id, command string) (Object, error) {
	if command != "cancel" && command != "retry" {
		return nil, fault.New("not_found", 404)
	}
	return postgres.InTx(ctx, c.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := c.authorize(ctx, tx, operator, "jobs."+command); e != nil {
			return nil, e
		}
		actor, e := c.authorize(ctx, tx, operator, "cms.publish")
		if e != nil {
			return nil, e
		}
		before, transport, e := c.jobWithin(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		previous := transportState(before, transport)
		if command == "cancel" {
			if previous != "created" && previous != "retry" && previous != "active" && previous != "cancelled" {
				return nil, fault.New("operations_job_not_cancellable", 409)
			}
			if e = c.CancelJobWithin(ctx, tx, before.SourceID); e != nil {
				return nil, e
			}
			if e = c.Queue.CancelWithin(ctx, tx, c.Endpoint, id); e != nil {
				return nil, e
			}
		} else {
			if previous != "failed" {
				return nil, fault.New("operations_job_not_failed", 409)
			}
			if e = c.Queue.ResumeWithin(ctx, tx, c.Endpoint, id); e != nil {
				return nil, e
			}
		}
		after, next, e := c.jobWithin(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		state := transportState(after, next)
		if e = c.audit(ctx, tx, actor, "job-"+command, Object{"queue": jobs.ContentPublication, "jobId": id}, Object{"state": state, "previousState": previous, "changed": previous != state}); e != nil {
			return nil, e
		}
		return jobView(after, next), nil
	})
}
func truthyValue(v any) bool {
	switch v := v.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return v != 0
	case json.Number:
		return v != "0" && v != "0.0"
	}
	return true
}
func (c *Commands) audit(ctx context.Context, tx pgx.Tx, a feedback.Operator, action string, selection, result Object) error {
	sb, e := json.Marshal(selection)
	if e != nil {
		return e
	}
	rb, e := json.Marshal(result)
	if e != nil {
		return e
	}
	var request any
	if c.RequestID != "" {
		request = c.RequestID
	}
	_, e = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,operation_id,http_request_id,selection,result,created_at,actor_kind,execution_id,grant_id,actor_context) VALUES($1,$2,$3,$4,$5,NULL,NULL,$6,$7,$8,$9,'business-operator',NULL,NULL,NULL)`, uuid.NewString(), c.Endpoint, a.ID, a.Role, action, request, sb, rb, c.now())
	return e
}
