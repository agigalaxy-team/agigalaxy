package qualification

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

// SourceTrace is an internal current-source reader supplied by the owning
// licensed-computation or public-contribution consumer. It does not authenticate
// anyone: each callback must authorize that exact immutable event/reference.
type SourceTrace struct {
	ReadEventWithin    func(string, Object) error
	ReadEvidenceWithin func(Object, Object) error
}

func (c *CalculationContext) sourceTrace() *SourceTrace {
	if c == nil {
		return nil
	}
	return &SourceTrace{ReadEventWithin: c.ReadEventWithin}
}
func (s *Service) ParticipationSourceWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id, subject string, policy Object, trace *SourceTrace) (Object, error) {
	if s.Assistance == nil || trace != nil && trace.ReadEventWithin == nil {
		return nil, fail("qualification_source_reader_unavailable", 503)
	}
	return s.participationWithin(ctx, tx, a, id, subject, policy, trace)
}
