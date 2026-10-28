package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

func parseEdit(raw []byte) (Object, error) {
	x, e := parse(raw, "operationId", "expectedRevision", "text")
	if e != nil {
		return nil, e
	}
	text, ok := x["text"].(string)
	if !validID(str(x, "operationId")) || !normalizeInteger(x, "expectedRevision", 1, 9007199254740991) || !ok || textLength(text) < 1 || textLength(text) > 16000 {
		return nil, fail("invalid_chat_request", 400)
	}
	return x, nil
}
func (s *Service) Edit(ctx context.Context, a Actor, room, message string, raw []byte) (Object, error) {
	if !validID(message) {
		return nil, fail("invalid_chat_request", 400)
	}
	x, e := parseEdit(raw)
	if e != nil {
		return nil, e
	}
	ref, _ := actorRef(a)
	reservation, e := s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, true)
		if e != nil {
			return nil, e
		}
		if _, e = s.requireAccount(ctx, tx, a); e != nil {
			return nil, e
		}
		r, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE message_id=$1 AND room_id=$2 FOR UPDATE", message, room)
		if e != nil {
			return nil, e
		}
		if r == nil || str(r, "subject_id") != ref {
			return nil, fail("chat_access_denied", 403)
		}
		var shared bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM room_shared_summaries WHERE room_id=$1 AND subject_id=$2 AND share_id=$3 AND notice_hash=$4)", room, ref, r["client_message_id"], r["payload_hash"]).Scan(&shared); e != nil {
			return nil, e
		}
		if shared {
			return nil, fail("chat_shared_summary_use_new_version")
		}
		old, e := row(ctx, tx, "SELECT to_jsonb(o) FROM chat_message_operations o WHERE operation_id=$1", x["operationId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			if str(old, "message_id") != message || str(old, "subject_id") != ref || str(old, "kind") != "edit" || str(old, "request_hash") != canonical(x) {
				return nil, fail("chat_operation_conflict")
			}
			if str(old, "state") == "cancelled" {
				return nil, fail("chat_message_unavailable")
			}
			return old, nil
		}
		if e = assertTarget(c.Governance, "sending-paused"); e != nil {
			return nil, e
		}
		if str(r, "state") != "accepted" || millis(r["expires_at"]) <= s.now().UnixMilli() {
			return nil, fail("chat_message_unavailable")
		}
		if has([]string{"archived", "owner-succession"}, str(c.Room, "state")) {
			return nil, fail("chat_room_read_only")
		}
		sent, _ := time.Parse(time.RFC3339Nano, str(r, "sent_at"))
		if s.now().Sub(sent) > 24*time.Hour {
			return nil, fail("chat_edit_window_closed_use_correction")
		}
		if num(r, "revision") != num(x, "expectedRevision") {
			return nil, fail("chat_revision_conflict")
		}
		var pending bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM chat_message_operations WHERE message_id=$1 AND state='pending')", message).Scan(&pending); e != nil {
			return nil, e
		}
		if pending {
			return nil, fail("chat_edit_pending_reconcile_first")
		}
		var attachments int64
		if e = tx.QueryRow(ctx, "SELECT count(*) FROM chat_attachments WHERE message_id=$1", message).Scan(&attachments); e != nil {
			return nil, e
		}
		if e = s.rule(ctx, tx, a, x, str(x, "operationId"), "prepare", attachments); e != nil {
			return nil, e
		}
		result := Object{"messageId": message, "revision": num(r, "revision") + 1, "editedAt": stamp(s.now())}
		bytes := len([]byte(str(x, "text")))
		if _, e = tx.Exec(ctx, "UPDATE chat_message_refs SET content_bytes=GREATEST(content_bytes,$2) WHERE message_id=$1", message, bytes); e != nil {
			return nil, e
		}
		return row(ctx, tx, `INSERT INTO chat_message_operations(operation_id,room_id,message_id,subject_id,kind,request_hash,result,created_at,state,previous_content_bytes,target_content_bytes,base_revision) VALUES($1,$2,$3,$4,'edit',$5,$6,$7,'pending',$8,$9,$10) RETURNING to_jsonb(chat_message_operations)`, x["operationId"], room, message, ref, canonical(x), encode(result), s.now(), num(r, "content_bytes"), bytes, num(r, "revision"))
	})
	if e != nil {
		return nil, e
	}
	if str(reservation, "state") == "complete" {
		return obj(reservation, "result"), nil
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, true)
		if e != nil {
			return nil, e
		}
		if _, e = s.requireAccount(ctx, tx, a); e != nil {
			return nil, e
		}
		r, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE message_id=$1 FOR UPDATE", message)
		if e != nil {
			return nil, e
		}
		op, e := row(ctx, tx, "SELECT to_jsonb(o) FROM chat_message_operations o WHERE operation_id=$1 FOR UPDATE", x["operationId"])
		if e != nil {
			return nil, e
		}
		if str(op, "state") == "complete" {
			return obj(op, "result"), nil
		}
		if e = assertTarget(c.Governance, "sending-paused"); e != nil {
			return nil, e
		}
		if str(op, "state") != "pending" || str(r, "state") != "accepted" || millis(r["expires_at"]) <= s.now().UnixMilli() {
			return nil, fail("chat_message_unavailable")
		}
		if has([]string{"archived", "owner-succession"}, str(c.Room, "state")) {
			return nil, fail("chat_room_read_only")
		}
		if num(r, "revision") != num(op, "base_revision") {
			return nil, fail("chat_revision_conflict")
		}
		if e = s.project(ctx, c); e != nil {
			return nil, e
		}
		var attachments int64
		if e = tx.QueryRow(ctx, "SELECT count(*) FROM chat_attachments WHERE message_id=$1", message).Scan(&attachments); e != nil {
			return nil, e
		}
		if e = s.rule(ctx, tx, a, x, str(x, "operationId"), "write", attachments); e != nil {
			return nil, e
		}
		ack, e := s.command(ctx, "edit", Object{"roomId": room, "messageId": message, "subjectId": ref, "operationId": x["operationId"], "text": x["text"], "expectedRevision": r["revision"], "roomRevision": c.Room["revision"]})
		if e != nil {
			return nil, e
		}
		if ack["revision"] != nil && num(ack, "revision") != num(r, "revision")+1 {
			return nil, fail("chat_archive_receipt_invalid", 502)
		}
		result := obj(op, "result")
		if _, e = tx.Exec(ctx, "UPDATE chat_message_refs SET revision=revision+1,edited_at=$2,content_bytes=$3 WHERE message_id=$1", message, result["editedAt"], num(op, "target_content_bytes")); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE chat_message_operations SET state='complete' WHERE operation_id=$1", x["operationId"]); e != nil {
			return nil, e
		}
		return result, nil
	})
}
func (s *Service) OperationStatus(ctx context.Context, a Actor, room string, raw []byte) (Object, error) {
	if !validID(room) {
		return nil, fail("invalid_chat_request", 400)
	}
	x, e := parse(raw, "operationId", "requestHash")
	if e != nil {
		return nil, e
	}
	if !validID(str(x, "operationId")) || !hashPattern.MatchString(str(x, "requestHash")) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		ref, _ := actorRef(a)
		o, e := row(ctx, tx, "SELECT to_jsonb(o) FROM chat_message_operations o WHERE room_id=$1 AND operation_id=$2 AND subject_id=$3 AND kind='edit'", room, x["operationId"], ref)
		if e != nil {
			return nil, e
		}
		out := Object{"roomId": room, "operationId": x["operationId"], "requestHash": x["requestHash"], "currentAccessGranted": false, "contentReturned": false, "state": "absent"}
		if o == nil {
			return out, nil
		}
		if o["request_hash"] != x["requestHash"] {
			out["state"] = "conflict"
			return out, nil
		}
		out["state"] = o["state"]
		out["messageId"] = o["message_id"]
		if str(o, "state") == "complete" {
			out["state"] = "acknowledged"
			out["revision"] = obj(o, "result")["revision"]
			out["editedAt"] = iso(obj(o, "result")["editedAt"])
		}
		return out, nil
	})
}

// PurgeOne is an archive lifecycle consumer, never an end-user HTTP route.
func (s *Service) PurgeOne(ctx context.Context, message string) error {
	if !validID(message) {
		return fail("invalid_chat_request", 400)
	}
	var r Object
	var raw []byte
	e := s.Pool.QueryRow(ctx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE message_id=$1 AND purge_pending=true", message).Scan(&raw)
	if e == pgx.ErrNoRows {
		return nil
	}
	if e != nil {
		return e
	}
	if e = protocol.Decode(raw, &r); e != nil {
		return e
	}
	ack, e := s.command(ctx, "erase", Object{"roomId": r["room_id"], "messageId": message})
	if e != nil {
		return e
	}
	if !truth(ack, "archiveDeleted") {
		return fail("chat_archive_receipt_invalid", 502)
	}
	_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := tx.Exec(ctx, "UPDATE chat_message_refs SET purge_pending=false,content_bytes=0 WHERE message_id=$1 AND state IN ('retracted','expired')", message); e != nil {
			return nil, e
		}
		_, e := tx.Exec(ctx, "UPDATE chat_message_operations SET state='cancelled' WHERE message_id=$1 AND state='pending'", message)
		return Object{}, e
	})
	return e
}
func (s *Service) Retract(ctx context.Context, a Actor, room, message string) (Object, error) {
	if !validID(message) {
		return nil, fail("invalid_chat_request", 400)
	}
	_, e := s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		if _, e := s.requireRoom(ctx, tx, a, room, true, true); e != nil {
			return nil, e
		}
		r, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE message_id=$1 AND room_id=$2 FOR UPDATE", message, room)
		if e != nil {
			return nil, e
		}
		ref, _ := actorRef(a)
		if r == nil || str(r, "subject_id") != ref {
			return nil, fail("chat_access_denied", 403)
		}
		if str(r, "state") == "expired" {
			return nil, fail("chat_message_unavailable")
		}
		_, e = tx.Exec(ctx, "UPDATE chat_message_refs SET state='retracted',purge_pending=true,retracted_at=COALESCE(retracted_at,$2) WHERE message_id=$1", message, s.now())
		return Object{}, e
	})
	if e != nil {
		return nil, e
	}
	e = s.PurgeOne(ctx, message)
	if e != nil {
		if fault.Code(e) == "internal_error" {
			return nil, e
		}
		return Object{"messageId": message, "retracted": true, "archiveDeleted": false, "purgePending": true}, nil
	}
	return Object{"messageId": message, "retracted": true, "archiveDeleted": true}, nil
}
