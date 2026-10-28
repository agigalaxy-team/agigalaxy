package operationsstrategies

import (
	"context"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

// QueryRead shares the running strategy sources with the true query-purpose
// authority. The closed view port cannot execute a strategy or mint an actor.
func (s *Service) QueryRead(ctx context.Context, a Actor, authority p.Authority, view, id string, input Object) (Object, error) {
	reader := &Service{Pool: s.Pool, Endpoint: s.Endpoint, Authority: authority, Duty: s.Duty, StoredAuthority: s.StoredAuthority, RequireExecutionWithin: s.RequireExecutionWithin, Autonomy: s.Autonomy, Effects: s.Effects, Executor: s.Executor, Native: s.Native, Now: s.Now, ActionReady: s.ActionReady, PreviewObjectWithin: s.PreviewObjectWithin}
	switch view {
	case "overview":
		out, e := reader.Get(ctx, a)
		if e != nil {
			return nil, e
		}
		parsed, e := ParseConfiguration(obj(out["configuration"]))
		if e != nil {
			out["configuration"] = nil
		} else {
			out["configuration"] = parsed
		}
		return out, nil
	case "versions":
		return reader.Versions(ctx, a, input)
	case "records":
		return reader.Records(ctx, a, input)
	case "strategy-run":
		return reader.RunDetail(ctx, a, id)
	}
	return nil, invalid()
}
