package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

// GovernanceSourceWithin is an internal source snapshot for an already
// moderation-authorized caller. A report never confers room history access.
func (s *Service) GovernanceSourceWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, authorize, lock bool) (Object, error) {
	var r Object
	var e error
	if authorize {
		if a == nil {
			return nil, fail("chat_access_denied", 403)
		}
		current, e := s.requireRoom(ctx, tx, Actor{Device: a}, id, true, lock)
		if e != nil {
			return nil, e
		}
		r = current.Room
	} else {
		suffix := ""
		if lock {
			suffix = " FOR UPDATE"
		}
		r, e = row(ctx, tx, "SELECT to_jsonb(r) FROM chat_rooms r WHERE room_id=$1"+suffix, id)
		if e != nil {
			return nil, e
		}
	}
	if r == nil {
		return nil, fail("target_unavailable", 404)
	}
	members, e := rows(ctx, tx, "SELECT to_jsonb(m) FROM (SELECT subject_id FROM chat_memberships WHERE room_id=$1 AND left_at IS NULL)m", id)
	if e != nil {
		return nil, e
	}
	parties := []string{}
	for _, m := range members {
		parties = append(parties, str(m, "subject_id"))
	}
	return Object{"target": Object{"type": "room", "id": r["room_id"], "version": r["revision"]}, "parties": parties, "sourceAvailable": r["state"] != "archived", "state": r["state"], "contentAccess": "report-does-not-grant-room-history-or-membership"}, nil
}
