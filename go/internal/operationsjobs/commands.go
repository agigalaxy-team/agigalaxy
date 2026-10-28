package operationsjobs

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// QualifyWithin is the original prepared-action current-source check. Its
// caller owns current operation authority; it never dispatches or creates IDs.
func (s *Service) QualifyWithin(ctx context.Context, tx pgx.Tx, a Actor, kind string, r, command Object) error {
	if e := request(kind, r); e != nil {
		return e
	}
	if kind == "search-retry" {
		if !integer(command["expectedGeneration"], 1) {
			return fail("invalid_operations_job_action", 400)
		}
		qualify := s.SearchQualifyWithin
		if qualify == nil && s.Search != nil {
			qualify = s.Search.QualifyRetryWithin
		}
		if qualify == nil {
			return fail("operations_search_unavailable", 503)
		}
		return qualify(ctx, tx, text(r["targetId"]), number(command["expectedGeneration"]))
	}
	if s.domain().IsDuty(a) && text(r["queue"]) != "information-watch" {
		return fail("operations_agentos_human_review_required", 409)
	}
	v, _, e := s.job(ctx, tx, text(r["queue"]), text(r["targetId"]), false)
	if e != nil {
		return e
	}
	if v == nil || v["state"] != command["expectedState"] || !equal(v["retryCount"], command["expectedRetryCount"]) {
		return fail("operations_job_changed", 409)
	}
	return nil
}
func (s *Service) mutateQueue(ctx context.Context, tx pgx.Tx, a Actor, queue, id, kind string, command Object) (Object, Object, error) {
	if queue == "autonomy-task" || queue == "autonomy-tick" {
		return nil, nil, fail("operations_autonomy_task_control_required", 409)
	}
	if s.Queue == nil {
		return nil, nil, fail("operations_jobs_unavailable", 503)
	}
	before, task, e := s.job(ctx, tx, queue, id, true)
	if e != nil {
		return nil, nil, e
	}
	if before == nil {
		return nil, nil, fail("operations_job_not_found", 404)
	}
	if command != nil && (before["state"] != command["expectedState"] || !equal(before["retryCount"], command["expectedRetryCount"])) {
		return nil, nil, fail("operations_job_changed", 409)
	}
	previous := text(before["state"])
	if kind == "job-cancel" {
		cancellable := has([]string{"created", "retry", "active"}, previous)
		mandatory := has([]string{"content-publication", "account-notice", "retention-cleanup", "messaging-run", "messaging-delivery"}, queue)
		if !cancellable && previous != "cancelled" {
			return nil, nil, fail("operations_job_not_cancellable", 409)
		}
		callback := s.Cancellations[queue]
		if callback == nil && queue == "information-watch" && s.Watches != nil {
			callback = func(ctx context.Context, tx pgx.Tx, _ Actor, task jobs.Task) error {
				return s.Watches.CancelJobWithin(ctx, tx, task.Payload)
			}
		}
		if callback == nil && queue == "retention-cleanup" && s.Retention != nil {
			callback = func(ctx context.Context, tx pgx.Tx, _ Actor, task jobs.Task) error {
				return s.Retention.CancelWithin(ctx, tx, task.SourceID)
			}
		}
		if (mandatory && (cancellable || previous == "cancelled")) || (cancellable && (callback != nil || queue == jobs.InformationWatch)) {
			if callback == nil {
				code := "operations_job_domain_unavailable"
				if queue == "content-publication" {
					code = "site_publication_unavailable"
				}
				return nil, nil, fail(code, 503)
			}
			if e = callback(ctx, tx, a, task); e != nil {
				return nil, nil, e
			}
		}
		if cancellable {
			if e = s.Queue.CancelWithin(ctx, tx, s.Endpoint, id); e != nil {
				return nil, nil, e
			}
		}
	} else {
		if previous != "failed" {
			return nil, nil, fail("operations_job_not_failed", 409)
		}
		if e = s.Queue.ResumeWithin(ctx, tx, s.Endpoint, id); e != nil {
			return nil, nil, e
		}
	}
	after, _, e := s.job(ctx, tx, queue, id, false)
	if e != nil {
		return nil, nil, e
	}
	if after == nil {
		return nil, nil, fail("operations_job_not_found", 404)
	}
	result := Object{"queue": queue, "jobId": id, "previousState": previous, "state": after["state"], "changed": previous != text(after["state"])}
	if task.Generation > 0 {
		result["generation"] = task.Generation
	}
	return after, result, nil
}
func selection(r, command Object) Object {
	o := Object{"id": r["targetId"], "jobId": r["targetId"], "command": command}
	if q, ok := r["queue"]; ok {
		o["queue"] = q
	}
	return o
}
func (s *Service) Command(ctx context.Context, a Actor, kind string, r, input Object, authorize func(context.Context, pgx.Tx) (Actor, error)) (Object, error) {
	if e := request(kind, r); e != nil {
		return nil, e
	}
	command, e := ParseCommand(kind, input)
	if e != nil {
		return nil, e
	}
	selected := selection(r, command)
	actual := a
	d := s.domain()
	current := func(ctx context.Context, tx pgx.Tx) error {
		if authorize != nil {
			fresh, e := authorize(ctx, tx)
			if e != nil {
				return e
			}
			if fresh.ID != a.ID || fresh.Endpoint != s.Endpoint {
				return fail("business_admin_denied", 403)
			}
			actual = fresh
		}
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", s.Endpoint+":job-action:"+text(command["operationId"])); e != nil {
			return e
		}
		prior, unknown, e := d.OperationRecordWithin(ctx, tx, text(command["operationId"]))
		if e != nil {
			return e
		}
		if unknown {
			return fail("operations_command_receipt_unavailable", 503)
		}
		if prior != nil {
			return fail("operations_job_operation_recorded", 409)
		}
		opSelection := Object{}
		for k, v := range selected {
			opSelection[k] = v
		}
		opSelection["operationId"] = command["operationId"]
		actual, e = d.Operation(ctx, tx, actual, kind, opSelection)
		if e != nil {
			return e
		}
		if domain := domainPermission(text(r["queue"]), kind); domain != "" {
			actual, e = d.Fresh(ctx, tx, actual, domain)
			if e != nil {
				return e
			}
		}
		return s.QualifyWithin(ctx, tx, actual, kind, r, command)
	}
	var receipt Object
	audit := func(ctx context.Context, tx pgx.Tx, result Object) error {
		receipt = result
		return d.Record(ctx, tx, actual, kind, selected, result, command["operationId"])
	}
	if kind == "search-retry" {
		if s.Search == nil {
			return nil, fail("operations_search_unavailable", 503)
		}
		_, e = s.Search.RetryFailed(ctx, text(r["targetId"]), number(command["expectedGeneration"]), discovery.LegacyRetryOptions{Authorize: current, Audit: audit})
	} else {
		_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
			if e := current(ctx, tx); e != nil {
				return nil, e
			}
			_, result, e := s.mutateQueue(ctx, tx, actual, text(r["queue"]), text(r["targetId"]), kind, command)
			if e != nil {
				return nil, e
			}
			return result, audit(ctx, tx, result)
		})
	}
	if e != nil {
		return nil, e
	}
	return receipt, nil
}

// Operation reads only the exact original owner's receipt. A missing receipt
// remains unknown; this method never dispatches the command again.
func (s *Service) Operation(ctx context.Context, a Actor, kind string, r, command Object, operationID string) (Object, error) {
	if e := request(kind, r); e != nil {
		return nil, e
	}
	input := Object{}
	for k, v := range command {
		input[k] = v
	}
	input["operationId"] = operationID
	parsed, e := ParseCommand(kind, input)
	if e != nil {
		return nil, e
	}
	expected := selection(r, parsed)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.domain().Fresh(ctx, tx, a, readPermission(kind)); e != nil {
			return nil, e
		}
		row, unknown, e := s.domain().OperationRecordWithin(ctx, tx, operationID)
		if e != nil {
			return nil, e
		}
		if unknown {
			return nil, fail("operations_command_receipt_unavailable", 503)
		}
		if row == nil {
			return nil, nil
		}
		if row["operator_id"] != a.ID || row["action"] != kind || !equal(row["selection"], expected) {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return object(row["result"]), nil
	})
}

// Control is the existing human HTTP action: empty request body, no replacement
// operation ID, and the original separate business audit shape.
func (s *Service) Control(ctx context.Context, a Actor, queue, id, action string) (Object, error) {
	if !has(aiQueues, queue) || !uuidPattern.MatchString(id) || !has([]string{"cancel", "retry"}, action) {
		return nil, fail("invalid_operations_query", 400)
	}
	kind := "job-" + action
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actual, e := s.domain().Fresh(ctx, tx, a, permission(kind))
		if e != nil {
			return nil, e
		}
		if domain := domainPermission(queue, kind); domain != "" {
			actual, e = s.domain().Fresh(ctx, tx, actual, domain)
			if e != nil {
				return nil, e
			}
		}
		after, result, e := s.mutateQueue(ctx, tx, actual, queue, id, kind, nil)
		if e != nil {
			return nil, e
		}
		selected := Object{"queue": queue, "jobId": id}
		if g, ok := result["generation"]; ok {
			selected["generation"] = g
		}
		audit := Object{"state": result["state"], "previousState": result["previousState"], "changed": result["changed"]}
		if e = s.domain().Record(ctx, tx, actual, kind, selected, audit, nil); e != nil {
			return nil, e
		}
		return after, nil
	})
}
func (s *Service) RetrySearch(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	if !uuidPattern.MatchString(id) || !exact(input, "expectedGeneration") || !integer(input["expectedGeneration"], 1) {
		return nil, fail("invalid_search_recovery", 400)
	}
	if s.Search == nil {
		return nil, fail("operations_search_unavailable", 503)
	}
	actual := a
	return s.Search.RetryFailed(ctx, id, number(input["expectedGeneration"]), discovery.LegacyRetryOptions{
		Authorize: func(ctx context.Context, tx pgx.Tx) error {
			var e error
			actual, e = s.domain().Fresh(ctx, tx, a, "search.retry")
			return e
		},
		Audit: func(ctx context.Context, tx pgx.Tx, result Object) error {
			return s.domain().Record(ctx, tx, actual, "search-retry", Object{"jobId": result["jobId"], "generation": result["generation"]}, Object{"state": result["state"], "changed": true}, nil)
		},
	})
}
