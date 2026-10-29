package operationsqueries

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// preparationReadContext provides the same current human and fixed AI's
// preparation projection only for an owning service's authorized read. It
// never prepares or executes a command, and never converts a Duty actor.
func (s *Service) preparationReadContext(ctx context.Context, a Actor, domain, readAction string) (Actor, operationspermissions.Authority, bool, error) {
	if duty := s.Permissions.Duty; duty != nil && duty.AcceptsDuty(a) {
		return a, s.reader(a), false, nil
	}
	prepared, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) {
		return s.Permissions.HumanAIReadWithin(ctx, tx, a, domain, "prepare", readAction)
	})
	if err != nil {
		return a, nil, false, err
	}
	return prepared, s.Permissions.PreparationReader(), true, nil
}
