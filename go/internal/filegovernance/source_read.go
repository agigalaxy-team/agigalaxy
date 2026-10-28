package filegovernance

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// ScopeActionFileWithin is the original metadata scope lookup used after the
// owning operations authority proves the action. It grants no file access.
func (s *Service) ScopeActionFileWithin(ctx context.Context, tx pgx.Tx, kind, id string) (Object, error) {
	if !fileUUID.MatchString(id) {
		return nil, invalid()
	}
	if _, e := s.adapter(kind, false); e != nil {
		return nil, e
	}
	return s.scopedRow(ctx, tx, kind, id, false)
}

// ProcessingSummaryWithin serves the already-authorized files.read workbench
// consumer using the same endpoint/source and removal ledger as the file list.
func (s *Service) ProcessingSummaryWithin(ctx context.Context, tx pgx.Tx) (Object, error) {
	return row(ctx, tx, fileCTE+` SELECT to_jsonb(q) FROM (SELECT
 count(*) FILTER(WHERE state IN ('scan-pending','scanning') AND revoked_at IS NULL AND NOT purge_pending AND expires_at>$6)::integer AS scan_pending,
 count(*) FILTER(WHERE state IN ('scan-pending','scanning') AND revoked_at IS NULL AND NOT purge_pending AND expires_at>$6 AND last_error IS NOT NULL AND last_error<>'attachment_cleanup_failed')::integer AS scan_failed,
 count(*) FILTER(WHERE purge_pending AND purged_at IS NULL)::integer AS cleanup_pending,
 count(*) FILTER(WHERE cleanup_unknown)::integer AS cleanup_unknown FROM selected_files)q`, s.queryValues(Object{})...)
}
