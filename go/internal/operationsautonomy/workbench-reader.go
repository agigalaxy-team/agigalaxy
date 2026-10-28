package operationsautonomy

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// ReadWorkbenchTaskWithin uses the original dry-run binding check and DTO. It
// retains every current owner, fixed-AI, task and source-boundary check without
// updating the task or inserting a workbench run.
func (s *Service) ReadWorkbenchTaskWithin(ctx context.Context, tx pgx.Tx, in WorkbenchBind) (Object, error) {
	in.DryRun = true
	return s.BindWorkbenchTaskWithin(ctx, tx, in)
}
