package community

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// ReadPublicDiscoveryWithin is a trusted internal source consumer. worker only
// changes row-lock/display projection mechanics for the existing read-only DB
// role; all public consent, audience, section and governance checks are shared.
// HTTP never exposes or obtains the request-scoped service copy.
func (s *Service) ReadPublicDiscoveryWithin(ctx context.Context, tx pgx.Tx, kind, id string, worker bool) (Object, error) {
	if s == nil || s.Endpoint == "" {
		return nil, fail("forum_service_unavailable", 503)
	}
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	current := *s
	current.actor = nil
	current.Authority = nil
	current.workerPublicRead = worker
	switch kind {
	case "post":
		return current.readPost(ctx, tx, id, "")
	case "reply":
		return current.readReply(ctx, tx, id, "")
	}
	return nil, fail("not_found", 404)
}
