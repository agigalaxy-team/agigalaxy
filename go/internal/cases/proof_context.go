package cases

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// ProofCaseContextWithin is the original optional, current-readable v1 review
// companion. It does not modify the signed CI observation or certify a task.
func (s *Service) ProofCaseContextWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, caseID, subject string) (Object, error) {
	rows, e := events(ctx, tx, caseID)
	if e != nil {
		return nil, e
	}
	hasRevision := false
	for _, r := range rows {
		hasRevision = hasRevision || r["kind"] == "revision"
	}
	if len(rows) > 1000 || !hasRevision {
		return nil, nil
	}
	for _, r := range rows {
		r = copyObject(r)
		r["subject_id"] = subject
		intent, e := s.grant(ctx, tx, r)
		if e != nil {
			var se *fault.Error
			if errors.As(e, &se) {
				return nil, nil
			}
			return nil, e
		}
		allowed := false
		if intent.IssuedAt <= s.now() && intent.ExpiresAt > s.now() {
			if a != nil && a.SubjectID == intent.SubjectID {
				allowed = true
			} else if intent.CurrentVisibility == nil || !intent.CurrentVisibility.DeletionPending {
				if intent.Visibility == "Public" {
					allowed = intent.Purpose == "public-profile"
				} else if intent.Visibility == "Private" && a != nil {
					for _, id := range intent.Viewers {
						allowed = allowed || id == a.SubjectID
					}
				}
			}
		}
		if !allowed {
			return nil, nil
		}
	}
	threads := reviews(rows)
	corrections := []any{}
	active := false
	for _, v := range threads {
		r := object(v)
		active = active || r["type"] == "dispute" && one(r["state"], "opened", "in-review", "reopened")
	}
	for _, r := range rows {
		p := object(r["payload"])
		if p["kind"] == "revision" && p["review"] == nil {
			corrections = append(corrections, Object{"eventId": p["id"], "targetEventId": p["correctsEventId"], "reason": p["reason"], "summary": p["summary"]})
		}
	}
	status := "review-recorded"
	if active {
		status = "active-dispute"
	} else if len(corrections) > 0 {
		status = "has-corrections"
	}
	return Object{"caseId": caseID, "sourceVersion": rows[len(rows)-1]["version"], "checkedAt": s.now(), "status": status, "scope": "visible-case-context-only", "authority": "case-owner-reported", "independentDecision": false, "affectsSignedCiFact": false, "reviews": threads, "corrections": corrections}, nil
}
