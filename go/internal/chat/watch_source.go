package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

// The WatchControl transaction already rechecks its current binding actor and
// Task source. These consumers add no scope and retain Task -> Room -> Watch.
func (s *Service) WatchRoomWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, room string, write bool) (Object, error) {
	r, e := s.requireRoom(ctx, tx, Actor{Device: a}, room, true, write)
	return r.Room, e
}
func (s *Service) WatchAgentWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, room, grant string) (Object, error) {
	return s.agentWithin(ctx, tx, Actor{Device: a}, room, grant, false)
}
