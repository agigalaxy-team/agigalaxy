package operationscommunity

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ContentAttachment(ctx context.Context, a Actor, kind, id, attachmentID string, reauthorize func() (Actor, error)) (community.AttachmentContent, error) {
	var out community.AttachmentContent
	if !validID(attachmentID) {
		return out, invalid()
	}
	_, e := s.domain().Run(ctx, a, "community-content-read", Object{"kind": kind, "id": id, "attachmentId": attachmentID}, func(tx pgx.Tx, a Actor) (Object, error) {
		if s.Files == nil {
			return nil, fail("attachment_service_unavailable", 503)
		}
		authorize := func() error {
			current := a
			var e error
			if reauthorize != nil {
				current, e = reauthorize()
				if e != nil {
					return e
				}
			}
			current, e = s.domain().Fresh(ctx, tx, current, "content.read")
			if e != nil {
				return e
			}
			if current.ID != a.ID {
				return fail("business_admin_denied", 403)
			}
			return s.domain().Principal(ctx, tx, current)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		view, e := s.contentView(ctx, tx, a, kind, id, true, false)
		if e != nil {
			return nil, e
		}
		eligible := str(view, "sourceState") == "available" && !yes(obj(view, "visibility"), "hidden")
		found := false
		for _, f := range view["attachments"].([]Object) {
			found = found || str(f, "id") == attachmentID && str(f, "availability") == "available"
		}
		if !eligible || !found {
			return nil, fail("attachment_source_unavailable", 404)
		}
		source := Object{"postId": id, "versionId": view["versionId"]}
		if kind == "reply" {
			source = Object{"replyId": id}
		}
		out, e = s.Files.OperationsAttachmentWithin(ctx, tx, source, attachmentID, authorize)
		return Object{}, e
	})
	return out, e
}
