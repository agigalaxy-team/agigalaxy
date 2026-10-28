package native

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

// Runtime composes existing local storage and the pinned connection. It does not
// initialize an identity, start synchronization or execute a host model.
type Runtime struct {
	store             *Store
	config            Configuration
	connection        *Connection
	mu                sync.Mutex
	connectMu         sync.Mutex
	connecting        bool
	closed, stopped   bool
	stopFingerprint   string
	generation        uint64
	lifecycle         context.Context
	cancel            context.CancelFunc
	notifications     RuntimeNotificationDisabler
	privateSync       *PrivateSync
	personalSummaries *NativePersonalSummaries
	nativeWatch       *NativeWatchRuntime
	nativeHelp        *NativeHelp
	navigation        *NativeNavigation
	deviceHandoff     *NativeDeviceHandoff
}

func NewRuntime(store *Store, configuration Configuration, options ConnectionOptions) (*Runtime, error) {
	connection, e := NewConnection(store, configuration, options)
	if e != nil {
		return nil, e
	}
	lifecycle, cancel := context.WithCancel(context.Background())
	runtime := &Runtime{store: store, config: configuration, connection: connection, lifecycle: lifecycle, cancel: cancel}
	runtime.privateSync = NewPrivateSync(runtime)
	runtime.personalSummaries = NewNativePersonalSummaries(runtime)
	runtime.nativeHelp = NewNativeHelp(runtime)
	runtime.navigation = NewNativeNavigation(runtime, NavigationOptions{})
	runtime.deviceHandoff = NewNativeDeviceHandoff(runtime)
	return runtime, nil
}
func (r *Runtime) operation(ctx context.Context, ordinary bool) (context.Context, func(), uint64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, nil, 0, connectionFailure("native_runtime_closed")
	}
	if ordinary && r.stopped {
		return nil, nil, 0, connectionFailure("native_connection_choice_required")
	}
	if ordinary && r.connecting {
		return nil, nil, 0, connectionFailure("native_connection_in_progress")
	}
	operation, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(r.lifecycle, cancel)
	return operation, func() { stop(); cancel() }, r.generation, nil
}
func (r *Runtime) checkOperation(generation uint64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return connectionFailure("native_runtime_closed")
	}
	if generation != r.generation {
		return connectionFailure("native_connection_selection_changed")
	}
	return nil
}
func (r *Runtime) rotateLocked() {
	r.cancel()
	r.generation++
	r.lifecycle, r.cancel = context.WithCancel(context.Background())
}
func (r *Runtime) syncStopped(selected connectionSelection) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped && r.stopFingerprint != "" && r.stopFingerprint != selected.fingerprint {
		r.stopped = false
		r.stopFingerprint = ""
	}
}
func (r *Runtime) Restore(ctx context.Context) (*ConnectionSnapshot, error) {
	selected, e := r.connection.selection(ctx)
	if e != nil {
		return nil, e
	}
	r.syncStopped(selected)
	operation, cancel, generation, e := r.operation(ctx, true)
	if e != nil {
		return nil, e
	}
	defer cancel()
	snapshot, requestError := r.connection.Restore(operation)
	if e = r.checkOperation(generation); e != nil {
		return nil, e
	}
	return snapshot, requestError
}
func (r *Runtime) Call(ctx context.Context, path string, input any, options ConnectionCallOptions) (map[string]any, error) {
	responseTarget := options.ResponseJSON
	var responseJSON json.RawMessage
	if responseTarget != nil {
		*responseTarget = nil
		options.ResponseJSON = &responseJSON
	}
	selected, e := r.connection.selection(ctx)
	if e != nil {
		return nil, e
	}
	r.syncStopped(selected)
	operation, cancel, generation, e := r.operation(ctx, !options.Unauthenticated)
	if e != nil {
		return nil, e
	}
	defer cancel()
	result, requestError := r.connection.Call(operation, path, input, options)
	if e = r.checkOperation(generation); e != nil {
		return nil, e
	}
	if requestError == nil && responseTarget != nil {
		*responseTarget = responseJSON
	}
	return result, requestError
}
func (r *Runtime) QueryReceipt(ctx context.Context, operation ReceiptOperation) (map[string]any, error) {
	request, cancel, generation, e := r.operation(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	result, requestError := r.connection.QueryReceipt(request, operation)
	if e = r.checkOperation(generation); e != nil {
		return nil, connectionFailure("receipt_status_authority_changed")
	}
	return result, requestError
}
func (r *Runtime) Close() {
	r.mu.Lock()
	if !r.closed {
		r.closed = true
		r.cancel()
		r.generation++
	}
	notificationAdapter := r.notifications
	watchAdapter := r.nativeWatch
	helpAdapter := r.nativeHelp
	r.mu.Unlock()
	if r.privateSync != nil {
		r.privateSync.Close()
	}
	if r.personalSummaries != nil {
		r.personalSummaries.Close()
	}
	if live, ok := notificationAdapter.(interface{ Close() }); ok {
		live.Close()
	}
	if watchAdapter != nil {
		watchAdapter.Close()
	}
	if helpAdapter != nil {
		helpAdapter.Close()
	}
	r.connection.Close()
}
func runtimeErrorCode(e error) string {
	code := fault.Code(e)
	if code == "internal_error" {
		return "native_connection_unavailable"
	}
	return code
}
