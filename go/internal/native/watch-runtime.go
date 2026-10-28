package native

import (
	"context"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type nativeWatchRunner struct {
	id              string
	lease           *nativeIdentityLease
	host            map[string]any
	driver          NativeWatchDriver
	scopeKey, grant string
	expires         int64
	execution       map[string]any
	abort           context.CancelFunc
	timer, expiry   *time.Timer
	inFlight        *capsuleWorkFlight
}
type NativeWatchRuntime struct {
	runtime        *Runtime
	watch          *NativeWatch
	mu             sync.Mutex
	closed         bool
	owners         map[string]bool
	drivers        map[string]NativeWatchDriver
	configurations map[string]map[string]any
	runners        map[string]*nativeWatchRunner
	operations     sync.WaitGroup
}

func NewNativeWatchRuntime(r *Runtime) *NativeWatchRuntime {
	return &NativeWatchRuntime{runtime: r, watch: NewNativeWatch(r), owners: map[string]bool{}, drivers: map[string]NativeWatchDriver{}, configurations: map[string]map[string]any{}, runners: map[string]*nativeWatchRunner{}}
}
func watchRunnerKey(l *nativeIdentityLease, id string) string { return l.scope.Owner + ":" + id }
func (h *NativeWatchRuntime) driver(l *nativeIdentityLease) (NativeWatchDriver, map[string]any, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, nil, watchFailure("watch_runtime_closed")
	}
	if driver, ok := h.drivers[l.scope.Owner]; ok {
		return driver, h.configurations[l.scope.Owner], nil
	}
	driver, configuration, e := NewConfiguredNativeWatchDriver(h.runtime.config.WatchHost)
	if e != nil {
		return nil, nil, e
	}
	h.drivers[l.scope.Owner] = driver
	h.configurations[l.scope.Owner] = configuration
	return driver, configuration, nil
}
func (h *NativeWatchRuntime) current(ctx context.Context, runner *nativeWatchRunner, host bool) bool {
	h.mu.Lock()
	valid := !h.closed && h.runners[watchRunnerKey(runner.lease, runner.id)] == runner
	if host {
		valid = valid && runner.host != nil && runner.expires > h.watch.now()
	}
	h.mu.Unlock()
	return valid && runner.lease.check(ctx) == nil
}
func nativeWatchScopeKey(l *nativeIdentityLease, id, grant string) string {
	lease := protocol.NewOrderedObject()
	for _, k := range []string{"subjectId", "endpoint", "bindingId", "generation"} {
		lease.Set(k, nativeWatchBinding(l)[k])
	}
	out := protocol.NewOrderedObject()
	out.Set("lease", lease)
	out.Set("watchId", id)
	out.Set("agentGrantId", grant)
	raw, _ := protocol.EncodeJS(out)
	return string(raw)
}
func (h *NativeWatchRuntime) restore(ctx context.Context, l *nativeIdentityLease, activate bool) error {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return watchFailure("watch_runtime_closed")
	}
	seen := h.owners[l.scope.Owner]
	h.owners[l.scope.Owner] = true
	h.mu.Unlock()
	if seen || !activate {
		return nil
	}
	snapshot, e := h.watch.Status(ctx, l, "")
	if e != nil {
		return e
	}
	for _, v := range uploadRows(snapshot["items"]) {
		row := uploadObject(v)
		if row["state"] == "active" {
			if _, e = h.Activate(ctx, l, text(row["id"]), nil, nil); e != nil {
				return e
			}
		}
	}
	return nil
}
func (h *NativeWatchRuntime) schedule(runner *nativeWatchRunner) {
	if !h.current(context.Background(), runner, false) {
		return
	}
	row, e := h.watch.row(context.Background(), runner.lease, runner.id)
	if e != nil || row == nil || row["state"] != "active" || integer(row["expiresAt"]) <= h.watch.now() || row["pending"] != nil {
		return
	}
	due := integer(row["nextCheckAt"])
	delay := time.Duration(due-h.watch.now()) * time.Second
	if delay < 0 {
		delay = 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.runners[watchRunnerKey(runner.lease, runner.id)] != runner {
		return
	}
	if runner.timer != nil {
		runner.timer.Stop()
	}
	runner.timer = time.AfterFunc(delay, func() { _, _ = h.Check(context.Background(), runner.lease, runner.id, "fallback") })
}
func (h *NativeWatchRuntime) Activate(ctx context.Context, l *nativeIdentityLease, id string, host map[string]any, scope *ChoiceScope) (map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var row map[string]any
	var driver NativeWatchDriver
	if host != nil {
		if scope == nil || *scope != l.scope {
			return nil, watchFailure("watch_host_choice_required")
		}
		var e error
		driver, _, e = h.driver(l)
		if e != nil {
			return nil, e
		}
		if driver == nil {
			return nil, watchFailure("watch_host_not_configured")
		}
		row, e = h.watch.row(ctx, l, id)
		if e != nil {
			return nil, e
		}
		binding := uploadObject(row["bindingLease"])
		if row == nil || text(row["agentGrantId"]) == "" || row["state"] != "active" || integer(row["expiresAt"]) <= h.watch.now() || binding != nil && !connectionEqual(binding, nativeWatchBinding(l)) {
			return nil, watchFailure("watch_host_active_grant_required")
		}
	}
	key := watchRunnerKey(l, id)
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, watchFailure("watch_runtime_closed")
	}
	runner := h.runners[key]
	if runner != nil && host != nil && (runner.host != nil || runner.inFlight != nil) {
		h.mu.Unlock()
		return nil, watchFailure("watch_host_already_active")
	}
	if runner != nil && host != nil {
		if runner.timer != nil {
			runner.timer.Stop()
		}
		delete(h.runners, key)
		runner = nil
	}
	if runner == nil {
		runner = &nativeWatchRunner{id: id, lease: l, host: host, driver: driver}
		if host != nil {
			runner.grant = text(row["agentGrantId"])
			runner.expires = integer(row["expiresAt"])
			runner.scopeKey = nativeWatchScopeKey(l, id, runner.grant)
			pending := uploadObject(row["pending"])
			if execution := uploadObject(pending["hostExecution"]); execution != nil {
				runner.execution = identityClone(execution)
				runner.execution["workId"] = pending["workId"]
			}
			delay := time.Duration(runner.expires-h.watch.now()) * time.Second
			if delay < 0 {
				delay = 0
			}
			runner.expiry = time.AfterFunc(delay, func() { _, _ = h.Halt(context.Background(), l, id, "expired") })
		}
		h.runners[key] = runner
	}
	h.mu.Unlock()
	h.schedule(runner)
	status, e := h.Status(ctx, l, id)
	if e != nil {
		return nil, e
	}
	status["watchId"] = id
	status["result"] = map[string]any{"state": "activated", "modelCalls": 0}
	return status, nil
}
func (h *NativeWatchRuntime) Status(ctx context.Context, l *nativeIdentityLease, id string) (map[string]any, error) {
	result, e := h.watch.Status(ctx, l, id)
	if e != nil {
		return nil, e
	}
	return h.projectStatus(result, l.scope.Owner), nil
}
func (h *NativeWatchRuntime) projectStatus(result map[string]any, owner string) map[string]any {
	active := 0
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, v := range uploadRows(result["items"]) {
		row := uploadObject(v)
		runner := h.runners[owner+":"+text(row["id"])]
		row["hostState"] = "suspended-host"
		if row["state"] != "active" {
			row["hostState"] = "not-running"
		} else if runner != nil {
			row["hostState"] = "running-host"
		}
		row["hostModelEnabled"] = runner != nil && runner.host != nil
		execution := uploadObject(uploadObject(row["pending"])["hostExecution"])
		if execution == nil {
			execution = uploadObject(row["lastHostExecution"])
		}
		uncertain := execution != nil && uploadObject(execution["cancellation"])["executionEnded"] != true && isOne(text(execution["state"]), "unknown", "dispatching")
		row["modelRunning"] = false
		row["hostModelState"] = "not-running"
		if uncertain {
			row["modelRunning"] = nil
			row["hostModelState"] = "unconfirmed"
		}
		if runner != nil && runner.host != nil {
			actual := runner.driver.Status(runner.id, runner.scopeKey)
			if actual != nil && actual["state"] != "not-running" {
				row["modelRunning"] = actual["modelRunning"]
				row["hostModelState"] = actual["state"]
			}
		}
	}
	for _, runner := range h.runners {
		if runner.lease.scope.Owner == owner {
			active++
		}
	}
	state := "idle-host"
	if active > 0 {
		state = "running-host"
	}
	result["runtime"] = map[string]any{"eventDriven": false, "fallbackPollMinutes": 15, "active": active, "hostState": state}
	return result
}
func (h *NativeWatchRuntime) Check(ctx context.Context, l *nativeIdentityLease, id, cause string) (out map[string]any, err error) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, watchFailure("watch_runtime_closed")
	}
	runner := h.runners[watchRunnerKey(l, id)]
	if runner == nil {
		h.mu.Unlock()
		return nil, watchFailure("watch_runtime_not_active")
	}
	if old := runner.inFlight; old != nil {
		h.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-old.done:
			return uploadObject(old.result), old.err
		}
	}
	flight := &capsuleWorkFlight{done: make(chan struct{})}
	runner.inFlight = flight
	h.operations.Add(1)
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		runner.inFlight = nil
		flight.result, flight.err = out, err
		close(flight.done)
		h.mu.Unlock()
		h.schedule(runner)
		h.operations.Done()
	}()
	result, e := h.watch.Check(ctx, l, id, cause == "event", runner.host != nil)
	if e != nil {
		return nil, e
	}
	if !h.current(ctx, runner, false) {
		return map[string]any{"state": "suspended-host", "modelCalls": 0, "workSuppressed": true}, nil
	}
	if runner.host != nil {
		if runner.expires <= h.watch.now() {
			_, _ = h.Halt(ctx, l, id, "expired")
			return map[string]any{"state": "inactive", "reason": "watch-expired", "modelCalls": 0, "workSuppressed": true}, nil
		}
		if !h.current(ctx, runner, true) {
			_, _ = h.Halt(ctx, l, id, "paused")
			return map[string]any{"state": "binding-changed", "modelCalls": 0, "workSuppressed": true}, nil
		}
		if result["state"] == "work-completed-pending-ack" {
			if !connectionEqual(uploadObject(result["hostExecution"])["lease"], nativeWatchBinding(l)) {
				return map[string]any{"state": "host-result-pending", "modelCalls": 0, "reason": "original-binding-required"}, nil
			}
			return h.acknowledgeHost(ctx, runner, text(result["workId"]), uploadObject(result["hostExecution"]), 0)
		}
		if result["state"] == "work-ready" {
			return h.process(ctx, runner, result)
		}
	}
	return result, nil
}
func (h *NativeWatchRuntime) acknowledgeHost(ctx context.Context, runner *nativeWatchRunner, workID string, execution map[string]any, modelCalls any) (map[string]any, error) {
	_, e := h.watch.VerifyHostWork(ctx, runner.lease, runner.id, workID)
	if e == nil && !h.current(ctx, runner, true) {
		return map[string]any{"state": "binding-changed", "modelCalls": modelCalls, "workSuppressed": true}, nil
	}
	var receipt map[string]any
	if e == nil {
		receipt, e = h.watch.Ack(ctx, runner.lease, runner.id, workID)
	}
	if e != nil {
		return map[string]any{"state": "host-completed-ack-unconfirmed", "workId": workID, "modelCalls": modelCalls, "execution": execution, "retryOriginalAckOnly": true}, nil
	}
	if !h.current(ctx, runner, true) {
		return map[string]any{"state": "binding-changed", "modelCalls": modelCalls, "workSuppressed": true}, nil
	}
	return map[string]any{"state": "processed", "workId": workID, "modelCalls": modelCalls, "execution": execution, "receipt": receipt}, nil
}
func (h *NativeWatchRuntime) process(ctx context.Context, runner *nativeWatchRunner, result map[string]any) (map[string]any, error) {
	work := uploadObject(result["work"])
	workID := text(work["workId"])
	scope, e := h.watch.VerifyHostWork(ctx, runner.lease, runner.id, workID)
	if e != nil {
		return nil, e
	}
	if !h.current(ctx, runner, true) || scope["agentGrantId"] != runner.grant {
		return map[string]any{"state": "binding-changed", "modelCalls": 0, "workSuppressed": true}, nil
	}
	journal := func(state map[string]any) map[string]any {
		out := identityClone(state)
		out["model"] = runner.host["model"]
		out["lease"] = nativeWatchBinding(runner.lease)
		out["scopeKey"] = runner.scopeKey
		out["agentGrantId"] = runner.grant
		return out
	}
	record := func(state map[string]any) error {
		metadata := journal(state)
		h.mu.Lock()
		runner.execution = identityClone(metadata)
		runner.execution["workId"] = workID
		h.mu.Unlock()
		return h.watch.RecordHostExecution(ctx, runner.lease, runner.id, workID, metadata)
	}
	if e = record(map[string]any{"state": "dispatching"}); e != nil {
		return nil, e
	}
	if !h.current(ctx, runner, true) {
		return map[string]any{"state": "binding-changed", "modelCalls": 0, "workSuppressed": true}, nil
	}
	runCtx, cancel := context.WithCancel(ctx)
	h.runtime.mu.Lock()
	lifecycle := h.runtime.lifecycle
	h.runtime.mu.Unlock()
	stopLifecycle := context.AfterFunc(lifecycle, cancel)
	defer stopLifecycle()
	h.mu.Lock()
	runner.abort = cancel
	h.mu.Unlock()
	defer cancel()
	execution, e := runner.driver.Run(runCtx, WatchHostRunInput{WatchID: runner.id, Work: work, Purpose: text(scope["purpose"]), Model: text(runner.host["model"]), CWD: text(runner.host["cwd"]), ScopeKey: runner.scopeKey, IsCurrent: func() bool { return h.current(runCtx, runner, true) }, OnState: record})
	if e != nil {
		execution = map[string]any{"state": "unknown", "reason": "host-operation-unconfirmed"}
	}
	attempts := integer(execution["hostTurnDispatches"])
	var modelCalls any = int64(0)
	if attempts > 0 {
		modelCalls = nil
	}
	if !h.current(ctx, runner, true) {
		return map[string]any{"state": "suspended-host", "modelCalls": modelCalls, "hostTurnsAttempted": attempts, "workSuppressed": true}, nil
	}
	metadata := map[string]any{"state": execution["state"]}
	for _, k := range []string{"reason", "threadId", "turnId"} {
		if value, ok := execution[k]; ok {
			metadata[k] = value
		}
	}
	if e = record(metadata); e != nil {
		return nil, e
	}
	metadata = journal(metadata)
	if !h.current(ctx, runner, true) {
		return map[string]any{"state": "binding-changed", "modelCalls": modelCalls, "hostTurnsAttempted": attempts, "workSuppressed": true}, nil
	}
	if execution["state"] != "completed" {
		return map[string]any{"state": "host-result-pending", "workId": workID, "modelCalls": modelCalls, "hostTurnsAttempted": attempts, "execution": metadata, "automaticRetry": false}, nil
	}
	out, e := h.acknowledgeHost(ctx, runner, workID, metadata, modelCalls)
	if e != nil {
		return nil, e
	}
	out["hostTurnsAttempted"] = attempts
	if out["state"] == "processed" {
		out["output"] = execution["output"]
	}
	return out, nil
}
