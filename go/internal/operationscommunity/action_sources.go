package operationscommunity

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// These sources are used only after the owning prepared-action authority has
// established the caller and exact target. They do not authorize an operation.
func (s *Service) QualifyActionSectionWithin(ctx context.Context, tx pgx.Tx, a Actor, id string) error {
	r, e := s.sectionWithin(ctx, tx, id, false)
	if e != nil {
		return e
	}
	v, e := s.sectionView(ctx, tx, r, a)
	if e != nil {
		return e
	}
	if str(v, "sourceState") != "available" {
		return fail("operations_source_unavailable", 409)
	}
	return nil
}
func (s *Service) QualifyActionCaseWithin(ctx context.Context, tx pgx.Tx, a Actor, id string) error {
	r, e := s.reportWithin(ctx, tx, id, false)
	if e != nil {
		return e
	}
	v, e := s.reportView(ctx, tx, r, a, true)
	if e != nil {
		return e
	}
	if !yes(v, "canModerate") || str(obj(v, "source"), "availability") != "available" {
		return fail("operations_agentos_human_review_required", 409)
	}
	if r["decision_event_id"] != nil {
		var original bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM forum_governance_events_v1 WHERE id=$1)", r["decision_event_id"]).Scan(&original); e != nil {
			return e
		}
		if original {
			return fail("operations_agentos_human_review_required", 409)
		}
	}
	return nil
}
