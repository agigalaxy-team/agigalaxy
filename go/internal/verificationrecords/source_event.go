package verificationrecords

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

// RequireCaseEventForSourceWithin is only a current source-read qualification.
// The CI owning consumer separately validates the signed request and its
// bounded recipient. This grants no HTTP credential or user entry scope.
func (s *Service) RequireCaseEventForSourceWithin(ctx context.Context, tx pgx.Tx, row Object) (deviceauth.ConsentIntent, error) {
	if e := s.caseReadEvent(ctx, tx, nil, row); e != nil {
		return deviceauth.ConsentIntent{}, e
	}
	return s.require(ctx, tx, deviceauth.ConsentRequirement{ID: str(row, "consent_id"), SubjectID: str(row, "subject_id"), Action: "case.teaser.publish", ObjectID: str(row, "id"), Recipient: s.Endpoint, PayloadJSON: str(row, "payload_text")})
}
