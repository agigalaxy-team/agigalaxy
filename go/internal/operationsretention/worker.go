package operationsretention

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func storedActor(row Object, endpoint string) (Actor, error) {
	r := obj(row["request_actor"])
	if r["kind"] != "business-operator" || r["endpoint"] != endpoint || str(r["operatorId"]) == "" || !has([]string{"administrator", "reader"}, str(r["role"])) {
		return Actor{}, fail("business_admin_denied", 403)
	}
	a := Actor{ID: str(r["operatorId"]), Role: str(r["role"]), Endpoint: endpoint}
	if id, ok := r["httpRequestId"].(string); ok {
		a.RequestID = &id
	}
	return a, nil
}
func (s *Service) Execute(ctx context.Context, runID string) (Object, error) {
	if !uuidValid(runID) {
		return nil, invalid()
	}
	result, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		r, e := s.row(ctx, tx, runID, true)
		if e != nil {
			return nil, e
		}
		if r["state"] == "completed" || r["state"] == "cancelled" {
			return Object{"state": r["state"]}, nil
		}
		saved, e := storedActor(r, s.Endpoint)
		if e != nil {
			return nil, e
		}
		if s.StoredAuthority == nil {
			return nil, fail("operations_authorization_unavailable", 503)
		}
		if e = s.StoredAuthority.Revalidate(ctx, tx, saved.ID, "retention.request"); e != nil {
			return nil, e
		}
		actor, e := s.StoredAuthority.PersonWithin(ctx, tx, saved.ID, false)
		if e != nil {
			return nil, e
		}
		if actor.ID != r["requested_by"] {
			return nil, fail("operations_retention_authority_changed", 403)
		}
		actor.RequestID = saved.RequestID
		counts, e := s.clean(ctx, tx, str(r["target"]), s.now().Unix())
		if e != nil {
			return nil, e
		}
		if !resultValid(str(r["target"]), counts) {
			return nil, invalid()
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_retention_runs_v1 SET state='completed',attempts=attempts+1,result=$2,error_code=NULL,updated_at=$3,finished_at=$3 WHERE id=$1`, runID, counts, s.now()); e != nil {
			return nil, e
		}
		if e = s.RecordMaintenanceWithin(ctx, tx, str(r["target"]), counts, nil); e != nil {
			return nil, e
		}
		if e = s.domain().Record(ctx, tx, actor, "retention-complete", Object{"runId": runID, "target": r["target"], "execution": "worker"}, Object{"state": "completed", "counts": counts}, nil); e != nil {
			return nil, e
		}
		return Object{"state": "completed", "result": counts}, nil
	})
	if e == nil {
		return result, nil
	}
	code := fault.Code(e)
	if !has([]string{"operations_permission_denied", "business_admin_denied", "identity_directory_unavailable", "operations_authorization_unavailable"}, code) {
		code = "retention_cleanup_failed"
	}
	_, recordError := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		r, e := s.row(ctx, tx, runID, true)
		if e != nil {
			return false, e
		}
		if r["state"] == "completed" || r["state"] == "cancelled" {
			return true, nil
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_retention_runs_v1 SET state='failed',attempts=attempts+1,error_code=$2,updated_at=$3,finished_at=$3 WHERE id=$1`, runID, code, s.now()); e != nil {
			return false, e
		}
		if e = s.RecordMaintenanceWithin(ctx, tx, str(r["target"]), nil, &code); e != nil {
			return false, e
		}
		actor, e := storedActor(r, s.Endpoint)
		if e != nil {
			return false, e
		}
		reason := "execution_failed"
		if code == "business_admin_denied" || code == "operations_permission_denied" {
			reason = "authority_changed"
		}
		e = s.domain().Record(ctx, tx, actor, "retention-failed", Object{"runId": runID, "target": r["target"], "execution": "worker", "reason": reason}, Object{"state": "failed", "code": code}, nil)
		return e == nil, e
	})
	if recordError != nil {
		return nil, recordError
	}
	status := 503
	if code == "business_admin_denied" || code == "operations_permission_denied" {
		status = 403
	}
	return nil, fail(code, status)
}
func (s *Service) Work(ctx context.Context, task jobs.Task) (jobs.Outcome, error) {
	if task.Action != "retention-cleanup" || task.Endpoint != s.Endpoint || !uuidValid(task.ID) || task.SourceID != task.OperationID || len(task.Payload) != 0 {
		return jobs.Outcome{}, invalid()
	}
	out, e := s.Execute(ctx, task.SourceID)
	return jobs.Outcome{Result: out}, e
}
