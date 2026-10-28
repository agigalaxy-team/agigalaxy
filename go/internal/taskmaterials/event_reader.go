package taskmaterials

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
)

// EventRead is the original signed-ID Task event consumer. Connection binding
// authority is rechecked by WebEvents; the Task read also requires current
// assistance scope and the original Task/source grants.
func (s *Service) EventRead(ctx context.Context, p webevents.Principal, id, _ string) (Object, error) {
	a, ok := p.Actor.(deviceauth.Actor)
	if s == nil || p.Surface != "web" || p.Kind != "device" || p.Endpoint != s.Endpoint || !ok || p.Identity != a.SubjectID || p.SubjectID != a.SubjectID {
		return nil, fail("web_events_access_denied", 403)
	}
	value, err := s.GetTask(ctx, &Actor{Actor: a}, id)
	if err != nil {
		return nil, err
	}
	return value.(map[string]any), nil
}

// PublicEventRead retains anonymous/public Task reading for website accounts;
// account sessions never impersonate the controlled identity linked to them.
func (s *Service) PublicEventRead(ctx context.Context, p webevents.Principal, id, _ string) (Object, error) {
	if s == nil || p.Surface != "web" || p.Endpoint != s.Endpoint || p.Kind != "anonymous" {
		return nil, fail("web_events_access_denied", 403)
	}
	value, err := s.GetTask(ctx, nil, id)
	if err != nil {
		return nil, err
	}
	return value.(map[string]any), nil
}
