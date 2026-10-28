package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

// NotificationViewWithin consumes the Inbox's already authenticated
// notifications Actor, within its transaction. Current room/source authority
// is shared with chat; there is no binding/assistance scope escalation.
func (s *Service) NotificationViewWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, kind, eventID, roomID string) (Object, error) {
	if !has([]string{"room-message", "room-invite"}, kind) {
		return nil, fail("invalid_notification_source", 400)
	}
	c, e := s.requireRoom(ctx, tx, Actor{Device: &a}, roomID, kind == "room-message", false)
	if e != nil {
		return nil, e
	}
	if kind == "room-message" {
		r, e := row(ctx, tx, `SELECT to_jsonb(m)||jsonb_build_object('author_pending',EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased')),'operations_blocked',`+operationsBlocked+`) FROM chat_message_refs m WHERE m.message_id=$1 AND m.room_id=$2 FOR SHARE OF m`, eventID, roomID)
		if e != nil {
			return nil, e
		}
		if r == nil || str(r, "state") != "accepted" || millis(r["expires_at"]) <= s.now().UnixMilli() || truth(r, "author_pending") || truth(r, "operations_blocked") {
			return nil, nil
		}
		return Object{"title": c.Room["title"], "eventKind": "room-message", "actorId": r["subject_id"], "object": Object{"type": "room", "id": roomID, "messageId": r["message_id"]}, "sourceExpiresAt": iso(r["expires_at"])}, nil
	}
	if parent := str(c.Room, "parent_room_id"); parent != "" {
		if _, e = s.requireRoom(ctx, tx, Actor{Device: &a}, parent, true, false); e != nil {
			return nil, e
		}
	}
	d, e := row(ctx, tx, "SELECT to_jsonb(d) FROM chat_decisions d WHERE decision_id=$1 FOR SHARE", eventID)
	if e != nil {
		return nil, e
	}
	if d == nil || str(d, "state") != "approved" || num(d, "member_revision") != num(c.Room, "member_revision") || millis(d["expires_at"]) <= s.now().UnixMilli() || str(c.Room, "state") == "archived" {
		return nil, nil
	}
	if str(d, "action") == "invite" && has(stringValues(c.Governance["scopes"]), "invitations-paused") {
		return nil, nil
	}
	return Object{"title": c.Room["title"], "eventKind": "room-invitation", "actorId": d["proposer_subject_id"], "object": Object{"type": "room-invitation", "id": d["decision_id"], "roomId": d["room_id"]}}, nil
}
