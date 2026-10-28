package taskmaterials

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// RequireReferenceGrantAuthorWithin is a source-only reader for an independently
// verified current Trust reproduction license. It grants no device authority:
// the same owning reader still checks audience, current approvals, deletion,
// source integrity, and late availability after object I/O.
func (o *OutcomeService) RequireReferenceGrantAuthorWithin(ctx context.Context, tx pgx.Tx, author string, ref Object, caseID string) (Object, error) {
	if author == "" {
		return nil, fail("access_denied", 403)
	}
	v, e := o.readViewerWithin(ctx, tx, author, str(ref, "id"))
	if e != nil {
		return nil, e
	}
	if caseID != "" && str(v, "caseId") != caseID {
		return nil, fail("source_case_mismatch", 422)
	}
	v["type"] = "outcome-material"
	v["contentHash"] = v["sha256"]
	v["sourceState"] = v["state"]
	return v, nil
}
