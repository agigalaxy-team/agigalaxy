package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type nativeIdentityLease struct {
	runtime    *Runtime
	scope      ChoiceScope
	connection connectionLease
	generation uint64
}

func (r *Runtime) identityLease(ctx context.Context, session bool) (context.Context, func(), *nativeIdentityLease, error) {
	if session {
		selected, e := r.connection.selection(ctx)
		if e != nil {
			return nil, nil, nil, e
		}
		r.syncStopped(selected)
	}
	operation, cancel, generation, e := r.operation(ctx, session)
	if e != nil {
		return nil, nil, nil, e
	}
	fail := func(e error) (context.Context, func(), *nativeIdentityLease, error) {
		cancel()
		return nil, nil, nil, e
	}
	scope, e := r.store.ChoiceScope(operation)
	if e != nil {
		return fail(e)
	}
	if session {
		if _, e = r.Restore(operation); e != nil {
			return fail(e)
		}
	}
	connection, e := r.connection.lease(operation, session)
	if e != nil {
		return fail(e)
	}
	if connection.selection.Active == nil || connection.selection.Active.SubjectID != scope.Owner || connection.selection.Active.DeviceID != scope.DeviceID {
		return fail(connectionFailure("device_management_identity_required"))
	}
	lease := &nativeIdentityLease{r, scope, connection, generation}
	if e = lease.check(operation); e != nil {
		return fail(e)
	}
	return operation, cancel, lease, nil
}
func (l *nativeIdentityLease) readAny(ctx context.Context, key string) (any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var value any
	e := l.runtime.store.With(ctx, false, func(dir string) error {
		if e := l.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		_, e := readJSON(connectionRecordPath(dir, key), &value)
		return e
	})
	if e != nil {
		return nil, e
	}
	return value, l.check(ctx)
}
func (l *nativeIdentityLease) updateAny(ctx context.Context, key string, change func(any) (any, error)) error {
	if e := l.check(ctx); e != nil {
		return e
	}
	e := l.runtime.store.With(ctx, true, func(dir string) error {
		if e := l.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		var old any
		if _, e := readJSON(connectionRecordPath(dir, key), &old); e != nil {
			return e
		}
		next, e := change(old)
		if e != nil {
			return e
		}
		return uploadNativeRecordWithin(dir, key, next)
	})
	if e != nil {
		return e
	}
	return l.check(ctx)
}
func (l *nativeIdentityLease) check(ctx context.Context) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	if e := l.runtime.checkOperation(l.generation); e != nil {
		return e
	}
	if e := l.runtime.connection.check(ctx, l.connection); e != nil {
		return e
	}
	snapshot, e := l.runtime.connection.Snapshot(ctx)
	if e != nil {
		return e
	}
	binding := ""
	if snapshot != nil {
		binding = snapshot.BindingID
	}
	if binding != l.connection.bindingID {
		return connectionFailure("device_management_native_connection_changed")
	}
	scope, e := l.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return e
	}
	if scope != l.scope {
		return connectionFailure("native_choice_binding_changed")
	}
	return nil
}
func (l *nativeIdentityLease) call(ctx context.Context, path string, input any, public bool) (map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	method := "POST"
	if input == nil {
		method = "GET"
	}
	value, e := l.runtime.Call(ctx, path, input, ConnectionCallOptions{Method: method, Unauthenticated: public, ExpectedScope: &l.scope})
	if check := l.check(ctx); check != nil {
		return nil, check
	}
	return value, e
}
func (l *nativeIdentityLease) read(ctx context.Context, key string) (map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var value map[string]any
	e := l.runtime.store.With(ctx, false, func(dir string) error {
		if e := l.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		_, e := readJSON(connectionRecordPath(dir, key), &value)
		return e
	})
	if e != nil {
		return nil, e
	}
	return value, l.check(ctx)
}
func (l *nativeIdentityLease) update(ctx context.Context, key string, change func(map[string]any) (map[string]any, error)) error {
	if e := l.check(ctx); e != nil {
		return e
	}
	e := l.runtime.store.With(ctx, true, func(dir string) error {
		if e := l.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		var old map[string]any
		if _, e := readJSON(connectionRecordPath(dir, key), &old); e != nil {
			return e
		}
		next, e := change(old)
		if e != nil {
			return e
		}
		return uploadNativeRecordWithin(dir, key, next)
	})
	if e != nil {
		return e
	}
	return l.check(ctx)
}
func (l *nativeIdentityLease) control(ctx context.Context) (map[string]any, error) {
	value, e := l.call(ctx, "/v2/identity/"+l.scope.Owner+"/control", nil, true)
	if e != nil {
		return nil, e
	}
	if _, e = l.runtime.connection.rememberControl(ctx, l.connection, value); e != nil {
		return nil, e
	}
	return value, l.check(ctx)
}
func (l *nativeIdentityLease) sign(ctx context.Context, raw, kind string) (string, error) {
	if e := l.check(ctx); e != nil {
		return "", e
	}
	signed, e := l.runtime.connection.sign(ctx, l.connection, raw, kind)
	if e != nil {
		return "", e
	}
	return signed, l.check(ctx)
}
func identityClone(value any) map[string]any {
	raw, _ := protocol.Encode(value)
	out, _ := connectionObject(raw)
	return out
}
