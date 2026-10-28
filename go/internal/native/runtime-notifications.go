package native

import "context"

// RuntimeNotificationDisabler is the existing live host adapter's disable
// operation: stop polling/permission requests, withdraw owned prompts, and save
// its original selected lease's disabled choice. It must return real failures.
// The adapter remains responsible for its own process/channel Close lifecycle.
type RuntimeNotificationDisabler interface{ Disable(context.Context) error }

// AttachNotifications is composition-only, never a model tool or an opt-in.
// Configuring a channel does not imply an instance or activation. A fresh Go
// runtime starts none; without a live adapter, disable follows the original
// current==nil branch and does not modify old journals or claim OS withdrawal.
func (r *Runtime) AttachNotifications(adapter RuntimeNotificationDisabler) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return connectionFailure("native_runtime_closed")
	}
	if adapter == nil {
		return connectionFailure("notification_runtime_configuration_invalid")
	}
	if r.notifications != nil {
		return connectionFailure("notification_runtime_already_attached")
	}
	r.notifications = adapter
	return nil
}
func (r *Runtime) disableNotifications(ctx context.Context) error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return connectionFailure("native_runtime_closed")
	}
	adapter := r.notifications
	r.mu.Unlock()
	if adapter == nil {
		return nil
	}
	return adapter.Disable(ctx)
}
