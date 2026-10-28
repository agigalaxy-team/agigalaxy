package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
)

// EventRead consumes the same current room membership projection as HTTP.
// A producer locator is never sufficient authority to expose a room event.
func (s *Service) EventRead() webevents.PublicRead {
	return func(ctx context.Context, p webevents.Principal, id, parent string) (Object, error) {
		if s == nil || s.Pool == nil {
			return nil, fail("chat_service_unavailable", 503)
		}
		if p.Endpoint != s.Endpoint || p.Surface != "web" {
			return nil, fail("web_events_access_denied", 403)
		}
		a := Actor{AccountID: p.AccountID}
		switch p.Kind {
		case "official-account":
			authority, ok := p.Actor.(Authorization)
			if !ok {
				return nil, fail("web_events_authority_unavailable", 503)
			}
			if !validID(p.AccountID) || p.Identity != p.AccountID {
				return nil, fail("web_events_access_denied", 403)
			}
			a.Authority = authority
		case "device":
			actor, ok := p.Actor.(deviceauth.Actor)
			if !ok || actor.SubjectID != p.SubjectID || p.Identity != actor.SubjectID {
				return nil, fail("web_events_access_denied", 403)
			}
			a.Device = &actor
		default:
			return nil, fail("web_events_access_denied", 403)
		}
		return s.Get(ctx, a, id)
	}
}
