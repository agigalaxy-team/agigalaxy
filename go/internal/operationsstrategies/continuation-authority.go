package operationsstrategies

import "context"

// continuationAuthority projects preparation eligibility only when the owning
// authority recognizes the real prepare-purpose proof. It never authorizes a
// continuation write, which retains its own strategies.run verification.
func (s *Service) continuationAuthority(ctx context.Context, actor Actor) (Actor, error) {
	if !s.acceptsPreparation(actor) {
		return s.current(ctx, actor, "strategies.run")
	}
	current, err := s.current(ctx, actor, "strategies.read")
	if err != nil {
		return Actor{}, err
	}
	if !has(current.Permissions, "strategies.run") {
		return Actor{}, fail("operations_permission_denied", 403)
	}
	return current, nil
}
