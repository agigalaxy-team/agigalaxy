package verificationrecords

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// ReadGrantAuthorWithin is a source-only projection for an already verified
// independent Trust license. It grants no credential, scope or write authority.
func (s *Service) ReadGrantAuthorWithin(ctx context.Context, tx pgx.Tx, author string, ref Object) (Object, error) {
	if !subjectPattern.MatchString(author) {
		return nil, fault.New("access_denied", 403)
	}
	current := *s
	current.ReadRecipient = author
	current.grantAuthor = author
	return current.ReadWithin(ctx, tx, nil, ref)
}
func (s *Service) RequireReferenceGrantAuthorWithin(ctx context.Context, tx pgx.Tx, author string, ref Object, options ReferenceOptions) (Object, error) {
	if !subjectPattern.MatchString(author) {
		return nil, fault.New("access_denied", 403)
	}
	current := *s
	current.ReadRecipient = author
	current.grantAuthor = author
	return current.RequireReferenceWithin(ctx, tx, nil, ref, options)
}
