package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
)

// EventConsumers fills only the three migrated forum source readers. Callers
// retain all other consumers; missing domains stay unavailable in webevents.
func (s *Service) EventConsumers() webevents.PublicConsumers {
	reader := func(kind string) webevents.PublicRead {
		return func(ctx context.Context, p webevents.Principal, id, parent string) (Object, error) {
			if s == nil || s.Pool == nil {
				return nil, fault.New("forum_service_unavailable", 503)
			}
			if p.Endpoint != s.Endpoint || p.Surface != "web" {
				return nil, fault.New("web_events_access_denied", 403)
			}
			current := *s
			account := ""
			switch p.Kind {
			case "anonymous":
				if p.Identity != "anonymous" || p.AccountID != "" || p.SubjectID != "" || p.Actor != nil {
					return nil, fault.New("web_events_access_denied", 403)
				}
				current.actor = nil
			case "official-account":
				authority, ok := p.Actor.(Authorization)
				if !ok {
					return nil, fault.New("web_events_authority_unavailable", 503)
				}
				if !validID(p.AccountID) || p.Identity != p.AccountID {
					return nil, fault.New("web_events_access_denied", 403)
				}
				current.Authority = authority
				current.actor = nil
				account = p.AccountID
			case "device":
				actor, ok := p.Actor.(deviceauth.Actor)
				if !ok || actor.SubjectID != p.SubjectID || p.Identity != actor.SubjectID {
					return nil, fault.New("web_events_access_denied", 403)
				}
				current = *current.ForIdentity(actor, "binding", "")
				account = p.AccountID
			default:
				return nil, fault.New("web_events_access_denied", 403)
			}
			switch kind {
			case "post":
				return current.GetPost(ctx, account, id)
			case "reply":
				return current.GetReply(ctx, account, id)
			default:
				return current.GetVersion(ctx, account, parent, id)
			}
		}
	}
	return webevents.PublicConsumers{ForumPost: reader("post"), ForumReply: reader("reply"), ForumVersion: reader("version")}
}
