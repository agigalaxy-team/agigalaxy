package evidence

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// CurrentSourceObservationWithin exposes only the existing source currentness
// result for the original search index consumer. The caller first locks its
// search source and supplies the real restricted Consent/Case readers.
// This method neither verifies a published proof signature nor publishes one.
func (s *ProofService) CurrentSourceObservationWithin(ctx context.Context, tx pgx.Tx, evidenceID, subject string) (string, error) {
	observation, _, e := s.sourceWithLock(ctx, tx, evidenceID, subject, true)
	if e != nil {
		return "", e
	}
	return observation.ID, nil
}
