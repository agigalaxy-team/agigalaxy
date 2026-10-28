package operationsrules

import (
	"context"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

// WithAuthority keeps the policy source and clock while preserving the
// operation card's private purpose-bound human proof.
func (s *Service) WithAuthority(authority p.Authority) *Service {
	return &Service{Pool: s.Pool, Endpoint: s.Endpoint, Authority: authority, Now: s.Now}
}
func (s *Service) acceptsPreparation(a Actor) bool {
	authority := s.Authority
	if combined, ok := authority.(*p.BusinessAuthority); ok {
		authority = combined.Human
	}
	marker, ok := authority.(interface{ AcceptsPreparation(Actor) bool })
	return ok && marker.AcceptsPreparation(a)
}

func (s *Service) WithAuthorize(authority p.Authority, fresh func(context.Context, pgx.Tx) (Actor, error)) *Service {
	reader := s.WithAuthority(authority)
	if fresh != nil {
		reader.authorizeWithin = func(ctx context.Context, tx pgx.Tx, _ Actor) (Actor, error) { return fresh(ctx, tx) }
	}
	return reader
}
func ParsePublishCommand(input Object) (Object, error) { return parseCommand("publish", input) }
func (s *Service) CommandRecordWithin(ctx context.Context, tx pgx.Tx, operationID string) (Object, error) {
	return one(ctx, tx, `SELECT to_jsonb(c) FROM (SELECT operator_id,policy_key,kind,input FROM operations_p14_rule_commands_v1 WHERE endpoint=$1 AND operation_id=$2)c`, s.Endpoint, operationID)
}
