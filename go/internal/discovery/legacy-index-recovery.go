package discovery

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const recoveryPending = `EXISTS(SELECT 1 FROM galaxy_go_jobs.executions_v1 e JOIN galaxy_river.river_job q ON q.id=e.river_id WHERE e.endpoint=$2 AND e.action='search-recovery' AND e.source_id=j.id AND e.superseded_at IS NULL AND q.args->>'generation'=j.payload->>'generation' AND q.state IN ('available','scheduled','running','retryable'))`

func (s *LegacyIndex) RecoverFailed(ctx context.Context, limit int) (Object, error) {
	if s.Jobs == nil {
		return Object{"queued": 0, "configured": false}, nil
	}
	if limit < 1 || limit > 100 {
		return nil, errors.New("invalid search recovery batch")
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	var enabled bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM search_index_control WHERE enabled AND endpoint=$1)", s.Endpoint).Scan(&enabled); e != nil {
		return nil, e
	}
	if !enabled {
		return Object{"queued": 0}, nil
	}
	rows, e := tx.Query(ctx, `SELECT j.id::text,j.payload,j.available_at,j.search_recovery_generation,j.search_recovery_count FROM jobs j WHERE j.kind='search-index' AND j.state='failed' AND j.attempts>=5 AND (j.search_recovery_generation<>COALESCE((j.payload->>'generation')::int,1) OR j.search_recovery_count<3) AND NOT EXISTS(SELECT 1 FROM search_documents d WHERE d.source_type=j.payload->>'sourceType' AND d.source_id=(j.payload->>'sourceId')::uuid AND d.valid_until>$1) AND NOT EXISTS(SELECT 1 FROM galaxy_go_jobs.executions_v1 e JOIN galaxy_river.river_job q ON q.id=e.river_id WHERE e.endpoint=$3 AND e.action='search-recovery' AND e.source_id=j.id AND e.superseded_at IS NULL AND q.args->>'generation'=j.payload->>'generation' AND q.state IN ('available','scheduled','running','retryable','cancelled')) ORDER BY j.available_at,j.id LIMIT $2 FOR UPDATE OF j SKIP LOCKED`, s.now(), limit, s.Endpoint)
	if e != nil {
		return nil, e
	}
	type failed struct {
		id         string
		payload    Object
		available  time.Time
		generation int64
		count      int
	}
	found := []failed{}
	for rows.Next() {
		var f failed
		var raw []byte
		if e = rows.Scan(&f.id, &raw, &f.available, &f.generation, &f.count); e != nil {
			rows.Close()
			return nil, e
		}
		if e = decode(raw, &f.payload); e != nil {
			rows.Close()
			return nil, e
		}
		found = append(found, f)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	queued := 0
	for _, row := range found {
		generation := number(row.payload, "generation")
		if generation == 0 {
			generation = 1
		}
		attempt := 1
		if row.generation == generation {
			attempt = row.count + 1
		}
		start := s.now()
		if row.available.After(start) {
			start = row.available
		}
		start = start.Add(time.Duration(min(3600, 60*(1<<(attempt-1)))) * time.Second)
		key := "search:" + row.id + ":" + strconv.FormatInt(generation, 10) + ":" + strconv.Itoa(attempt)
		identity := []string{s.Endpoint, jobs.SearchRecovery, key}
		id := uuid.NewSHA1(uuid.NameSpaceURL, []byte(jsonString(identity))).String()
		var exists bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM galaxy_go_jobs.executions_v1 WHERE endpoint=$1 AND id=$2)", s.Endpoint, id).Scan(&exists)
		if e != nil {
			return nil, e
		}
		// Prior completed transports also survive manual counter reset. Their
		// receipts remain immutable; a newly eligible cycle needs a new UUID.
		if exists {
			id = uuid.NewString()
		}
		task := jobs.Task{ID: id, Endpoint: s.Endpoint, Action: jobs.SearchRecovery, SourceID: row.id, OperationID: id, Generation: generation, RecoveryAttempt: attempt}
		enqueued, e := s.Jobs.EnqueueWithin(ctx, tx, task, start)
		if e != nil {
			return nil, e
		}
		if enqueued != "" {
			if _, e = tx.Exec(ctx, "UPDATE jobs SET search_recovery_generation=$2,search_recovery_count=$3,search_recovery_at=$4 WHERE id=$1", row.id, generation, attempt, start); e != nil {
				return nil, e
			}
			queued++
		}
	}
	return Object{"queued": queued}, tx.Commit(ctx)
}
func (s *LegacyIndex) RecoverJob(ctx context.Context, task jobs.Task) (Object, error) {
	if task.Endpoint != s.Endpoint || task.Action != jobs.SearchRecovery || !validID(task.SourceID) || task.Generation < 1 || task.Generation > 2147483647 || task.RecoveryAttempt < 1 || task.RecoveryAttempt > 3 {
		return nil, qualityFailure("invalid_search_recovery", 400)
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	job, e := rowObject(ctx, tx, "SELECT to_jsonb(j) FROM jobs j WHERE id=$1 AND kind='search-index' FOR UPDATE", task.SourceID)
	if e != nil {
		return nil, e
	}
	if job == nil || str(job, "state") != "failed" || number(job, "attempts") < 5 || number(object(job["payload"]), "generation") != task.Generation || number(job, "search_recovery_generation") != task.Generation || number(job, "search_recovery_count") != int64(task.RecoveryAttempt) {
		return Object{"state": "superseded"}, nil
	}
	var enabled bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM search_index_control WHERE enabled AND endpoint=$1)", s.Endpoint).Scan(&enabled); e != nil {
		return nil, e
	}
	if !enabled {
		return Object{"state": "disabled"}, nil
	}
	if _, e = tx.Exec(ctx, "UPDATE jobs SET state='pending',attempts=0,lease_id=NULL,locked_until=NULL,available_at=$2 WHERE id=$1", task.SourceID, s.now()); e != nil {
		return nil, e
	}
	return Object{"state": "requeued", "jobId": task.SourceID, "generation": task.Generation}, tx.Commit(ctx)
}
func (s *LegacyIndex) Work(ctx context.Context, task jobs.Task) (jobs.Outcome, error) {
	result, e := s.RecoverJob(ctx, task)
	return jobs.Outcome{Result: result}, e
}

type LegacyRetryOptions struct {
	Authorize func(context.Context, pgx.Tx) error
	Audit     func(context.Context, pgx.Tx, Object) error
}

func (s *LegacyIndex) RetryFailed(ctx context.Context, id string, generation int64, options LegacyRetryOptions) (Object, error) {
	if !validID(id) || generation < 1 {
		return nil, qualityFailure("invalid_search_recovery", 400)
	}
	if options.Authorize == nil || s.Jobs == nil {
		return nil, qualityFailure("operations_authorization_unavailable", 503)
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	if e = options.Authorize(ctx, tx); e != nil {
		return nil, e
	}
	job, e := rowObject(ctx, tx, "SELECT to_jsonb(j) FROM jobs j WHERE id=$1 AND kind='search-index' FOR UPDATE", id)
	if e != nil {
		return nil, e
	}
	if job == nil {
		return nil, qualityFailure("search_job_not_found", 404)
	}
	if str(job, "state") != "failed" || number(object(job["payload"]), "generation") != generation {
		return nil, qualityFailure("search_recovery_conflict")
	}
	var enabled bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM search_index_control WHERE enabled AND endpoint=$1)", s.Endpoint).Scan(&enabled); e != nil {
		return nil, e
	}
	if !enabled {
		return nil, qualityFailure("search_index_disabled")
	}
	if _, e = s.Jobs.SupersedeSearchRecoveryWithin(ctx, tx, s.Endpoint, id, generation); e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `UPDATE jobs SET state='pending',attempts=0,lease_id=NULL,locked_until=NULL,available_at=$2,search_recovery_count=0,search_recovery_generation=$3,search_recovery_at=NULL WHERE id=$1`, id, s.now(), generation); e != nil {
		return nil, e
	}
	result := Object{"jobId": id, "generation": generation, "state": "pending"}
	if options.Audit != nil {
		if e = options.Audit(ctx, tx, result); e != nil {
			return nil, e
		}
	}
	return result, tx.Commit(ctx)
}
func legacyFailureView(row Object, includeState bool) Object {
	payload := object(row["payload"])
	generation := number(payload, "generation")
	attempts := int64(0)
	if number(row, "search_recovery_generation") == generation {
		attempts = number(row, "search_recovery_count")
	}
	pending := row["recovery_pending"] == true
	var at any
	if row["search_recovery_at"] != nil {
		at = stamp(row["search_recovery_at"])
	}
	out := Object{"jobId": row["id"], "sourceType": payload["sourceType"], "sourceId": payload["sourceId"], "subjectId": payload["subjectId"], "generation": payload["generation"], "attempts": row["attempts"], "recoveryAttempts": attempts, "automaticRecoveryPending": pending, "automaticRecoveryExhausted": number(row, "search_recovery_generation") == generation && number(row, "search_recovery_count") >= 3 && !pending, "recoveryAt": at}
	if includeState {
		out["state"] = row["state"]
	}
	return out
}
func (s *LegacyIndex) Failures(ctx context.Context, after string, limit int) (Object, error) {
	if limit < 1 || limit > 100 || after != "" && !validID(after) {
		return nil, qualityFailure("invalid_search_recovery", 400)
	}
	rows, e := s.Pool.Query(ctx, "SELECT to_jsonb(j)||jsonb_build_object('recovery_pending',"+recoveryPending+") FROM jobs j WHERE j.kind='search-index' AND j.state='failed' AND ($1::uuid IS NULL OR j.id>$1) ORDER BY j.id LIMIT $3", nullableString(after), s.Endpoint, limit+1)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	found := []Object{}
	for rows.Next() {
		var raw []byte
		var row Object
		if e = rows.Scan(&raw); e != nil {
			return nil, e
		}
		if e = decode(raw, &row); e != nil {
			return nil, e
		}
		found = append(found, row)
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	selected := found
	if len(selected) > limit {
		selected = selected[:limit]
	}
	items := []Object{}
	for _, row := range selected {
		items = append(items, legacyFailureView(row, false))
	}
	var next any
	if len(found) > limit {
		next = selected[len(selected)-1]["id"]
	}
	return Object{"items": items, "nextAfter": next}, nil
}
func (s *LegacyIndex) FailureStatus(ctx context.Context, id string) (Object, error) {
	if !validID(id) {
		return nil, qualityFailure("invalid_search_recovery", 400)
	}
	row, e := rowObject(ctx, s.Pool, "SELECT to_jsonb(j)||jsonb_build_object('recovery_pending',"+recoveryPending+") FROM jobs j JOIN search_index_control c ON c.singleton AND c.endpoint=$2 WHERE j.id=$1 AND j.kind='search-index'", id, s.Endpoint)
	if e != nil || row == nil {
		return nil, e
	}
	return legacyFailureView(row, true), nil
}
