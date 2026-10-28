package native

import "context"

func (h *NativeWatchRuntime) Halt(ctx context.Context, l *nativeIdentityLease, id, final string) (map[string]any, error) {
	h.mu.Lock()
	runner := h.runners[watchRunnerKey(l, id)]
	if runner != nil {
		delete(h.runners, watchRunnerKey(l, id))
		if runner.timer != nil {
			runner.timer.Stop()
		}
		if runner.expiry != nil {
			runner.expiry.Stop()
		}
	}
	h.mu.Unlock()
	grant := ""
	if runner != nil && runner.host != nil {
		grant = runner.grant
	}
	galaxy, originalError := h.watch.Halt(ctx, l, id, final, grant)
	if runner != nil && runner.host != nil {
		h.mu.Lock()
		abort := runner.abort
		reference := identityClone(runner.execution)
		h.mu.Unlock()
		if reference == nil {
			reference = map[string]any{}
		}
		if abort != nil {
			abort()
		}
		reference["scopeKey"] = runner.scopeKey
		result, e := runner.driver.Cancel(ctx, id, reference)
		if e != nil {
			result = map[string]any{"state": "unknown", "cancellationConfirmed": false, "executionEnded": false}
		}
		if e = h.watch.RecordHostCancellation(ctx, l, id, reference, result); e != nil && originalError == nil {
			originalError = e
		}
		if galaxy != nil {
			galaxy["externalModelCancellation"] = result["state"]
			galaxy["hostCancellation"] = result
		}
	}
	if originalError != nil {
		return nil, originalError
	}
	return galaxy, nil
}
func (h *NativeWatchRuntime) Ack(ctx context.Context, l *nativeIdentityLease, id, workID string) (map[string]any, error) {
	h.mu.Lock()
	runner := h.runners[watchRunnerKey(l, id)]
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return nil, watchFailure("watch_runtime_closed")
	}
	if runner == nil {
		return nil, watchFailure("watch_runtime_not_active")
	}
	result, e := h.watch.Ack(ctx, l, id, workID)
	h.schedule(runner)
	return result, e
}
func (h *NativeWatchRuntime) ReconcileHost(ctx context.Context, l *nativeIdentityLease, id, workID string) (map[string]any, error) {
	driver, _, e := h.driver(l)
	if e != nil {
		return nil, e
	}
	if driver == nil {
		return nil, watchFailure("watch_host_not_configured")
	}
	row, e := h.watch.row(ctx, l, id)
	if e != nil {
		return nil, e
	}
	pending := uploadObject(row["pending"])
	var execution map[string]any
	if workID != "" {
		if pending["workId"] == workID {
			execution = uploadObject(pending["hostExecution"])
		} else {
			execution = uploadObject(uploadObject(row["hostStopReceipts"])[workID])
		}
	} else {
		execution = uploadObject(pending["hostExecution"])
		if execution == nil {
			execution = uploadObject(row["lastHostExecution"])
		}
	}
	if text(execution["threadId"]) == "" || text(execution["turnId"]) == "" {
		return map[string]any{"state": "unknown", "originalTurnLocatorMissing": true, "automaticRetry": false}, nil
	}
	lease := uploadObject(execution["lease"])
	if lease["subjectId"] != l.scope.Owner || lease["endpoint"] != l.scope.Endpoint {
		return nil, watchFailure("watch_host_receipt_owner_required")
	}
	current := func() bool { h.mu.Lock(); closed := h.closed; h.mu.Unlock(); return !closed && l.check(ctx) == nil }
	receipt, e := driver.Reconcile(ctx, map[string]any{"threadId": execution["threadId"], "turnId": execution["turnId"]}, current)
	if e != nil {
		return nil, e
	}
	if !current() {
		return nil, watchFailure("watch_binding_changed")
	}
	h.mu.Lock()
	runner := h.runners[watchRunnerKey(l, id)]
	h.mu.Unlock()
	if pending != nil && (workID == "" || pending["workId"] == workID) && receipt["state"] == "completed" && runner != nil && runner.host != nil && h.current(ctx, runner, true) && connectionEqual(execution["lease"], nativeWatchBinding(runner.lease)) && execution["scopeKey"] == runner.scopeKey {
		if _, e = h.watch.VerifyHostWork(ctx, l, id, text(pending["workId"])); e != nil {
			return nil, e
		}
		metadata := identityClone(execution)
		metadata["state"] = "completed"
		if e = h.watch.RecordHostExecution(ctx, l, id, text(pending["workId"]), metadata); e != nil {
			return nil, e
		}
	} else if isOne(text(receipt["state"]), "completed", "interrupted", "failed") && text(execution["workId"]) != "" {
		metadata := identityClone(receipt)
		metadata["cancellationConfirmed"] = receipt["state"] == "interrupted"
		metadata["executionEnded"] = true
		if e = h.watch.RecordHostCancellation(ctx, l, id, execution, metadata); e != nil {
			return nil, e
		}
	}
	if !current() {
		return nil, watchFailure("watch_binding_changed")
	}
	receipt["automaticRetry"] = false
	receipt["bodyIncluded"] = false
	return receipt, nil
}

// Notify is the original optional host-event signal. It never collects a new
// source, creates a Watch, selects a model, or acknowledges unprocessed work.
func (h *NativeWatchRuntime) Notify(ctx context.Context, l *nativeIdentityLease, id string) (map[string]any, error) {
	h.mu.Lock()
	runner := h.runners[watchRunnerKey(l, id)]
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return nil, watchFailure("watch_runtime_closed")
	}
	if runner == nil {
		return map[string]any{"state": "not-active", "modelCalls": 0}, nil
	}
	return h.Check(ctx, l, id, "event")
}
func (h *NativeWatchRuntime) Close() {
	h.runtime.mu.Lock()
	if h.runtime.nativeWatch == h {
		h.runtime.nativeWatch = nil
	}
	h.runtime.mu.Unlock()
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	runners := []*nativeWatchRunner{}
	for _, runner := range h.runners {
		if runner.timer != nil {
			runner.timer.Stop()
		}
		if runner.expiry != nil {
			runner.expiry.Stop()
		}
		if runner.abort != nil {
			runner.abort()
		}
		runners = append(runners, runner)
	}
	h.runners = map[string]*nativeWatchRunner{}
	drivers := []NativeWatchDriver{}
	for _, driver := range h.drivers {
		if driver != nil {
			drivers = append(drivers, driver)
		}
	}
	h.mu.Unlock()
	for _, runner := range runners {
		if runner.host == nil {
			continue
		}
		h.mu.Lock()
		reference := identityClone(runner.execution)
		h.mu.Unlock()
		if reference == nil {
			reference = map[string]any{}
		}
		reference["scopeKey"] = runner.scopeKey
		receipt, e := runner.driver.Cancel(context.Background(), runner.id, reference)
		if e == nil && reference != nil && isOne(text(receipt["state"]), "completed", "interrupted", "failed") {
			metadata := identityClone(reference)
			metadata["state"] = receipt["state"]
			_ = h.watch.RecordHostExecution(context.Background(), runner.lease, runner.id, text(reference["workId"]), metadata)
		}
	}
	h.operations.Wait()
	for _, driver := range drivers {
		_ = driver.Close(context.Background())
	}
}
