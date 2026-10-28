package capsules

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// OperationsSourceWithin ignores only the operator hide layer. It remains an
// anonymous current-public-source read, with all original grants and selected
// publication dependencies checked by the owning version reader.
func (s *Service) OperationsSourceWithin(ctx context.Context, tx pgx.Tx, capsuleID string) (Object, error) {
	v, e := s.versionWithin(ctx, tx, nil, capsuleID, "", true, true)
	if e != nil {
		return nil, e
	}
	return Object{"row": v.row, "payload": v.wire, "deprecated": v.deprecated, "securityIssue": v.security, "sourceStatus": v.status}, nil
}

// OperationsMaintenanceWithin preserves the independent latest-version state
// read used even when the latest publication itself is private/unavailable.
// Notice bodies still pass their own current public Consent checks.
func (s *Service) OperationsMaintenanceWithin(ctx context.Context, tx pgx.Tx, capsuleID string) (Object, error) {
	latest, e := one(ctx, tx, `SELECT id FROM capsule_events WHERE capsule_id=$1 AND kind='version' ORDER BY revision DESC LIMIT 1`, capsuleID)
	if e != nil || latest == nil {
		return nil, e
	}
	return s.maintenance(ctx, tx, nil, capsuleID, text(latest, "id"), false)
}
