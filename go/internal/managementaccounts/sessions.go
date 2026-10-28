package managementaccounts

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// PortalSessions owns only the original portal deletion and late-callback fence.
// Native SSO revocation is a separate phase on the management directory.
type PortalSessions struct {
	Directory       *Directory
	Issuer          string
	InvalidateRoles func(string, string) bool
}

func (s *PortalSessions) identity(p Principal) error {
	if s.Directory == nil || p.Issuer != s.Issuer || !validSubject(p.ExternalSubject) || p.OperatorID != ID(p.Issuer, p.ExternalSubject) {
		return fault.New("operations_access_denied", 403)
	}
	return nil
}
func (s *PortalSessions) Summary(ctx context.Context, p Principal) (Object, error) {
	if e := s.identity(p); e != nil {
		return nil, e
	}
	var n int64
	at := s.Directory.now()
	e := s.Directory.Pool.QueryRow(ctx, `SELECT count(*)::integer FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND operator_id=$2 AND issuer=$3 AND external_subject=$4 AND expires_at>$5 AND (idle_expires_at IS NULL OR idle_expires_at>$6) AND (max_expires_at IS NULL OR max_expires_at>$6) AND refresh_state<>'revoked'`, s.Directory.Endpoint, p.OperatorID, p.Issuer, p.ExternalSubject, at, at.Unix()).Scan(&n)
	if e != nil {
		return nil, e
	}
	return Object{"state": "available", "activeCount": n, "scope": "management-portal"}, nil
}
func (s *PortalSessions) Revoke(ctx context.Context, p Principal) (Object, error) {
	if e := s.identity(p); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Directory.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912461))`, jsonText([]any{s.Directory.Endpoint, p.Issuer, p.ExternalSubject})); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, `INSERT INTO operations_management_login_fences_v1(endpoint,issuer,external_subject,revoked_before) VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT(endpoint,issuer,external_subject) DO UPDATE SET revoked_before=greatest(operations_management_login_fences_v1.revoked_before,EXCLUDED.revoked_before)`, s.Directory.Endpoint, p.Issuer, p.ExternalSubject); e != nil {
			return nil, e
		}
		rows, e := tx.Query(ctx, `DELETE FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND operator_id=$2 AND issuer=$3 AND external_subject=$4 RETURNING token_hash`, s.Directory.Endpoint, p.OperatorID, p.Issuer, p.ExternalSubject)
		if e != nil {
			return nil, e
		}
		n := 0
		for rows.Next() {
			n++
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		return Object{"revokedSessions": n, "inflightBlocked": true}, nil
	})
}
func (s *PortalSessions) Invalidate(_ context.Context, p Principal) error {
	if e := s.identity(p); e != nil {
		return e
	}
	if s.InvalidateRoles == nil || !s.InvalidateRoles(p.Issuer, p.ExternalSubject) {
		return fault.New("operations_access_denied", 403)
	}
	return nil
}
