package maintenance

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"net/http"
)

type NativeClient struct {
	Client    *Client
	Transport func(context.Context, Object) (Object, error)
}

func (n *NativeClient) Call(ctx context.Context, input Object) (Object, error) {
	value, e := ParseNativeCommand(input)
	if e != nil {
		return nil, e
	}
	if n.Transport != nil {
		return n.Transport(ctx, value)
	}
	if n.Client == nil {
		return nil, failure("maintenance_native_not_configured", 503)
	}
	raw, e := protocol.EncodeJS(value)
	if e != nil {
		return nil, e
	}
	body, status, e := n.Client.call(ctx, "/v1/maintenance", raw, 4194304, 15_000_000_000)
	if e != nil {
		return nil, e
	}
	var out Object
	if json.Unmarshal(body, &out) != nil {
		return nil, unavailable()
	}
	if status != 200 {
		code := str(out["error"])
		if !includes([]string{"maintenance_native_busy", "maintenance_plan_changed", "maintenance_production_adapter_unavailable", "maintenance_capture_coverage_incomplete"}, code) {
			code = "maintenance_native_unavailable"
		}
		if status != 409 {
			status = 503
		}
		return nil, failure(code, status)
	}
	return out, nil
}
func (n *NativeClient) VerifyService(r *http.Request) (*VerifiedService, error) {
	if n == nil || n.Client == nil {
		return nil, failure("maintenance_native_not_configured", 503)
	}
	return n.Client.VerifyService(r)
}
func (n *NativeClient) VerifyBody(context *VerifiedService, raw []byte) error {
	if n == nil || n.Client == nil {
		return failure("maintenance_service_denied", 401)
	}
	return n.Client.VerifyBody(context, raw)
}
