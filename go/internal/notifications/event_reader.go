package notifications

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/jackc/pgx/v5"
)

// EventRead is a passive current-notice qualification. It never marks a human
// read or acknowledges a client presentation.
func (s *Service) EventRead(ctx context.Context, p webevents.Principal, id string) error {
	a, ok := p.Actor.(deviceauth.Actor)
	if s == nil || s.Devices == nil || p.Surface != "web" || p.Kind != "device" || p.Endpoint != s.Endpoint || !ok || p.Identity != a.SubjectID || p.SubjectID != a.SubjectID {
		return fail("web_events_access_denied", 403)
	}
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.Devices.AuthorizeWithin(ctx, tx, a, "notifications"); e != nil {
			return nil, e
		}
		return s.OneWithin(ctx, tx, a, id)
	})
	return e
}
