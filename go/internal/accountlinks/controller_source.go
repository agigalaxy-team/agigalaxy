package accountlinks

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// ResolveControllerAccountWithin is the original trusted source-author
// independence lookup. The caller already checked the real source grants; no
// caller identity, account selection, content read or write is granted here.
func (s *Service) ResolveControllerAccountWithin(ctx context.Context, tx pgx.Tx, subjectID string) (Object, error) {
	if s == nil || s.Endpoint == "" || subjectID == "" {
		return nil, fault.New("account_authority_unavailable", 503)
	}
	rows, e := s.availableSubjectWithin(ctx, tx, subjectID)
	if e != nil {
		return nil, e
	}
	return selectWithin(ctx, tx, rows, "", false)
}
