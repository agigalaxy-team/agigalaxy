package operationsstrategies

import (
	"context"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

// WithAuthority retains the actual strategy runtime while the operation-card
// consumer supplies its purpose-bound human authority.
func (s *Service) WithAuthority(authority p.Authority) *Service {
	return &Service{Pool: s.Pool, Endpoint: s.Endpoint, Authority: authority, Duty: s.Duty, StoredAuthority: s.StoredAuthority, RequireExecutionWithin: s.RequireExecutionWithin, Autonomy: s.Autonomy, Effects: s.Effects, Executor: s.Executor, Native: s.Native, Now: s.Now, ActionReady: s.ActionReady, PreviewObjectWithin: s.PreviewObjectWithin}
}
func (s *Service) acceptsPreparation(a Actor) bool {
	authority := s.Authority
	if combined, ok := authority.(*p.BusinessAuthority); ok {
		authority = combined.Human
	}
	marker, ok := authority.(interface{ AcceptsPreparation(Actor) bool })
	return ok && marker.AcceptsPreparation(a)
}

// InspectOrdinaryWithin reads the same current authorized head, version and
// strategy as PrepareOrdinary inside the caller's existing transaction.
func (s *Service) InspectOrdinaryWithin(ctx context.Context, tx pgx.Tx, a Actor, id string) (Actor, Object, Object, Object, error) {
	return s.ordinaryInspect(ctx, tx, a, id)
}

// WithAuthorize carries the original authorize({db}) callback into the exact
// owning transaction instead of acquiring a second pool connection.
func (s *Service) WithAuthorize(authority p.Authority, fresh func(context.Context, pgx.Tx) (Actor, error)) *Service {
	reader := s.WithAuthority(authority)
	if fresh != nil {
		reader.authorizeWithin = func(ctx context.Context, tx pgx.Tx, _ Actor) (Actor, error) { return fresh(ctx, tx) }
	}
	return reader
}
