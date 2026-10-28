package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/jackc/pgx/v5"
)

func (f *AttachmentService) authorPending(ctx context.Context, tx pgx.Tx, r Object) (bool, error) {
	if str(r, "subject_id") == "" {
		return false, nil
	}
	var pending bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))", r["subject_id"]).Scan(&pending)
	return pending, e
}

// This exact permission-only consumer is used by the original operator
// restoration check, which never impersonates the file author or a viewer.
func (s *Service) AttachmentPermissionWithin(ctx context.Context, tx pgx.Tx, id, hash, action, objectID string) (bool, error) {
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1", id)
	if e != nil {
		return false, e
	}
	if p == nil {
		return false, nil
	}
	current := *s
	current.actor = nil
	current.Authority = nil
	state, e := current.permissionDetailWithin(ctx, tx, p, "", true, true, &permissionSelector{PayloadHash: hash, Action: action, ObjectID: objectID, SkipAudience: true})
	if e != nil {
		return false, e
	}
	return len(state.Detail["stoppedReasons"].([]string)) == 0, nil
}
func (f *AttachmentService) GovernanceAdapter() *filegovernance.FileAdapter {
	return &filegovernance.FileAdapter{Store: f.Store, Policy: f.policy(), Available: func() bool { return f.configured() == nil }, AuthorPending: f.authorPending, ForumPermission: f.Forum.AttachmentPermissionWithin}
}
