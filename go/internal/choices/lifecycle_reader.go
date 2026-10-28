package choices

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

// GetLifecycleWithin reuses the caller's real, currently authorized export
// transaction and the same owner/current-source projection as ordinary reads.
func (s *Service) GetLifecycleWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
	return s.getWithin(ctx, tx, a, id)
}
