package accountsocial

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/jackc/pgx/v5"
)

// ProfileSource consumes the ID declaration reader. Account profile fields and
// linked IDs cannot substitute for an ID viewer's current history authority.
func ProfileSource(service *profiles.Service) SourceReader {
	return func(ctx context.Context, tx pgx.Tx, a Actor, r Reference) (Object, error) {
		if service == nil {
			return nil, fault.New("profile_service_unavailable", 503)
		}
		var viewer *deviceauth.Actor
		if a.Device.SubjectID != "" {
			viewer = &a.Device
		}
		return service.ReadWithin(ctx, tx, viewer, r.SubjectID)
	}
}
