package chat

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Decisions(ctx context.Context, a Actor, room string) (Object, error) {
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, false)
		if e != nil {
			return nil, e
		}
		rr, e := rows(ctx, tx, "SELECT to_jsonb(d) FROM chat_decisions d WHERE room_id=$1 ORDER BY created_at DESC LIMIT 100", room)
		if e != nil {
			return nil, e
		}
		out := []Object{}
		for _, d := range rr {
			view, e := s.decisionView(ctx, tx, a, d, c)
			if e != nil {
				return nil, e
			}
			out = append(out, view)
		}
		return Object{"decisions": out}, nil
	})
}
func (s *Service) Invitations(ctx context.Context, a Actor) (Object, error) {
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		ref, _ := actorRef(a)
		rr, e := rows(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT d.*,r.title FROM chat_decisions d JOIN chat_rooms r USING(room_id) WHERE d.payload->>'targetSubjectId'=$1 AND d.state='approved' AND d.expires_at>$2 AND d.member_revision=r.member_revision AND r.state<>'archived' ORDER BY d.created_at DESC LIMIT 100)q`, ref, s.now())
		if e != nil {
			return nil, e
		}
		out := []Object{}
		for _, d := range rr {
			c, e := s.requireRoom(ctx, tx, a, str(d, "room_id"), false, false)
			if e != nil {
				return nil, e
			}
			if str(d, "action") == "invite" && assertTarget(c.Governance, "invitations-paused") != nil || num(d, "member_revision") != num(c.Room, "member_revision") {
				continue
			}
			if e = s.originalRule(c, d); e != nil {
				continue
			}
			if str(d, "action") == "successor-owner" && (str(c.Room, "state") != "owner-succession" || millis(c.Room["succession_expires_at"]) <= s.now().UnixMilli()) || str(c.Room, "state") == "owner-succession" && str(d, "action") != "successor-owner" {
				continue
			}
			view, e := s.decisionView(ctx, tx, a, d, c)
			if e != nil {
				return nil, e
			}
			view["title"] = d["title"]
			out = append(out, view)
		}
		return Object{"invitations": out}, nil
	})
}

// ReadBookmarkWithin reuses current room/member/archive checks in the caller's
// authenticated transaction. It is a source read, never republication consent.
func (s *Service) ReadBookmarkWithin(ctx context.Context, tx pgx.Tx, a Actor, room, message string) (Object, error) {
	if !validID(room) || !validID(message) {
		return nil, fail("invalid_chat_request", 400)
	}
	read := func() (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, false)
		if e != nil {
			return nil, e
		}
		rr, e := s.messageRows(ctx, tx, a, room, "m.message_id=$3", []any{message}, "m.sequence ASC", 0)
		if e != nil {
			return nil, e
		}
		if len(rr) > 0 && truth(rr[0], "operationally_hidden") {
			return Object{"state": "temporarily-unavailable", "reason": "source-check-failed"}, nil
		}
		if len(rr) == 0 || truth(rr[0], "personally_hidden") || truth(rr[0], "author_quarantined") {
			return Object{"state": "unavailable", "reason": "source-not-readable"}, nil
		}
		r := rr[0]
		if str(r, "state") == "retracted" {
			return Object{"state": "unavailable", "reason": "source-withdrawn"}, nil
		}
		if str(r, "state") == "expired" || millis(r["expires_at"]) <= s.now().UnixMilli() {
			return Object{"state": "unavailable", "reason": "source-expired"}, nil
		}
		result, e := s.readMessages(ctx, tx, a, c, rr, Object{})
		if e != nil {
			return nil, e
		}
		messages := result["messages"].([]Object)
		if len(messages) == 0 || trim(str(messages[0], "text")) == "" {
			return Object{"state": "unavailable", "reason": "source-not-readable"}, nil
		}
		m := messages[0]
		summary := []rune(trim(str(m, "text")))
		if len(summary) > 360 {
			summary = summary[:360]
		}
		until := s.now().Unix() + 15
		if num(result, "readExpiresAt") < until {
			until = num(result, "readExpiresAt")
		}
		author := actorView(str(m, "subjectId"))
		return Object{"state": "available", "title": c.Room["title"], "summary": string(summary), "availableUntil": until, "revision": m["revision"], "authorAccountId": author["accountId"], "authorId": author["galaxySubjectId"]}, nil
	}
	result, e := read()
	if e == nil {
		return result, nil
	}
	if has([]string{"chat_access_denied", "chat_room_not_found"}, fault.Code(e)) {
		return Object{"state": "unavailable", "reason": "source-not-readable"}, nil
	}
	if fault.Code(e) != "internal_error" {
		return Object{"state": "temporarily-unavailable", "reason": "source-check-failed"}, nil
	}
	return nil, e
}
func (s *Service) Context(ctx context.Context, a Actor, room, message string, raw []byte) (Object, error) {
	if !validID(message) {
		return nil, fail("invalid_chat_request", 400)
	}
	x, e := parse(raw, "limit")
	if e != nil {
		return nil, e
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = int64(41)
	}
	if !normalizeInteger(x, "limit", 3, 100) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, false)
		if e != nil {
			return nil, e
		}
		target, e := s.messageRows(ctx, tx, a, room, "m.message_id=$3", []any{message}, "m.sequence ASC", 0)
		if e != nil {
			return nil, e
		}
		empty := Object{"roomId": room, "messageId": message, "target": nil, "targetState": "unavailable", "messages": []Object{}, "previous": nil, "next": nil, "after": "0", "scannedThrough": "0", "complete": true, "readExpiresAt": s.now().Unix() + 60}
		if len(target) == 0 {
			return empty, nil
		}
		count := num(x, "limit") / 2
		earlier, e := s.messageRows(ctx, tx, a, room, "m.sequence<$3::bigint", []any{target[0]["sequence"]}, "m.sequence DESC", count+1)
		if e != nil {
			return nil, e
		}
		later, e := s.messageRows(ctx, tx, a, room, "m.sequence>=$3::bigint", []any{target[0]["sequence"]}, "m.sequence ASC", num(x, "limit")-count+1)
		if e != nil {
			return nil, e
		}
		page := []Object{}
		n := int64(len(earlier))
		if n > count {
			n = count
		}
		for i := n - 1; i >= 0; i-- {
			page = append(page, earlier[i])
		}
		n = int64(len(later))
		if n > num(x, "limit")-count {
			n = num(x, "limit") - count
		}
		page = append(page, later[:n]...)
		result, e := s.readMessages(ctx, tx, a, c, page, Object{})
		if e != nil {
			return nil, e
		}
		current, e := s.messageRows(ctx, tx, a, room, "m.message_id=$3", []any{message}, "m.sequence ASC", 0)
		if e != nil {
			return nil, e
		}
		messages := result["messages"].([]Object)
		var selected Object
		for _, m := range messages {
			if str(m, "messageId") == message {
				selected = m
			}
		}
		state := "unavailable"
		if len(current) > 0 {
			r := current[0]
			switch {
			case truth(r, "operationally_hidden"):
				state = "unavailable"
			case truth(r, "personally_hidden"):
				state = "hidden"
			case str(r, "state") == "retracted":
				state = "retracted"
			case str(r, "state") == "expired" || millis(r["expires_at"]) <= s.now().UnixMilli():
				state = "expired"
			case selected != nil && str(selected, "state") == "accepted":
				state = "available"
			}
		}
		if state != "available" && state != "retracted" {
			selected = nil
			filtered := []Object{}
			for _, m := range messages {
				if str(m, "messageId") != message {
					filtered = append(filtered, m)
				}
			}
			result["messages"] = filtered
		}
		for k, v := range result {
			empty[k] = v
		}
		empty["targetState"] = state
		if selected != nil {
			empty["target"] = selected
		}
		if len(page) > 0 {
			empty["after"] = decrement(str(page[0], "sequence"))
			empty["scannedThrough"] = page[len(page)-1]["sequence"]
			if int64(len(earlier)) > count {
				empty["previous"] = page[0]["sequence"]
			}
			if int64(len(later)) > num(x, "limit")-count {
				empty["next"] = page[len(page)-1]["sequence"]
			}
		}
		empty["complete"] = int64(len(earlier)) <= count && int64(len(later)) <= num(x, "limit")-count
		return empty, nil
	})
}
func (s *Service) Dismiss(ctx context.Context, a Actor, room string) (Object, error) {
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, true)
		if e != nil {
			return nil, e
		}
		ref, _ := actorRef(a)
		_, e = tx.Exec(ctx, "UPDATE chat_memberships SET dismissed_revision=$3 WHERE room_id=$1 AND subject_id=$2", room, ref, num(c.Room, "revision"))
		return Object{"dismissed": true}, e
	})
}

// Read selected text keeps the original current-version and publication limits.
func (s *Service) ReadSelectedWithin(ctx context.Context, tx pgx.Tx, a Actor, message string, revision int64) (Object, error) {
	ref, e := actorRef(a)
	if e != nil {
		return nil, e
	}
	return s.readSelectedRefWithin(ctx, tx, ref, message, revision)
}
func (s *Service) readSelectedRefWithin(ctx context.Context, tx pgx.Tx, ref, message string, revision int64) (Object, error) {
	r, c, e := s.selectedRefWithin(ctx, tx, ref, "", message, revision)
	if e != nil {
		return nil, e
	}
	if e = s.project(ctx, c); e != nil {
		return nil, e
	}
	result, e := s.command(ctx, "read", Object{"roomId": r["room_id"], "subjectId": ref, "ids": []string{str(r, "archive_id")}, "roomRevision": c.Room["revision"]})
	if e != nil {
		return nil, e
	}
	items, _ := result["messages"].([]any)
	if len(items) != 1 {
		return nil, fail("chat_message_version_unavailable")
	}
	body, _ := items[0].(map[string]any)
	if num(body, "revision") != revision {
		return nil, fail("chat_message_version_unavailable")
	}
	var blocked bool
	if e = tx.QueryRow(ctx, "SELECT "+operationsBlocked+" FROM chat_message_refs m WHERE message_id=$1", message).Scan(&blocked); e != nil {
		return nil, e
	}
	if blocked {
		return nil, fail("chat_message_version_unavailable")
	}
	if _, _, e = s.selectedRefWithin(ctx, tx, ref, str(r, "room_id"), message, revision); e != nil {
		return nil, e
	}
	return Object{"sourceType": "chat-message", "messageId": message, "roomId": r["room_id"], "revision": revision, "sequence": fmt.Sprint(r["sequence"]), "authorId": r["subject_id"], "text": body["text"], "contentHash": identity.Digest([]byte(str(body, "text"))), "expiresAt": iso(r["expires_at"]), "permission": "current-room-read-only", "publicationPermission": false}, nil
}

// RequireSelectedWithin is a body-free late check for an already authorized
// evidence/material transaction. It adds no credential scope of its own.
func (s *Service) RequireSelectedWithin(ctx context.Context, tx pgx.Tx, a Actor, room, message string, revision int64) (Object, error) {
	r, _, e := s.selectedWithin(ctx, tx, a, room, message, revision)
	return r, e
}
func (s *Service) selectedWithin(ctx context.Context, tx pgx.Tx, a Actor, room, message string, revision int64) (Object, roomContext, error) {
	ref, e := actorRef(a)
	if e != nil {
		return nil, roomContext{}, e
	}
	return s.selectedRefWithin(ctx, tx, ref, room, message, revision)
}
func (s *Service) selectedRefWithin(ctx context.Context, tx pgx.Tx, ref, room, message string, revision int64) (Object, roomContext, error) {
	empty := roomContext{}
	if !validID(message) || revision < 1 || room != "" && !validID(room) {
		return nil, empty, fail("invalid_chat_request", 400)
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(m)||jsonb_build_object('sequence',m.sequence::text) FROM chat_message_refs m WHERE message_id=$1", message)
	if e != nil {
		return nil, empty, e
	}
	if r == nil {
		return nil, empty, fail("chat_message_unavailable", 404)
	}
	if room != "" && str(r, "room_id") != room {
		return nil, empty, fail("chat_message_version_unavailable")
	}
	c, e := s.requireRoomRef(ctx, tx, ref, str(r, "room_id"), true, false)
	if e != nil {
		return nil, empty, e
	}
	r, e = row(ctx, tx, "SELECT to_jsonb(m)||jsonb_build_object('sequence',m.sequence::text) FROM chat_message_refs m WHERE message_id=$1 FOR SHARE", message)
	if e != nil {
		return nil, empty, e
	}
	if str(r, "state") != "accepted" || num(r, "revision") != revision || millis(r["expires_at"]) <= s.now().UnixMilli() {
		return nil, empty, fail("chat_message_version_unavailable")
	}
	rr, e := s.messageRowsRef(ctx, tx, ref, str(r, "room_id"), "m.message_id=$3", []any{message}, "m.sequence ASC", 0)
	if e != nil {
		return nil, empty, e
	}
	if len(rr) == 0 || truth(rr[0], "operationally_hidden") || truth(rr[0], "author_quarantined") {
		return nil, empty, fail("chat_message_version_unavailable")
	}
	return r, c, nil
}
