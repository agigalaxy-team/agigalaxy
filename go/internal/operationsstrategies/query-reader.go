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
	case "strategy-version":
		if !uuidPattern.MatchString(id) {
			return nil, invalid()
		}
		if _, e := reader.current(ctx, a, "strategies.read"); e != nil {
			return nil, e
		}
		version, e := reader.version(ctx, reader.Pool, id)
		if e != nil {
			return nil, e
		}
		if version == nil {
			return nil, fail("p13_version_not_found", 404)
		}
		creation, e := one(ctx, reader.Pool, `SELECT to_jsonb(c) FROM(SELECT operation_id,input->>'sourceStrategyId' AS source_strategy_id,input->>'sourceVersionId' AS source_version_id,result->>'newStrategyId' AS new_strategy_id FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND kind='ordinary-create-draft' AND result->>'versionId'=$2)c`, reader.Endpoint, id)
		if e != nil {
			return nil, e
		}
		if _, e = reader.current(ctx, a, "strategies.read"); e != nil {
			return nil, e
		}
		view := VersionView(version).(Object)
		if creation != nil {
			view["ordinaryCreation"] = Object{"operationId": creation["operation_id"], "sourceStrategyId": creation["source_strategy_id"], "sourceVersionId": creation["source_version_id"], "newStrategyId": creation["new_strategy_id"]}
		}
		rehearsals, e := reader.VersionRehearsals(ctx, a, id, input)
		if e != nil {
			return nil, e
		}
		return reader.metadata(Object{"version": view, "rehearsals": rehearsals}), nil
	}
	return nil, invalid()
}
