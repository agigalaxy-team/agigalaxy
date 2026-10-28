package summaries

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

// GetLifecycleWithin keeps the original export transaction and current source
// filtering. It creates neither a replacement Actor nor an independent read.
func (s *Service) GetLifecycleWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
	return s.getWithin(ctx, tx, a, id)
}
