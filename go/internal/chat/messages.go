package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

const operationsBlocked = `EXISTS(SELECT 1 FROM operations_chat_message_visibility_v1 ov WHERE ov.message_id=m.message_id AND ov.hidden)`

func (s *Service) receipt(r Object) Object {
	state := str(r, "state")
	if (state == "pending" || state == "accepted") && millis(r["expires_at"]) <= s.now().UnixMilli() {
		state = "expired"
	}
	return Object{"messageId": r["message_id"], "archiveId": r["archive_id"], "clientMessageId": r["client_message_id"], "state": state, "revision": r["revision"], "acceptedByRoom": state == "accepted", "readByOthers": false, "sentAt": iso(r["sent_at"]), "expiresAt": iso(r["expires_at"])}
}
func (s *Service) agent(ctx context.Context, tx pgx.Tx, a Actor, room, grant string, send bool) error {
	_, e := s.agentWithin(ctx, tx, a, room, grant, send)
	return e
}
func (s *Service) agentWithin(ctx context.Context, tx pgx.Tx, a Actor, room, grant string, send bool) (Object, error) {
	if grant == "" {
		return nil, nil
	}
	ref, _ := actorRef(a)
	g, e := row(ctx, tx, "SELECT to_jsonb(g) FROM chat_agent_grants g WHERE grant_id=$1 AND room_id=$2 AND subject_id=$3", grant, room, ref)
	if e != nil {
		return nil, e
	}
	binding := ""
	if a.Device != nil {
		binding = a.Device.BindingID
	}
	if g == nil || str(g, "binding_id") != binding || g["revoked_at"] != nil || millis(g["expires_at"]) <= s.now().UnixMilli() || send && str(g, "mode") != "respond" {
		return nil, fail("chat_agent_not_authorized", 403)
	}
	return g, nil
}
func (s *Service) rule(ctx context.Context, tx pgx.Tx, a Actor, x Object, operation, stage string, count int64) error {
	if s.Rules == nil {
		return nil
	}
	account, e := s.account(ctx, tx, a, false)
	if e != nil {
		return e
	}
	text := str(x, "text")
	_, e = s.Rules.EnforceWithin(ctx, tx, businessrules.Input{AccountID: str(account, "id"), Target: "chat-message", OperationRef: operation, Stage: stage, Text: &text, AttachmentCount: &count})
	return e
}

// Send commits the reservation before archive I/O. Reconciliation always uses
// the original message ID even when the previous delivery outcome is unknown.
func (s *Service) Send(ctx context.Context, a Actor, room string, raw []byte) (Object, error) {
	return s.sendWithHook(ctx, a, room, raw, nil)
}
func (s *Service) sendWithHook(ctx context.Context, a Actor, room string, raw []byte, before func(context.Context, pgx.Tx) error) (Object, error) {
	x, e := parseSend(raw)
	if e != nil {
		return nil, e
	}
	references, _ := x["attachments"].([]any)
	ref, _ := actorRef(a)
	reservation, e := s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, true)
		if e != nil {
			return nil, e
		}
		if _, e = s.requireAccount(ctx, tx, a); e != nil {
			return nil, e
		}
		if str(c.Room, "state") == "archived" || str(c.Room, "state") == "owner-succession" {
			return nil, fail("chat_room_read_only")
		}
		if e = s.agent(ctx, tx, a, room, str(x, "agentGrantId"), true); e != nil {
			return nil, e
		}
		old, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3", room, ref, x["clientMessageId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			if str(old, "payload_hash") != canonical(x) {
				return nil, fail("chat_message_conflict")
			}
			return old, nil
		}
		if e = assertTarget(c.Governance, "sending-paused"); e != nil {
			return nil, e
		}
		if x["attachments"] != nil && s.Attachments == nil {
			return nil, fail("attachment_service_unavailable", 503)
		}
		if before != nil {
			if e = before(ctx, tx); e != nil {
				return nil, e
			}
		}
		if x["replyTo"] != nil {
			var found bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM chat_message_refs m WHERE message_id=$1 AND room_id=$2 AND state='accepted' AND expires_at>$3 AND NOT "+operationsBlocked+")", x["replyTo"], room, s.now()).Scan(&found); e != nil {
				return nil, e
			}
			if !found {
				return nil, fail("chat_reply_unavailable")
			}
		}
		if e = s.rule(ctx, tx, a, x, str(x, "clientMessageId"), "prepare", int64(len(references))); e != nil {
			return nil, e
		}
		r, e := row(ctx, tx, `INSERT INTO chat_message_refs(message_id,room_id,subject_id,client_message_id,payload_hash,actor_kind,agent_grant_id,reply_to,sent_at,expires_at,content_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING to_jsonb(chat_message_refs)`, uuid.NewString(), room, ref, x["clientMessageId"], canonical(x), map[bool]string{true: "agent", false: "human"}[x["agentGrantId"] != nil], x["agentGrantId"], x["replyTo"], s.now(), s.now().Add(time.Duration(num(c.Room, "retention_days"))*24*time.Hour), len([]byte(str(x, "text"))))
		if e != nil {
			return nil, e
		}
		if len(references) > 0 {
			if e = s.Attachments.ValidateForMessageWithin(ctx, tx, a, room, references, str(r, "message_id")); e != nil {
				return nil, e
			}
		}
		return r, nil
	})
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, true)
		if e != nil {
			return nil, e
		}
		r, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE message_id=$1 FOR UPDATE", reservation["message_id"])
		if e != nil {
			return nil, e
		}
		if _, e = s.requireAccount(ctx, tx, a); e != nil {
			return nil, e
		}
		if e = s.agent(ctx, tx, a, room, str(x, "agentGrantId"), true); e != nil {
			return nil, e
		}
		if str(r, "state") != "pending" {
			return s.receipt(r), nil
		}
		if e = assertTarget(c.Governance, "sending-paused"); e != nil {
			return nil, e
		}
		if str(c.Room, "state") == "archived" || str(c.Room, "state") == "owner-succession" || millis(r["expires_at"]) <= s.now().UnixMilli() {
			return nil, fail("chat_send_no_longer_allowed")
		}
		if x["attachments"] != nil {
			if s.Attachments == nil {
				return nil, fail("attachment_service_unavailable", 503)
			}
			if e = s.Attachments.ValidateForMessageWithin(ctx, tx, a, room, references, str(r, "message_id")); e != nil {
				return nil, e
			}
		}
		if before != nil {
			if e = before(ctx, tx); e != nil {
				return nil, e
			}
		}
		if e = s.project(ctx, c); e != nil {
			return nil, e
		}
		if e = s.rule(ctx, tx, a, x, str(x, "clientMessageId"), "write", int64(len(references))); e != nil {
			return nil, e
		}
		receipt, e := s.command(ctx, "send", Object{"roomId": room, "subjectId": ref, "messageId": r["message_id"], "text": x["text"], "payloadHash": r["payload_hash"], "replyTo": x["replyTo"], "actorKind": r["actor_kind"], "agentGrantId": r["agent_grant_id"], "sentAt": iso(r["sent_at"]), "expiresAt": iso(r["expires_at"]), "roomRevision": c.Room["revision"]})
		if e != nil {
			return nil, e
		}
		if receipt["archiveId"] != r["message_id"] {
			return nil, fail("chat_archive_receipt_invalid", 502)
		}
		var order string
		if e = tx.QueryRow(ctx, "SELECT public.galaxy_chat_next_directory_order()::text").Scan(&order); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE chat_message_refs SET archive_id=$2,state='accepted',accepted_order=$3,accepted_at=$4 WHERE message_id=$1", r["message_id"], receipt["archiveId"], order, s.now()); e != nil {
			return nil, e
		}
		r["archive_id"] = receipt["archiveId"]
		r["state"] = "accepted"
		return s.receipt(r), nil
	})
}
func (s *Service) MessageStatus(ctx context.Context, a Actor, room string, raw []byte) (Object, error) {
	if !validID(room) {
		return nil, fail("invalid_chat_request", 400)
	}
	x, e := parse(raw, "clientMessageId", "requestHash")
	if e != nil {
		return nil, e
	}
	if !validID(str(x, "clientMessageId")) || x["requestHash"] != nil && !hashPattern.MatchString(str(x, "requestHash")) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		ref, _ := actorRef(a)
		if x["requestHash"] == nil {
			if _, e := s.requireRoom(ctx, tx, a, room, true, false); e != nil {
				return nil, e
			}
		}
		r, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3", room, ref, x["clientMessageId"])
		if e != nil {
			return nil, e
		}
		if x["requestHash"] == nil {
			if r == nil {
				return Object{"state": "not-found", "acceptedByRoom": false}, nil
			}
			return s.receipt(r), nil
		}
		out := Object{"roomId": room, "clientMessageId": x["clientMessageId"], "requestHash": x["requestHash"], "checkedAt": stamp(s.now()), "currentAccessGranted": false, "contentReturned": false, "othersReadStatus": "not-asserted", "acceptedByRoom": false}
		if r == nil {
			out["state"] = "absent"
			return out, nil
		}
		if r["payload_hash"] != x["requestHash"] {
			out["state"] = "conflict"
			return out, nil
		}
		receipt := s.receipt(r)
		for _, key := range []string{"state", "messageId", "revision", "sentAt", "expiresAt", "acceptedByRoom"} {
			out[key] = receipt[key]
		}
		out["historicalAcceptanceRecorded"] = r["archive_id"] != nil
		cleanup := "not-requested"
		if truth(r, "purge_pending") {
			cleanup = "pending"
		} else if str(r, "state") == "retracted" || str(r, "state") == "expired" {
			cleanup = "recorded-complete"
		}
		out["archiveCleanupState"] = cleanup
		return out, nil
	})
}
func (s *Service) Hide(ctx context.Context, a Actor, room, message string, hidden bool) (Object, error) {
	if !validID(message) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		if _, e := s.requireRoom(ctx, tx, a, room, true, false); e != nil {
			return nil, e
		}
		var exists bool
		if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM chat_message_refs WHERE message_id=$1 AND room_id=$2)", message, room).Scan(&exists); e != nil {
			return nil, e
		}
		if !exists {
			return nil, fail("chat_message_unavailable")
		}
		ref, _ := actorRef(a)
		_, e := tx.Exec(ctx, `INSERT INTO chat_message_preferences(room_id,subject_id,message_id,hidden,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(room_id,subject_id,message_id) DO UPDATE SET hidden=$4,updated_at=$5`, room, ref, message, hidden, s.now())
		return Object{"hidden": hidden}, e
	})
}
