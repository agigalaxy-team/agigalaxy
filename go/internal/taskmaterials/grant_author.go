package taskmaterials

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// ReadGrantAuthorWithin is a trusted source-owner read for an independently
// signed exact reproduction license whose binding/control the caller checked.
// It reuses all current Task visibility and material checks, creates no device
// actor and confers no Task operation or HTTP authentication authority.
func (s *Service) ReadGrantAuthorWithin(ctx context.Context, tx pgx.Tx, author, taskID string) (Object, error) {
	if author == "" {
		return nil, fail("not_found", 404)
	}
	return s.readTaskViewerWithin(ctx, tx, author, true, taskID)
}
