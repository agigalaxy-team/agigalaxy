package operationspermissions

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// TaskOwnerWithin checks the person asking an AI to do work. It does not give
// the AI the person's business permissions. Execution uses the target's role.
// The only writer is the human-confirmed workbench card, never a duty tool.
func (s *Service) TaskOwnerWithin(ctx context.Context, tx pgx.Tx, a Actor, domain string) (Actor, error) {
	scoped, err := s.HumanAIWithin(ctx, tx, a, domain, "prepare", "workbench.read")
	if err != nil {
		return Actor{}, err
	}
	if _, err = s.humanContext(scoped); err != nil {
		return Actor{}, err
	}
	// This returns the authenticated task owner only for dispatch preparation
	// and the separately human-confirmed control-plane operation.
	scoped.AIProof = nil
	return s.require(ctx, tx, scoped, "autonomy.control")
}
