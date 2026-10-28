package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/jackc/pgx/v5"
)

func (s *Service) publicWrites() *publicwrites.Service {
	return &publicwrites.Service{Endpoint: s.Endpoint, Links: s.Links, Policy: s.CommunityPolicy, Now: s.Now}
}
func (s *Service) consumeInvite(ctx context.Context, tx pgx.Tx, a Actor, room string, p Object) error {
	_, e := s.publicWrites().ConsumeWithin(ctx, tx, publicwrites.Actor{Device: a.Device, AccountID: a.AccountID, Authority: a.Authority, Scope: "binding"}, publicwrites.Operation{Kind: "invitation", OperationID: str(p, "decisionId"), PayloadHash: canonical(p), RoomID: room, RecipientID: str(p, "targetSubjectId")})
	return e
}
