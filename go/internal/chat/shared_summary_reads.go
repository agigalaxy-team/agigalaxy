package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (f *SharedSummaryService) Receipt(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := sharedInput(raw, false, true)
	if e != nil {
		return nil, e
	}
	return f.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		base := Object{"roomId": x["roomId"], "shareId": x["shareId"], "requestHash": x["requestHash"], "checkedAt": stamp(f.Chat.now()), "currentAccessGranted": false, "contentReturned": false, "acceptedByRoom": false, "othersReadStatus": "not-asserted"}
		r, e := row(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT s.share_id,s.room_id,s.request_hash,s.notice_hash,s.state,s.message_id,s.expires_at,s.retracted_at,m.message_id AS notice_message_id,m.payload_hash AS notice_payload_hash,m.state AS notice_state,m.archive_id,m.expires_at AS notice_expires_at,m.purge_pending FROM room_shared_summaries s LEFT JOIN chat_message_refs m ON m.room_id=s.room_id AND m.subject_id=s.subject_id AND m.client_message_id=s.share_id WHERE s.share_id=$1 AND s.subject_id=$2)q`, x["shareId"], a.Device.SubjectID)
		if e != nil {
			return nil, e
		}
		if r == nil {
			base["state"] = "absent"
			return base, nil
		}
		if r["room_id"] != x["roomId"] || r["request_hash"] != x["requestHash"] || r["notice_message_id"] != nil && r["notice_payload_hash"] != r["notice_hash"] {
			base["state"] = "conflict"
			return base, nil
		}
		expired := millis(r["expires_at"]) <= f.Chat.now().UnixMilli() || r["notice_message_id"] != nil && millis(r["notice_expires_at"]) <= f.Chat.now().UnixMilli()
		state := "pending"
		if expired || str(r, "state") == "expired" {
			state = "expired"
		} else if str(r, "state") == "retracted" || str(r, "notice_state") == "retracted" {
			state = "retracted"
		} else if str(r, "notice_state") == "accepted" {
			state = "published"
		}
		messageState, cleanup := "not-found", "not-recorded"
		messageID := r["message_id"]
		if r["notice_message_id"] != nil {
			messageID = r["notice_message_id"]
			messageState = str(r, "notice_state")
			if millis(r["notice_expires_at"]) <= f.Chat.now().UnixMilli() {
				messageState = "expired"
			}
			cleanup = "not-requested"
			if truth(r, "purge_pending") {
				cleanup = "pending"
			} else if has([]string{"retracted", "expired"}, str(r, "notice_state")) {
				cleanup = "recorded-complete"
			}
		}
		base["state"], base["messageId"], base["messageState"], base["acceptedByRoom"] = state, messageID, messageState, state == "published"
		base["historicalAcceptanceRecorded"] = r["archive_id"] != nil
		base["summaryContentHidden"] = has([]string{"retracted", "expired"}, state)
		base["noticeRetractionRecorded"] = str(r, "notice_state") == "retracted"
		base["noticeCleanupState"] = cleanup
		base["archiveScope"] = "shared-summary-notice-only"
		return base, nil
	})
}
func sharedPage(raw []byte) (Object, error) {
	x, e := parse(raw, "roomId", "after", "limit")
	if e != nil || !validID(str(x, "roomId")) {
		return nil, sharedError()
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = int64(20)
	}
	if !normalizeInteger(x, "limit", 1, 50) {
		return nil, sharedError()
	}
	if v, ok := x["after"]; ok && !validID(asString(v)) {
		return nil, sharedError()
	}
	return x, nil
}
func (f *SharedSummaryService) List(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := sharedPage(raw)
	if e != nil {
		return nil, e
	}
	return f.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		if _, e := f.Chat.requireRoom(ctx, tx, a, str(x, "roomId"), true, false); e != nil {
			return nil, e
		}
		rr, e := rows(ctx, tx, "SELECT to_jsonb(s) FROM room_shared_summaries s WHERE room_id=$1 AND ($2::uuid IS NULL OR share_id>$2) ORDER BY share_id LIMIT $3 FOR UPDATE", x["roomId"], x["after"], num(x, "limit")+1)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for i, r := range rr {
			if int64(i) >= num(x, "limit") {
				break
			}
			view, e := f.view(ctx, tx, a, r)
			if e != nil {
				if fault.Status(e) == 403 || fault.Status(e) == 404 {
					continue
				}
				return nil, e
			}
			items = append(items, view)
		}
		var next any
		if int64(len(rr)) > num(x, "limit") {
			next = rr[num(x, "limit")-1]["share_id"]
		}
		return Object{"items": items, "nextAfter": next, "historyRemainsAvailable": true}, nil
	})
}
func (f *SharedSummaryService) Retract(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := sharedInput(raw, false, false)
	if e != nil {
		return nil, e
	}
	r, e := f.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		prior, e := row(ctx, tx, "SELECT jsonb_build_object('state',state) FROM room_shared_summaries WHERE room_id=$1 AND share_id=$2 AND subject_id=$3", x["roomId"], x["shareId"], a.Device.SubjectID)
		if e != nil {
			return nil, e
		}
		if prior == nil {
			return nil, fail("shared_summary_author_required", 403)
		}
		if str(prior, "state") != "retracted" {
			if _, e = f.Chat.requireRoom(ctx, tx, a, str(x, "roomId"), true, true); e != nil {
				return nil, e
			}
		}
		r, e := f.row(ctx, tx, str(x, "roomId"), str(x, "shareId"))
		if e != nil {
			return nil, e
		}
		if str(r, "subject_id") != a.Device.SubjectID {
			return nil, fail("shared_summary_author_required", 403)
		}
		if _, e = tx.Exec(ctx, "UPDATE room_shared_summaries SET state='retracted',content='{}'::jsonb,source_facts='[]'::jsonb,retracted_at=COALESCE(retracted_at,$2) WHERE share_id=$1", x["shareId"], f.Chat.now()); e != nil {
			return nil, e
		}
		return r, nil
	})
	if e != nil {
		return nil, e
	}
	message, e := f.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		owned, e := row(ctx, tx, "SELECT jsonb_build_object('message_id',message_id,'payload_hash',payload_hash,'state',state,'purge_pending',purge_pending) FROM chat_message_refs WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3 FOR UPDATE", x["roomId"], a.Device.SubjectID, x["shareId"])
		if e != nil {
			return nil, e
		}
		if owned == nil {
			return Object{}, nil
		}
		if owned["payload_hash"] != r["notice_hash"] {
			return nil, fail("shared_summary_message_conflict")
		}
		if has([]string{"accepted", "pending"}, str(owned, "state")) {
			if _, e = tx.Exec(ctx, "UPDATE chat_message_refs SET state='retracted',purge_pending=true,retracted_at=COALESCE(retracted_at,$2) WHERE message_id=$1", owned["message_id"], f.Chat.now()); e != nil {
				return nil, e
			}
			owned["state"], owned["purge_pending"] = "retracted", true
		}
		return owned, nil
	})
	if e != nil {
		return nil, e
	}
	archiveDeleted, cleanupPending := false, truth(message, "purge_pending")
	if len(message) > 0 && has([]string{"retracted", "expired"}, str(message, "state")) {
		if !truth(message, "purge_pending") {
			archiveDeleted = true
		} else if e = f.Chat.PurgeOne(ctx, str(message, "message_id")); e == nil {
			archiveDeleted, cleanupPending = true, false
		} else if fault.Code(e) == "internal_error" {
			return nil, e
		}
	}
	id := r["message_id"]
	if message["message_id"] != nil {
		id = message["message_id"]
	}
	return Object{"shareId": x["shareId"], "retracted": true, "personalVersionDeleted": false, "messageId": id, "noticeRetractionRecorded": str(message, "state") == "retracted", "noticeArchiveDeleted": archiveDeleted, "noticeCleanupPending": cleanupPending, "archiveScope": "shared-summary-notice-only"}, nil
}
func (f *SharedSummaryService) ExportOwnedWithin(ctx context.Context, tx pgx.Tx, a Actor, after string, limit int) (Object, error) {
	if a.Device == nil {
		return nil, fail("access_denied", 401)
	}
	if after != "" && !validID(after) || limit < 1 || limit > 100 {
		return nil, sharedError()
	}
	rr, e := rows(ctx, tx, "SELECT jsonb_build_object('share_id',share_id,'room_id',room_id) FROM room_shared_summaries WHERE subject_id=$1 AND ($2::uuid IS NULL OR share_id>$2) ORDER BY share_id LIMIT $3", a.Device.SubjectID, null(after), limit+1)
	if e != nil {
		return nil, e
	}
	items := []Object{}
	for i, r := range rr {
		if i >= limit {
			break
		}
		view, e := func() (Object, error) {
			if _, e := f.Chat.requireRoom(ctx, tx, a, str(r, "room_id"), true, false); e != nil {
				return nil, e
			}
			current, e := f.row(ctx, tx, str(r, "room_id"), str(r, "share_id"))
			if e != nil {
				return nil, e
			}
			return f.view(ctx, tx, a, current)
		}()
		if e != nil {
			if fault.Status(e) != 403 && fault.Status(e) != 404 {
				return nil, e
			}
			view = Object{"shareId": r["share_id"], "roomId": r["room_id"], "content": nil, "reason": "current_room_permission_required"}
		}
		items = append(items, view)
	}
	var next any
	if len(rr) > limit {
		next = rr[limit-1]["share_id"]
	}
	return Object{"items": items, "nextAfter": next, "scope": "own-shares-with-current-source-permission"}, nil
}
func (f *SharedSummaryService) EraseSubjectWithin(ctx context.Context, tx pgx.Tx, subject string) (Object, error) {
	tag, e := tx.Exec(ctx, "UPDATE room_shared_summaries SET state='retracted',content='{}'::jsonb,source_facts='[]'::jsonb,retracted_at=COALESCE(retracted_at,$2) WHERE subject_id=$1 AND state IN ('pending','published')", subject, f.Chat.now())
	return Object{"erasedShares": tag.RowsAffected(), "remainingMetadata": true, "noticeDeletionDelegatedToChat": true}, e
}
