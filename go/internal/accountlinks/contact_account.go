package accountlinks

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// ResolveContactAccountWithin projects an already authorized contact party. The
// caller must verify both current private contact grants in this transaction.
// It does not authenticate the subject or grant access to their account.
func (s *Service) ResolveContactAccountWithin(ctx context.Context, tx pgx.Tx, subjectID string, lock bool) (Object, error) {
	if s == nil || s.Endpoint == "" || subjectID == "" {
		return nil, fault.New("account_authority_unavailable", 503)
	}
	rows, err := s.availableSubjectWithin(ctx, tx, subjectID)
	if err != nil {
		return nil, err
	}
	return selectWithin(ctx, tx, rows, "", lock)
}
