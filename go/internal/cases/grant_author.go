package cases

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) sourceViewer(a *deviceauth.Actor) string {
	if s.grantAuthor != "" {
		return s.grantAuthor
	}
	if a != nil {
		return a.SubjectID
	}
	return ""
}

// ReadV2GrantAuthorWithin is only for the independent Trust permission consumer
// after it verified the original author's exact current license/control. It
// carries a source viewer, never a bearer/session or a write-capable Actor.
func (s *Service) ReadV2GrantAuthorWithin(ctx context.Context, tx pgx.Tx, author, id, taskID string) (Object, error) {
	if !subjectPattern.MatchString(author) {
		return nil, fault.New("access_denied", 403)
	}
	current := *s
	current.grantAuthor = author
	return current.readV2Within(ctx, tx, nil, author, id, taskID)
}

// RequireFactGrantAuthorWithin preserves the same current Case and dependency
// checks for the verification owning reader under that verified license viewer.
func (s *Service) RequireFactGrantAuthorWithin(ctx context.Context, tx pgx.Tx, author string, rows []Object, facts Object, kind string, ref Object, options FactOptions) (Object, error) {
	if !subjectPattern.MatchString(author) {
		return nil, fault.New("access_denied", 403)
	}
	current := *s
	current.grantAuthor = author
	return current.RequireFactWithin(ctx, tx, nil, rows, facts, kind, ref, options)
}
