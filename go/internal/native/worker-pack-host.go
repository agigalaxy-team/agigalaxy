package native

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type NativeWorkerHost struct {
	runtime   *Runtime
	a2a       *NativeA2a
	workers   []map[string]any
	now       func() time.Time
	gate      chan struct{}
	mu        sync.Mutex
	closed    bool
	active    sync.WaitGroup
	lifecycle context.Context
	cancel    context.CancelFunc
	previews  map[string]*WorkerPreview
	preparing int
}
type WorkerPreview struct {
	host                       *NativeWorkerHost
	lease                      *nativeIdentityLease
	kind                       string
	row                        map[string]any
	inner                      *A2aPreview
	value                      map[string]any
	operation                  map[string]any
	used                       bool
	handle, previewHash, state string
	expiresAt                  int64
	reviewData, result         map[string]any
}

func NewNativeWorkerHost(runtime *Runtime, rawConfiguration, rawA2aConfiguration []byte, options A2aOptions) (*NativeWorkerHost, error) {
	if runtime == nil {
		return nil, a2aError("Worker Native runtime required")
	}
	var schema, value map[string]any
	if protocol.Decode([]byte(workerPackConfigurationJSON), &schema) != nil || json.Unmarshal(rawConfiguration, &value) != nil || remoteChatValidate(schema, value) != nil {
		return nil, a2aError("invalid configured Workers")
	}
	a2a, e := NewNativeA2a(runtime, rawA2aConfiguration, options)
	if e != nil {
		return nil, e
	}
	workers := []map[string]any{}
	seen := map[string]bool{}
	for _, raw := range uploadRows(value["workers"]) {
		worker := uploadObject(raw)
		id := text(worker["id"])
		if seen[id] {
			return nil, a2aError("unique configured Worker IDs required")
		}
		seen[id] = true
		found := false
		for _, p := range a2a.peers {
			found = found || p.id == worker["peerId"]
		}
		if !found {
			return nil, a2aError("configured Worker peer required")
		}
		workers = append(workers, worker)
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	lifecycle, cancel := context.WithCancel(context.Background())
	return &NativeWorkerHost{runtime: runtime, a2a: a2a, workers: workers, now: options.Now, gate: make(chan struct{}, 1), lifecycle: lifecycle, cancel: cancel, previews: map[string]*WorkerPreview{}}, nil
}
func (h *NativeWorkerHost) Close() {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	h.cancel()
	h.mu.Unlock()
	h.a2a.Close()
	h.active.Wait()
	h.mu.Lock()
	h.previews = map[string]*WorkerPreview{}
	h.mu.Unlock()
}
func (h *NativeWorkerHost) Workers() []any {
	out := []any{}
	for _, worker := range h.workers {
		out = append(out, identityClone(worker))
	}
	return out
}
func (h *NativeWorkerHost) enter(ctx context.Context) (context.Context, *nativeIdentityLease, func(), error) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, nil, nil, a2aError("Worker host closed")
	}
	h.active.Add(1)
	h.mu.Unlock()
	operation, cancel, _, e := h.runtime.operation(ctx, true)
	if e != nil {
		h.active.Done()
		return nil, nil, nil, e
	}
	stop := context.AfterFunc(h.lifecycle, cancel)
	op, leaseCancel, l, e := h.runtime.identityLease(operation, false)
	if e != nil {
		stop()
		cancel()
		h.active.Done()
		return nil, nil, nil, e
	}
	done := func() { <-h.gate; leaseCancel(); stop(); cancel(); h.active.Done() }
	select {
	case h.gate <- struct{}{}:
	case <-op.Done():
		leaseCancel()
		stop()
		cancel()
		h.active.Done()
		return nil, nil, nil, op.Err()
	}
	if l.connection.bindingID == "" {
		done()
		return nil, nil, nil, a2aError("current Worker host connection required")
	}
	if e = l.check(op); e != nil {
		done()
		return nil, nil, nil, e
	}
	return op, l, done, nil
}
func workerPrefix(l *nativeIdentityLease) string {
	return "native-worker-pack:" + l.runtime.config.Endpoint + ":" + l.scope.Owner + ":"
}
func workerStateKey(l *nativeIdentityLease) string {
	return workerPrefix(l) + "worker-pack-host-v2:" + l.runtime.config.Endpoint + ":" + l.scope.Owner
}
func workerOperationsKey(l *nativeIdentityLease) string {
	return workerPrefix(l) + "worker-pack-operations:" + l.runtime.config.Endpoint + ":" + l.scope.Owner
}
func workerReadWithin(dir, key string) (any, error) {
	f, e := os.Open(connectionRecordPath(dir, key))
	if errors.Is(e, os.ErrNotExist) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	defer f.Close()
	raw, e := io.ReadAll(io.LimitReader(f, 2*1024*1024+1))
	if e != nil {
		return nil, e
	}
	if len(raw) > 2*1024*1024 {
		return nil, a2aError("Worker journal limit exceeded")
	}
	return protocol.DecodeOrdered(raw)
}
func workerRead(ctx context.Context, l *nativeIdentityLease, key string) (any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var value any
	e := l.runtime.store.With(ctx, false, func(dir string) error {
		if e := l.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		var e error
		value, e = workerReadWithin(dir, key)
		return e
	})
	if e != nil {
		return nil, e
	}
	return value, l.check(ctx)
}
func workerUpdate(ctx context.Context, l *nativeIdentityLease, key string, change func(any) (any, error)) (any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var next any
	e := l.runtime.store.With(ctx, true, func(dir string) error {
		if e := l.runtime.checkOperation(l.generation); e != nil {
			return e
		}
		if e := l.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		previous, e := workerReadWithin(dir, key)
		if e != nil {
			return e
		}
		next, e = change(previous)
		if e != nil {
			return e
		}
		return uploadNativeRecordWithin(dir, key, next)
	})
	if e != nil {
		return nil, e
	}
	return next, l.check(ctx)
}
func workerOrdered(v any) *protocol.OrderedObject { out, _ := v.(*protocol.OrderedObject); return out }
func workerClone(v any) any {
	raw, e := protocol.EncodeJS(v)
	if e != nil {
		return nil
	}
	out, _ := protocol.DecodeOrdered(raw)
	return out
}
func workerState(value any) (*protocol.OrderedObject, *protocol.OrderedObject, error) {
	if value == nil {
		associations := protocol.NewOrderedObject()
		state := protocol.NewOrderedObject()
		state.Set("associations", associations)
		return state, associations, nil
	}
	state := workerOrdered(value)
	associations := workerOrdered(a2aObject(value)["associations"])
	if state == nil || associations == nil {
		return nil, nil, a2aError("invalid original Worker associations")
	}
	return state, associations, nil
}
func workerSelected(ctx context.Context, l *nativeIdentityLease, id string) (map[string]any, error) {
	value, e := workerRead(ctx, l, workerStateKey(l))
	if e != nil {
		return nil, e
	}
	_, rows, e := workerState(value)
	if e != nil {
		return nil, e
	}
	row := a2aObject(rows.Values()[id])
	owner := a2aObject(row["owner"])
	if row["associationId"] != id || owner["subjectId"] != l.scope.Owner || owner["endpoint"] != l.runtime.config.Endpoint {
		return nil, a2aError("original Worker association unavailable for owner")
	}
	return row, nil
}
func workerPutRow(ctx context.Context, l *nativeIdentityLease, row map[string]any, previous map[string]any, newOnly bool) error {
	_, e := workerUpdate(ctx, l, workerStateKey(l), func(value any) (any, error) {
		state, rows, e := workerState(value)
		if e != nil {
			return nil, e
		}
		id := text(row["associationId"])
		old := rows.Values()[id]
		if newOnly && old != nil || previous != nil && !connectionEqual(a2aObject(old), previous) {
			return nil, a2aError("original Worker association changed")
		}
		rows.Set(id, row)
		return state, nil
	})
	return e
}
func (h *NativeWorkerHost) worker(id string) map[string]any {
	for _, worker := range h.workers {
		if worker["id"] == id {
			return worker
		}
	}
	return nil
}
func (h *NativeWorkerHost) manifest(ctx context.Context, l *nativeIdentityLease, worker map[string]any) (map[string]any, error) {
	if worker == nil {
		return nil, a2aError("configured Worker unavailable")
	}
	pack, e := l.call(ctx, "/v2/builders/pack/manifest", worker["pack"], false)
	if e != nil {
		return nil, e
	}
	selected := uploadObject(worker["pack"])
	manifest := uploadObject(pack["manifest"])
	if pack["builderId"] != selected["builderId"] || pack["manifestId"] != selected["manifestId"] || pack["manifestHash"] != selected["manifestHash"] || manifest["sha256"] != worker["sourceHash"] || manifest["version"] != worker["version"] || pack["delisted"] == true || pack["securityIssue"] == true {
		return nil, a2aError("selected Worker Pack version or permission changed")
	}
	return pack, nil
}
