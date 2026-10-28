package cases

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// ModerationSourceWithin is the existing Case handling target reader. Its viewer
// is established by the caller's real moderation or notification authorization;
// this source does not mint a Case actor or grant editing/participant rights.
func (s *Service) ModerationSourceWithin(ctx context.Context, tx pgx.Tx, id, viewer string, write bool) (Object, error) {
	lock := "SHARE"
	if write {
		lock = "UPDATE"
	}
	parent, e := queryOne(ctx, tx, "SELECT * FROM cases WHERE id=$1 FOR "+lock, id)
	if e != nil {
		return nil, e
	}
	if parent == nil || parent["state"] == "withdrawn" {
		return nil, fault.New("not_found", 404)
	}
	rr, e := events(ctx, tx, id)
	if e != nil {
		return nil, e
	}
	if len(rr) == 0 || len(rr) > 1000 || int64(len(rr)) != number(parent, "version") {
		return nil, fault.New("not_found", 404)
	}
	for _, row := range rr {
		source := copyObject(row)
		source["subject_id"] = parent["subject_id"]
		g, e := s.grant(ctx, tx, source)
		if e != nil {
			var service *fault.Error
			if errors.As(e, &service) {
				return nil, fault.New("not_found", 404)
			}
			return nil, e
		}
		allowed := false
		if g.IssuedAt <= s.now() && g.ExpiresAt > s.now() {
			if viewer == g.SubjectID {
				allowed = true
			} else if g.CurrentVisibility == nil || !g.CurrentVisibility.DeletionPending {
				allowed = g.Visibility == "Public" && g.Purpose == "public-profile"
				if g.Visibility == "Private" && viewer != "" {
					for _, id := range g.Viewers {
						allowed = allowed || id == viewer
					}
				}
			}
		}
		if !allowed {
			return nil, fault.New("not_found", 404)
		}
	}
	return Object{"parent": parent, "rows": rr}, nil
}
