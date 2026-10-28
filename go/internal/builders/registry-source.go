package builders

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// RegistrySource is a current authorized view within the caller's transaction.
// It carries no independent authorization after those source locks are released.
type RegistrySource struct {
	Parent, DeclarationEvent, Declaration, Maintenance Object
	Grant                                              deviceauth.ConsentIntent
}

func (s *Service) RegistryWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (RegistrySource, error) {
	b, e := s.load(ctx, tx, id, false)
	if e != nil {
		return RegistrySource{}, e
	}
	d, g, e := s.current(ctx, tx, a, b)
	if e != nil {
		return RegistrySource{}, e
	}
	return RegistrySource{b.parent, b.declaration, d, maintenance(b.rows), g}, nil
}
func (s *Service) ManagementWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
	return s.managementWithin(ctx, tx, a, id)
}
func (s *Service) EventPermittedWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, row Object) (bool, error) {
	return s.permitted(ctx, tx, a, row)
}

// RegistryAttestationWithin checks the original declaration's current grant
// without granting its contents to a foreign reader. The explicit Hub agreement
// consumer uses this solely as a current operator scope condition.
func (s *Service) RegistryAttestationWithin(ctx context.Context, tx pgx.Tx, id string) (RegistrySource, error) {
	b, e := s.load(ctx, tx, id, false)
	if e != nil {
		return RegistrySource{}, e
	}
	g, e := s.grant(ctx, tx, b.declaration, false)
	if e != nil {
		return RegistrySource{}, e
	}
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
		return RegistrySource{}, fault.New("builder_unavailable", 404)
	}
	return RegistrySource{b.parent, b.declaration, obj(event(b.declaration)["declaration"]), maintenance(b.rows), g}, nil
}
