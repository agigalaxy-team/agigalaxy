package native

import (
	"context"
	"sync"
	"time"
)

type uploadScopeKey struct{}
type uploadWakeKey struct{}

func uploadScopeContext(ctx context.Context, scope ChoiceScope) context.Context {
	return context.WithValue(ctx, uploadScopeKey{}, scope)
}
func uploadChoiceScope(ctx context.Context, store *Store) (ChoiceScope, error) {
	if e := ctx.Err(); e != nil {
		return ChoiceScope{}, e
	}
	actual, e := store.ChoiceScope(ctx)
	if e != nil {
		return actual, e
	}
	if expected, ok := ctx.Value(uploadScopeKey{}).(ChoiceScope); ok && expected != actual {
		return actual, connectionFailure("native_connection_selection_changed")
	}
	return actual, nil
}

// PrivateSync owns only the original selected upload recovery loop. It never
// records host messages, runs a model, grants a scope or creates an identity.
type PrivateSync struct {
	runtime *Runtime
	mu      sync.Mutex
	timer   *time.Timer
	cancel  context.CancelFunc
	done    chan struct{}
	epoch   uint64
	closed  bool
	pending bool
	armed   bool
	delay   time.Duration
	serial  chan struct{}
	workers sync.WaitGroup
}

func NewPrivateSync(runtime *Runtime) *PrivateSync {
	return &PrivateSync{runtime: runtime, delay: time.Second, serial: make(chan struct{}, 1)}
}
func (r *Runtime) wakePrivateSync(ctx context.Context) {
	if ctx.Value(uploadWakeKey{}) == true || r.privateSync == nil {
		return
	}
	r.privateSync.mu.Lock()
	armed := r.privateSync.armed
	r.privateSync.mu.Unlock()
	if armed {
		r.privateSync.Resume(0)
	}
}
func (r *Runtime) ResumePrivateSync(delay time.Duration) {
	if r.privateSync != nil {
		r.privateSync.Resume(delay)
	}
}
func (r *Runtime) PrivateSessionComplete(ctx context.Context, host, sessionID string) (any, error) {
	if r.privateSync == nil {
		return nil, connectionFailure("native_private_sync_unavailable")
	}
	return r.privateSync.OnSessionComplete(ctx, host, sessionID)
}
func (p *PrivateSync) Resume(delay time.Duration) {
	p.runtime.mu.Lock()
	closed := p.runtime.closed
	p.runtime.mu.Unlock()
	if closed {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	p.armed = true
	if p.done != nil {
		if delay == 0 {
			p.pending = true
		}
		return
	}
	if p.timer != nil {
		if delay != 0 {
			return
		}
		p.timer.Stop()
		p.epoch++
	}
	p.scheduleLocked(delay)
}
func (p *PrivateSync) scheduleLocked(delay time.Duration) {
	epoch := p.epoch
	p.timer = time.AfterFunc(max(delay, 0), func() {
		p.mu.Lock()
		if p.closed || p.epoch != epoch {
			p.mu.Unlock()
			return
		}
		p.timer = nil
		ctx, cancel := context.WithCancel(context.Background())
		p.cancel = cancel
		done := make(chan struct{})
		p.done = done
		p.mu.Unlock()
		retry, active := p.run(ctx)
		p.mu.Lock()
		cancel()
		p.cancel = nil
		p.done = nil
		close(done)
		reschedule := !p.closed && (p.pending || epoch == p.epoch && active)
		pending := p.pending
		p.pending = false
		if retry {
			p.delay = min(p.delay*2, 5*time.Minute)
		} else {
			p.delay = time.Minute
		}
		next := p.delay
		if pending {
			next = 0
		}
		if reschedule {
			p.scheduleLocked(next)
		}
		p.mu.Unlock()
	})
}
func (p *PrivateSync) Pause() {
	p.mu.Lock()
	p.epoch++
	p.pending = false
	p.armed = false
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	if p.cancel != nil {
		p.cancel()
	}
	p.mu.Unlock()
}
func (p *PrivateSync) Close() {
	p.mu.Lock()
	p.closed = true
	p.epoch++
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	if p.cancel != nil {
		p.cancel()
	}
	done := p.done
	p.mu.Unlock()
	if done != nil {
		<-done
	}
	p.workers.Wait()
}
func (p *PrivateSync) run(ctx context.Context) (retry, active bool) {
	result, e := p.process(ctx, "", "")
	if e != nil {
		if isOne(runtimeErrorCode(e), "native_runtime_closed", "native_connection_choice_required", "native_connection_selection_changed", "native_choice_binding_changed") {
			return false, false
		}
		return true, ctx.Err() == nil
	}
	view := uploadObject(result)
	if view["state"] == "not-selected" || view["state"] == "paused" {
		return false, false
	}
	for _, group := range uploadRows(view["results"]) {
		for _, item := range uploadRows(uploadObject(group)["items"]) {
			if isOne(text(uploadObject(item)["state"]), "unknown", "not-synced", "prepared") {
				return true, true
			}
		}
	}
	return false, true
}
func (p *PrivateSync) OnSessionComplete(ctx context.Context, host, sessionID string) (any, error) {
	if !validID(host) || !validID(sessionID) {
		return nil, connectionFailure("work_sync_input_invalid")
	}
	return p.process(ctx, host, sessionID)
}
func (p *PrivateSync) process(ctx context.Context, host, sessionID string) (any, error) {
	p.mu.Lock()
	closed := p.closed
	if !closed {
		p.workers.Add(1)
	}
	p.mu.Unlock()
	if closed {
		return nil, connectionFailure("native_runtime_closed")
	}
	defer p.workers.Done()
	operation, cancel, generation, e := p.runtime.operation(ctx, true)
	if e != nil {
		return nil, e
	}
	defer cancel()
	select {
	case p.serial <- struct{}{}:
		defer func() { <-p.serial }()
	case <-operation.Done():
		return nil, operation.Err()
	}
	selected, e := p.runtime.connection.selection(operation)
	if e != nil {
		return nil, e
	}
	if selected.Permission == nil || !selected.Permission.Enabled {
		return map[string]any{"state": "paused", "networkStarted": false}, nil
	}
	scope, e := uploadChoiceScope(operation, p.runtime.store)
	if e != nil {
		return nil, e
	}
	operation = uploadScopeContext(operation, scope)
	work, archive := NewWorkUpload(p.runtime), NewArchiveUpload(p.runtime)
	w, e := work.Settings(operation)
	if e != nil {
		return nil, e
	}
	a, e := archive.Settings(operation)
	if e != nil {
		return nil, e
	}
	if uploadObject(w)["galaxyId"] != scope.Owner || uploadObject(a)["galaxyId"] != scope.Owner {
		return nil, connectionFailure("native_connection_selection_changed")
	}
	wc, ac := uploadObject(uploadObject(w)["choice"]), uploadObject(uploadObject(a)["choice"])
	if wc["enabled"] != true && ac["enabled"] != true {
		return map[string]any{"state": "not-selected", "networkStarted": false}, nil
	}
	results := []any{}
	if wc["enabled"] == true {
		if host == "" {
			v, e := work.Flush(operation, "")
			if e != nil {
				return nil, e
			}
			results = append(results, v)
		} else {
			record, e := p.runtime.store.WorkGet(operation, WorkQuery{GalaxyID: scope.Owner, Host: host, SessionID: sessionID, Limit: 1})
			if e != nil {
				return nil, e
			}
			if record != nil {
				id := text(uploadObject(uploadObject(record)["work"])["workId"])
				v, e := work.Flush(operation, id)
				if e != nil {
					return nil, e
				}
				results = append(results, v)
			}
		}
	}
	if ac["enabled"] == true {
		if host == "" {
			v, e := archive.Flush(operation, "")
			if e != nil {
				return nil, e
			}
			results = append(results, v)
		} else {
			for _, id := range mustUploadStrings(ac["archiveSessionIds"]) {
				snapshot, e := p.runtime.store.ArchiveDescribe(operation, ArchiveQuery{GalaxyID: scope.Owner, ArchiveSessionID: id})
				if e != nil {
					return nil, e
				}
				session := uploadObject(snapshot)
				if session["host"] == host && session["sessionId"] == sessionID {
					v, e := archive.Flush(operation, id)
					if e != nil {
						return nil, e
					}
					results = append(results, v)
				}
			}
		}
	}
	if e = p.runtime.checkOperation(generation); e != nil {
		return nil, e
	}
	if _, e = uploadChoiceScope(operation, p.runtime.store); e != nil {
		return nil, e
	}
	return map[string]any{"state": "processed", "results": results}, nil
}
