package chat

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// RequireSelectedGrantAuthorWithin is only for an independently verified
// current signed-license author. It checks the same selected-source metadata
// and current room access as ReadSelectedWithin, without creating a device
// identity, reading archive text, or granting publication permission.
func (s *Service) RequireSelectedGrantAuthorWithin(ctx context.Context, tx pgx.Tx, author, message string, revision int64) (Object, error) {
	if !subjectPattern.MatchString(author) {
		return nil, fail("invalid_chat_request", 400)
	}
	r, _, e := s.selectedRefWithin(ctx, tx, author, "", message, revision)
	if e != nil {
		return nil, e
	}
	return Object{"sourceType": "chat-message", "messageId": message, "roomId": r["room_id"], "revision": revision, "authorId": r["subject_id"], "expiresAt": iso(r["expires_at"]), "permission": "current-room-read-only", "publicationPermission": false}, nil
}

// ReadSelectedGrantAuthorWithin retains the original actual archive read and
// late current-source recheck for an independently verified license author.
func (s *Service) ReadSelectedGrantAuthorWithin(ctx context.Context, tx pgx.Tx, author, message string, revision int64) (Object, error) {
	if !subjectPattern.MatchString(author) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.readSelectedRefWithin(ctx, tx, author, message, revision)
}
