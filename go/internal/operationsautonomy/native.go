package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type Native interface {
	Run(context.Context, Object) (Object, error)
	Read(context.Context, Object) (Object, error)
	Cancel(context.Context, Object) (Object, error)
	Continue(context.Context, Object) (Object, error)
}
type TaskTransport interface {
	AutonomyRequest(context.Context, string, string, string, *int64, string, bool) (Object, error)
}

// NativeClient consumes the existing AgentOS client's loaded task transport;
// it does not load a second key, service credential or model configuration.
type NativeClient struct{ Client TaskTransport }

func (n *NativeClient) request(ctx context.Context, row Object, suffix string, write bool) (Object, error) {
	if n == nil || n.Client == nil {
		return nil, fault.New("operations_agentos_not_configured", 503)
	}
	var delegation *int64
	if row["delegation_version"] != nil {
		v := num(row["delegation_version"])
		delegation = &v
	}
	return n.Client.AutonomyRequest(ctx, str(row["id"]), str(row["config_id"]), str(row["ai_account_id"]), delegation, suffix, write)
}
func (n *NativeClient) Run(ctx context.Context, row Object) (Object, error) {
	return n.request(ctx, row, "/runs", true)
}
func (n *NativeClient) Read(ctx context.Context, row Object) (Object, error) {
	return n.request(ctx, row, "", false)
}
func (n *NativeClient) Cancel(ctx context.Context, row Object) (Object, error) {
	return n.request(ctx, row, "/cancel", true)
}
func (n *NativeClient) Continue(ctx context.Context, row Object) (Object, error) {
	return n.request(ctx, row, "/continue", true)
}
