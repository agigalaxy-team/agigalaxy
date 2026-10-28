package operationspermissions

import (
	"context"
	"github.com/jackc/pgx/v5"
	"net/http"
)

// PreparationReader retains the private prepare-purpose human×fixed-AI proof
// while an actual owning domain validates its selected operation card.
func (s *Service) PreparationReader() Authority { return &preparationReader{service: s} }

type preparationReader struct{ service *Service }

func (p *preparationReader) AcceptsPreparation(a Actor) bool {
	if p == nil || p.service == nil {
		return false
	}
	c, e := p.service.humanContext(a)
	return e == nil && c.purpose == "prepare"
}
func (p *preparationReader) RequireWithin(ctx context.Context, tx pgx.Tx, a Actor, action string) (Actor, error) {
	if !p.AcceptsPreparation(a) {
		return Actor{}, fail("operations_agentos_scope_denied", 403)
	}
	return p.service.requireHumanAI(ctx, tx, a, action)
}
func (p *preparationReader) EffectiveWithin(ctx context.Context, tx pgx.Tx, a Actor) (Actor, error) {
	return p.RequireWithin(ctx, tx, a, "workbench.read")
}
func (p *preparationReader) PersonWithin(context.Context, pgx.Tx, string, bool) (Actor, error) {
	return Actor{}, fail("operations_permission_denied", 403)
}
func (p *preparationReader) AuthorizeOperations(*http.Request, bool, string) (Actor, error) {
	return Actor{}, fail("operations_permission_denied", 403)
}
