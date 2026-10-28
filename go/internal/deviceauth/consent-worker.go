package deviceauth

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// RequireWorkerConsentWithin uses the existing narrow Worker definer function.
// All grant hash/disclosure/deletion visibility checks share the API reader;
// no table UPDATE grant or browser/device authority is added to the Worker.
func (s *Service) RequireWorkerConsentWithin(ctx context.Context, tx pgx.Tx, r ConsentRequirement) (ConsentIntent, error) {
	return s.requireConsentRead(ctx, tx, r, "SELECT intent FROM public.galaxy_worker_lock_consent($1,$2,$3)")
}
