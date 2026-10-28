package projects

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

// SourceRowWithin supplies metadata to a same-transaction owning consumer;
// it does not itself confer document access, a role, or a caller identity.
func (s *Service) SourceRowWithin(ctx context.Context, tx pgx.Tx, id string, write bool) (Object, error) {
	return s.project(ctx, tx, id, write)
}
func (s *Service) ExistsWithin(ctx context.Context, tx pgx.Tx, id string) (bool, error) {
	var found bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM projects_v2 WHERE id=$1)", id).Scan(&found)
	return found, e
}
func (s *Service) ImportedWithin(ctx context.Context, tx pgx.Tx, creator, id string) (bool, error) {
	var found bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM projects_v2 WHERE creator_id=$1 AND source_statement_id IS NOT NULL AND id=$2)", creator, id).Scan(&found)
	return found, e
}

// DiscoveryCandidatesWithin supplies only original candidate metadata. The
// consumer must still call the current project document/operations reader.
func (s *Service) DiscoveryCandidatesWithin(ctx context.Context, tx pgx.Tx, owner string) ([]Object, error) {
	return rows(ctx, tx, "SELECT to_jsonb(p) FROM (SELECT id,created_at FROM projects_v2 WHERE owner_id=$1 AND state='active' ORDER BY id)p", owner)
}
func (s *Service) RequireRoleWithin(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, id string, allowed []string, write bool) (Object, error) {
	if s.Devices == nil {
		return nil, fail("project_service_unavailable", 503)
	}
	if _, e := s.Devices.CurrentControlWithin(ctx, tx, actor, "history"); e != nil {
		return nil, e
	}
	p, e := s.project(ctx, tx, id, write)
	if e != nil {
		return nil, e
	}
	roles, e := s.RolesWithin(ctx, tx, p, actor.SubjectID)
	if e != nil {
		return nil, e
	}
	for _, role := range allowed {
		if contains(roles, role) {
			return p, nil
		}
	}
	return nil, fail("project_role_required", 403)
}
