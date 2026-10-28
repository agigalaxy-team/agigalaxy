package agentos

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

// QueryRead reuses the same current metadata source with the query owner's
// human/AI intersection. The original HTTP reader keeps its own authority.
func (s *RunOverview) QueryRead(ctx context.Context, actor operationspermissions.Actor, authority operationspermissions.Authority, view, id string, input Object) (Object, error) {
	if s == nil {
		return nil, fail("operations_agentos_not_configured", 503)
	}
	reader := *s
	reader.Human = authority
	if id != "" {
		return reader.RunDetail(ctx, actor, id)
	}
	if view == "list" {
		return reader.Runs(ctx, actor, input)
	}
	return nil, fail("invalid_operations_agentos_query", 400)
}
