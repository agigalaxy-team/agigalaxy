package native

import "context"

// ConnectService performs the selected identity's existing device handshake.
// It is an explicit connection action, never called by status or public reads.
func (r *Runtime) ConnectService(ctx context.Context) (*ConnectionSnapshot, error) {
	status, err := r.Status(ctx, RuntimeStatusOptions{SkipAccount: true})
	if err != nil {
		return nil, err
	}
	if status["connected"] == true {
		return r.connection.Snapshot(ctx)
	}
	selected, err := r.connection.selection(ctx)
	if err != nil {
		return nil, err
	}
	if selected.Permission != nil && selected.Permission.Enabled {
		// A saved selection must be restored as-is; do not replace its scopes or
		// fall back to a new connection operation if restoration fails.
		return r.Restore(ctx)
	}
	plan, err := r.PrepareConnect(ctx)
	if err != nil {
		return nil, err
	}
	scope, err := r.store.ChoiceScope(ctx)
	if err != nil {
		return nil, err
	}
	return r.ConnectReviewed(ctx, plan, &scope)
}
