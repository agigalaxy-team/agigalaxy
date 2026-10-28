package discovery

import (
	"context"
	"errors"
	"time"
)

func nativeFailure(e error) string {
	var native *EngineError
	if errors.As(e, &native) {
		return native.Code
	}
	if code := errorCode(e); code != "internal_error" {
		return code
	}
	return "search_quality_native_unavailable"
}
func (q *SearchQuality) advance(ctx context.Context, row Object, phase string, task *int64, code *string) (Object, error) {
	tx, e := q.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	if e = q.lock(ctx, tx); e != nil {
		return nil, e
	}
	current, e := q.operation(ctx, tx, str(row, "operation_id"))
	if e != nil {
		return nil, e
	}
	if current == nil || !qualityPhase(str(current, "phase")) {
		return current, nil
	}
	updated, e := rowObject(ctx, tx, `UPDATE operations_search_quality_operations_v1 SET phase=$3,native_task_id=coalesce($4,native_task_id),error_code=$5,updated_at=$6 WHERE endpoint=$1 AND operation_id=$2 RETURNING to_jsonb(operations_search_quality_operations_v1)`, q.Endpoint, row["operation_id"], phase, task, code, q.now())
	if e != nil {
		return nil, e
	}
	if phase == "applied" {
		_, e = tx.Exec(ctx, `UPDATE operations_search_quality_state_v1 SET active_id=$3,pending_operation=NULL,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND pending_operation=$2`, q.Endpoint, row["operation_id"], row["version_id"], q.now())
	} else if phase == "failed" {
		_, e = tx.Exec(ctx, `UPDATE operations_search_quality_state_v1 SET pending_operation=NULL,revision=revision+1,updated_at=$3 WHERE endpoint=$1 AND pending_operation=$2`, q.Endpoint, row["operation_id"], q.now())
	}
	if e != nil {
		return nil, e
	}
	return updated, tx.Commit(ctx)
}
func (q *SearchQuality) submit(ctx context.Context, actor Actor, row Object) (Object, error) {
	action := qualityAction(str(row, "kind"))
	if _, e := q.authorize(ctx, actor, action); e != nil {
		return nil, e
	}
	claimed, e := rowObject(ctx, q.Pool, `UPDATE operations_search_quality_operations_v1 SET phase='submitting',submitted_at=$3,updated_at=$3 WHERE endpoint=$1 AND operation_id=$2 AND phase='prepared' RETURNING to_jsonb(operations_search_quality_operations_v1)`, q.Endpoint, row["operation_id"], q.now())
	if e != nil {
		return nil, e
	}
	if claimed == nil {
		return q.Reconcile(ctx, str(row, "operation_id"))
	}
	target, e := q.version(ctx, q.Pool, str(row, "version_id"))
	if e != nil {
		return nil, e
	}
	if _, e = q.authorize(ctx, actor, action); e != nil {
		code := nativeFailure(e)
		settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if _, persist := q.advance(settle, claimed, "failed", nil, &code); persist != nil {
			return nil, persist
		}
		return nil, e
	}
	var task int64
	var submitError error
	if q.Meili == nil {
		submitError = fail("search_quality_native_unavailable")
	} else {
		task, submitError = q.Meili.SubmitSettings(ctx, object(target["native_settings"]))
	}
	settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if submitError == nil {
		return q.advance(settle, claimed, "task-pending", &task, nil)
	}
	phase := "result-unknown"
	var native *EngineError
	if errors.As(submitError, &native) {
		switch native.NativeStatus {
		case 400, 401, 403, 404, 405, 413, 415, 422, 429:
			phase = "failed"
		}
	}
	if errorCode(submitError) == "discovery_engine_authorization_failed" {
		phase = "failed"
	}
	code := nativeFailure(submitError)
	return q.advance(settle, claimed, phase, nil, &code)
}
func (q *SearchQuality) Reconcile(ctx context.Context, id string) (Object, error) {
	owner := q
	if q.reconcileOwner != nil {
		owner = q.reconcileOwner
	}
	owner.reconcileMu.Lock()
	if owner.reconciling == nil {
		owner.reconciling = map[string]*qualityFlight{}
	}
	if existing := owner.reconciling[id]; existing != nil {
		owner.reconcileMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-existing.done:
			return existing.row, existing.err
		}
	}
	flight := &qualityFlight{done: make(chan struct{})}
	owner.reconciling[id] = flight
	owner.reconcileMu.Unlock()
	row, e := q.reconcileOnce(ctx, id)
	owner.reconcileMu.Lock()
	flight.row = row
	flight.err = e
	delete(owner.reconciling, id)
	close(flight.done)
	owner.reconcileMu.Unlock()
	return row, e
}
func (q *SearchQuality) reconcileOnce(ctx context.Context, id string) (Object, error) {
	row, e := q.operation(ctx, q.Pool, id)
	if e != nil || row == nil || !qualityPhase(str(row, "phase")) || str(row, "phase") == "prepared" {
		return row, e
	}
	target, e := q.version(ctx, q.Pool, str(row, "version_id"))
	if e != nil {
		return nil, e
	}
	advance := func(phase string, task *int64, code string) (Object, error) {
		var failure *string
		if code != "" {
			failure = &code
		}
		return q.advance(ctx, row, phase, task, failure)
	}
	var task *SettingsTask
	if q.Meili == nil {
		return advance("result-unknown", nil, "search_quality_native_unavailable")
	}
	if row["native_task_id"] != nil {
		taskID, ok := integer(row["native_task_id"])
		if !ok {
			return advance("result-unknown", nil, "search_quality_native_task_missing")
		}
		task, e = q.Meili.SettingsTask(ctx, taskID)
	} else {
		page, readError := q.Meili.SettingsTasks(ctx, number(row, "native_watermark"), 100, false)
		e = readError
		if e == nil {
			matches := []SettingsTask{}
			for _, candidate := range page.Items {
				if candidate.Settings != nil && sameNative(candidate.Settings, object(target["native_settings"])) {
					matches = append(matches, candidate)
				}
			}
			if !page.Complete || len(matches) != 1 {
				return advance("result-unknown", nil, "search_quality_native_result_unknown")
			}
			task = &matches[0]
			row, e = q.advance(ctx, row, "task-pending", &task.ID, nil)
		}
	}
	if e != nil {
		return advance("result-unknown", nil, nativeFailure(e))
	}
	if task == nil {
		return advance("result-unknown", nil, "search_quality_native_task_missing")
	}
	if task.Status == "enqueued" || task.Status == "processing" {
		return advance("task-pending", &task.ID, "")
	}
	if task.Status == "failed" || task.Status == "canceled" {
		return advance("failed", &task.ID, "search_quality_native_task_failed")
	}
	current, e := q.observedSettings(ctx)
	if e != nil {
		return advance("result-unknown", nil, nativeFailure(e))
	}
	if !sameNative(current, object(target["native_settings"])) {
		return advance("result-unknown", &task.ID, "search_quality_native_readback_mismatch")
	}
	return advance("applied", &task.ID, "")
}
func (q *SearchQuality) Command(ctx context.Context, actor Actor, kind string, input Object) (Object, error) {
	normalized, e := parseQualityInput(kind, input)
	if e != nil {
		return nil, e
	}
	row, replayed, e := q.prepare(ctx, actor, kind, normalized)
	if e != nil {
		return nil, e
	}
	if kind != "draft" {
		if str(row, "phase") == "prepared" {
			row, e = q.submit(ctx, actor, row)
			if e != nil {
				return nil, e
			}
		}
		if qualityPhase(str(row, "phase")) {
			row, e = q.Reconcile(ctx, str(row, "operation_id"))
			if e != nil {
				return nil, e
			}
		}
	}
	if _, e = q.authorize(ctx, actor, qualityAction(kind)); e != nil {
		return nil, e
	}
	return merge(operationView(row, replayed), q.metadata()), nil
}
