package configurations

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// ConditionGrantAuthorWithin is the exact current source condition for the
// independent Trust license's verified author. It provides no ordinary Actor,
// session or write entry; existing consent and source state still decide access.
func (s *Service) ConditionGrantAuthorWithin(ctx context.Context, tx pgx.Tx, author string, ref any) (Object, error) {
	if !subjectPattern.MatchString(author) {
		return nil, fault.New("access_denied", 403)
	}
	current := *s
	current.grantAuthor = author
	return current.ConditionWithin(ctx, tx, nil, ref)
}
func (s *Service) RequireReferenceGrantAuthorWithin(ctx context.Context, tx pgx.Tx, author string, ref Object) (Object, error) {
	if !subjectPattern.MatchString(author) {
		return nil, fault.New("access_denied", 403)
	}
	current := *s
	current.grantAuthor = author
	return current.RequireReferenceWithin(ctx, tx, nil, ref)
}
