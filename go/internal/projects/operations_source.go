package projects

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// OperationsSourceWithin keeps the original anonymous current-public project
// read, ignoring only the operator visibility layer. It never grants roles,
// archived-object access, expired consent or private source material.
func (s *Service) OperationsSourceWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	return s.readWithin(ctx, tx, "", id, false, true)
}
