package operationsstrategies

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// ValidateRehearsalSamples checks only the ownership and current eligibility of
// supplied execution samples. Rehearsal still performs its full source and
// consumer qualification again after confirmation.
func (s *Service) ValidateRehearsalSamples(ctx context.Context, actor Actor, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	validator, ok := s.Effects.(interface {
		ValidateRehearsalSampleWithin(context.Context, pgx.Tx, string, string) error
	})
	if !ok || validator == nil {
		return fail("p13_effects_not_configured", 503)
	}
	_, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		fresh, err := s.actor(ctx, tx, actor, "strategies.read", nil)
		if err != nil {
			return false, err
		}
		for _, id := range ids {
			if err = validator.ValidateRehearsalSampleWithin(ctx, tx, id, fresh.ID); err != nil {
				return false, err
			}
		}
		_, err = s.actor(ctx, tx, actor, "strategies.read", nil)
		return err == nil, err
	})
	return err
}
