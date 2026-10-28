package moderation

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// Evidence owns the verification job generation and source-specific producer.
// The signed handling event must exist before its job is enqueued in this tx.
type EvidenceJobs interface {
	PrepareModerationRevalidationWithin(context.Context, pgx.Tx, string, string, string, string, string) (map[string]any, error)
	EnqueueModerationRevalidationWithin(context.Context, pgx.Tx, map[string]any) error
}

func (s *Service) prepareRevalidation(ctx context.Context, tx pgx.Tx, a Actor, r, x Object, consent string) (Object, error) {
	report := obj(r, "reportData")
	if report == nil {
		return nil, fail("moderation_source_unavailable", 409)
	}
	if r["case_id"] == nil || report["evidenceId"] != x["evidenceId"] {
		return nil, fail("moderation_evidence_target_mismatch", 409)
	}
	if _, e := s.caseSource(ctx, tx, a.Device.SubjectID, str(r, "case_id"), false); e != nil {
		return nil, e
	}
	if _, e := s.evidenceTarget(ctx, tx, a.Device.SubjectID, str(r, "case_id"), str(report, "targetEventId"), str(x, "evidenceId")); e != nil {
		return nil, e
	}
	jobs, ok := s.Evidence.(EvidenceJobs)
	if !ok {
		return nil, fail("evidence_revalidation_unavailable", 409)
	}
	return jobs.PrepareModerationRevalidationWithin(ctx, tx, str(x, "evidenceId"), str(x, "id"), str(r, "id"), consent, a.Device.SubjectID)
}
func (s *Service) enqueueRevalidation(ctx context.Context, tx pgx.Tx, job Object) error {
	jobs, ok := s.Evidence.(EvidenceJobs)
	if !ok {
		return fail("evidence_revalidation_unavailable", 409)
	}
	return jobs.EnqueueModerationRevalidationWithin(ctx, tx, job)
}
