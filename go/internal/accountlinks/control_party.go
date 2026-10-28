package accountlinks

import (
	"context"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// ResolveControlPartyWithin is the original trusted room-membership projection.
// The caller must authorize the room and lock its current membership snapshot
// first. This mapping supplies a relationship identity, never an API grant.
func (s *Service) ResolveControlPartyWithin(ctx context.Context, tx pgx.Tx, subjectOrAccountRef string) (string, error) {
	if strings.HasPrefix(subjectOrAccountRef, "account:") {
		return subjectOrAccountRef, nil
	}
	if s == nil || s.Endpoint == "" || subjectOrAccountRef == "" {
		return "", fault.New("chat_control_relationship_unavailable", 503)
	}
	rows, e := s.availableSubjectWithin(ctx, tx, subjectOrAccountRef)
	if e != nil {
		return "", e
	}
	if len(rows) == 0 {
		return "subject:" + subjectOrAccountRef, nil
	}
	if len(rows) > 1 {
		return "", fault.New("account_selection_required", 409)
	}
	return "account:" + rows[0]["id"].(string), nil
}
