package projects

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/jackc/pgx/v5"
)

// EventRead calls the current project source projection, rather than treating
// the event producer's locator as authority. Account portals see public data.
func (s *Service) EventRead() webevents.PublicRead {
	return func(ctx context.Context, p webevents.Principal, id, parent string) (Object, error) {
		if s == nil || s.Pool == nil {
			return nil, fail("project_service_unavailable", 503)
		}
		if p.Endpoint != s.Endpoint || p.Surface != "web" {
			return nil, fail("web_events_access_denied", 403)
		}
		var a *deviceauth.Actor
		switch p.Kind {
		case "device":
			v, ok := p.Actor.(deviceauth.Actor)
			if !ok || v.SubjectID != p.SubjectID || p.Identity != v.SubjectID {
				return nil, fail("web_events_access_denied", 403)
			}
			a = &v
		case "anonymous", "official-account":
		default:
			return nil, fail("web_events_access_denied", 403)
		}
		return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.ReadWithin(ctx, tx, a, id) })
	}
}
