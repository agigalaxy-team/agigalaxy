package operationsresources

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// QualifyActionResourceWithin retains the original prepared-action source
// qualification. The caller separately owns current operations authority.
func (s *Service) QualifyActionResourceWithin(ctx context.Context, tx pgx.Tx, kind, id string) error {
	r, e := s.row(ctx, tx, kind, id, false)
	if e != nil {
		return e
	}
	v, e := s.source(ctx, tx, kind, r)
	if e != nil {
		return e
	}
	if str(v, "state") != "available" {
		return fail("operations_source_unavailable", 409)
	}
	return nil
}
