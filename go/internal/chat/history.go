package chat

import (
	"context"
	"github.com/jackc/pgx/v5"
	"math/big"
	"strconv"
	"strings"
)

func (s *Service) messageRows(ctx context.Context, tx pgx.Tx, a Actor, room, condition string, args []any, order string, limit int64) ([]Object, error) {
	ref, _ := actorRef(a)
	return s.messageRowsRef(ctx, tx, ref, room, condition, args, order, limit)
}
func (s *Service) messageRowsRef(ctx context.Context, tx pgx.Tx, ref, room, condition string, args []any, order string, limit int64) ([]Object, error) {
	values := []any{room, ref}
	values = append(values, args...)
	tail := ""
	if limit > 0 {
		values = append(values, limit)
		tail = " LIMIT $" + strconv.Itoa(len(values))
	}
	return rows(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT m.*,m.sequence::text AS sequence,m.accepted_order::text AS accepted_order,COALESCE(p.hidden,false) AS personally_hidden,`+operationsBlocked+` AS operationally_hidden,(m.subject_id<>$2 AND EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))) AS author_quarantined,(SELECT s.share_id FROM room_shared_summaries s WHERE s.room_id=m.room_id AND s.subject_id=m.subject_id AND s.share_id=m.client_message_id AND s.notice_hash=m.payload_hash) AS shared_summary_id FROM chat_message_refs m LEFT JOIN chat_message_preferences p ON p.message_id=m.message_id AND p.subject_id=$2 WHERE m.room_id=$1 AND `+condition+` ORDER BY `+order+tail+`)q`, values...)
}
func (s *Service) visible(r Object) bool {
	return !truth(r, "personally_hidden") && !truth(r, "operationally_hidden") && !truth(r, "author_quarantined") && (str(r, "state") == "accepted" || str(r, "state") == "retracted") && millis(r["expires_at"]) > s.now().UnixMilli()
}
func (s *Service) readMessages(ctx context.Context, tx pgx.Tx, a Actor, c roomContext, page []Object, x Object, projected ...bool) (Object, error) {
	visible := []Object{}
	ids := []string{}
	selected := []string{}
	for _, r := range page {
		selected = append(selected, str(r, "message_id"))
		if !s.visible(r) || x["author"] != nil && r["subject_id"] != x["author"] || x["from"] != nil && millis(r["sent_at"]) < millis(x["from"]) || x["to"] != nil && millis(r["sent_at"]) > millis(x["to"]) {
			continue
		}
		visible = append(visible, r)
		if str(r, "state") == "accepted" {
			ids = append(ids, str(r, "archive_id"))
		}
	}
	bodies := map[string]Object{}
	if len(ids) > 0 {
		if e := func() error {
			if len(projected) > 0 && projected[0] {
				return nil
			}
			return s.project(ctx, c)
		}(); e != nil {
			return nil, e
		}
		ref, _ := actorRef(a)
		result, e := s.command(ctx, "read", Object{"roomId": c.Room["room_id"], "subjectId": ref, "ids": ids, "roomRevision": c.Room["revision"]})
		if e != nil {
			return nil, e
		}
		items, ok := result["messages"].([]any)
		if !ok {
			return nil, fail("chat_transport_invalid_reply", 502)
		}
		for _, item := range items {
			body, ok := item.(map[string]any)
			if !ok {
				return nil, fail("chat_transport_invalid_reply", 502)
			}
			bodies[str(body, "archiveId")] = body
		}
	}
	current := map[string]Object{}
	if len(selected) > 0 {
		rr, e := s.messageRows(ctx, tx, a, str(c.Room, "room_id"), "m.message_id=ANY($3::uuid[])", []any{selected}, "m.sequence ASC", 0)
		if e != nil {
			return nil, e
		}
		for _, r := range rr {
			if s.visible(r) {
				current[str(r, "message_id")] = r
			}
		}
	}
	messages := []Object{}
	expires := s.now().Unix() + 60
	for _, previous := range visible {
		r := current[str(previous, "message_id")]
		if r == nil {
			continue
		}
		body := bodies[str(r, "archive_id")]
		if str(r, "state") == "accepted" && body == nil {
			continue
		}
		if body != nil && body["revision"] != nil && num(body, "revision") != num(r, "revision") {
			return nil, fail("chat_message_reconciliation_required")
		}
		if keyword := str(x, "keyword"); keyword != "" && (body == nil || !strings.Contains(strings.ToLower(str(body, "text")), strings.ToLower(keyword))) {
			continue
		}
		out := s.receipt(r)
		for k, v := range (Object{"sequence": r["sequence"], "acceptedOrder": r["accepted_order"], "subjectId": r["subject_id"], "actor": actorView(str(r, "subject_id")), "actorKind": r["actor_kind"], "agentGrantId": r["agent_grant_id"], "replyTo": r["reply_to"], "text": nil, "sharedSummaryId": nil, "editedAt": iso(r["edited_at"]), "retractedAt": iso(r["retracted_at"])}) {
			out[k] = v
		}
		if str(r, "state") == "accepted" {
			out["text"] = body["text"]
			out["sharedSummaryId"] = r["shared_summary_id"]
		}
		messages = append(messages, out)
		if sec(r["expires_at"]) < expires {
			expires = sec(r["expires_at"])
		}
	}
	if len(messages) > 0 {
		checkIDs := []string{}
		for _, m := range messages {
			checkIDs = append(checkIDs, str(m, "messageId"))
		}
		if s.Attachments != nil {
			files, e := s.Attachments.ForMessagesWithin(ctx, tx, a, checkIDs)
			if e != nil {
				return nil, e
			}
			for _, m := range messages {
				if list, ok := files[str(m, "messageId")]; ok {
					m["attachments"] = list
				}
			}
		} else {
			var count int
			if e := tx.QueryRow(ctx, "SELECT count(*) FROM chat_attachments WHERE message_id=ANY($1::uuid[])", checkIDs).Scan(&count); e != nil {
				return nil, e
			}
			if count > 0 {
				return nil, fail("attachment_service_unavailable", 503)
			}
		}
		blocked, e := rows(ctx, tx, "SELECT jsonb_build_object('message_id',m.message_id) FROM chat_message_refs m WHERE m.message_id=ANY($1::uuid[]) AND "+operationsBlocked, checkIDs)
		if e != nil {
			return nil, e
		}
		excluded := map[string]bool{}
		for _, r := range blocked {
			excluded[str(r, "message_id")] = true
		}
		permitted := []Object{}
		for _, m := range messages {
			if !excluded[str(m, "messageId")] {
				permitted = append(permitted, m)
			}
		}
		messages = permitted
	}
	return Object{"messages": messages, "readExpiresAt": expires}, nil
}
func decrement(s string) string {
	n, _ := new(big.Int).SetString(s, 10)
	if n == nil {
		return "0"
	}
	return n.Sub(n, big.NewInt(1)).String()
}
func (s *Service) History(ctx context.Context, a Actor, room string, raw []byte) (Object, error) {
	x, e := parseHistory(raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, false)
		if e != nil {
			return nil, e
		}
		if e = s.agent(ctx, tx, a, room, str(x, "agentGrantId"), false); e != nil {
			return nil, e
		}
		condition, order, cursor := "m.sequence>$3::bigint", "m.sequence ASC", str(x, "after")
		if truth(x, "latest") {
			condition = "($3::bigint=0 OR m.sequence<$3::bigint)"
			order = "m.sequence DESC"
			cursor = str(x, "before")
			if cursor == "" {
				cursor = "0"
			}
		}
		rr, e := s.messageRows(ctx, tx, a, room, condition, []any{cursor}, order, num(x, "limit")+1)
		if e != nil {
			return nil, e
		}
		page := rr
		if int64(len(page)) > num(x, "limit") {
			page = page[:num(x, "limit")]
		}
		if truth(x, "latest") {
			for i, j := 0, len(page)-1; i < j; i, j = i+1, j-1 {
				page[i], page[j] = page[j], page[i]
			}
		}
		result, e := s.readMessages(ctx, tx, a, c, page, x)
		if e != nil {
			return nil, e
		}
		result["next"] = nil
		result["complete"] = int64(len(rr)) <= num(x, "limit")
		result["scannedThrough"] = x["after"]
		if len(page) > 0 {
			result["scannedThrough"] = page[len(page)-1]["sequence"]
		}
		if truth(x, "latest") {
			result["previous"] = nil
			result["after"] = "0"
			result["scannedThrough"] = "0"
			if len(page) > 0 {
				result["after"] = decrement(str(page[0], "sequence"))
				result["scannedThrough"] = page[len(page)-1]["sequence"]
				if !truth(result, "complete") {
					result["previous"] = page[0]["sequence"]
				}
			}
		} else if !truth(result, "complete") {
			result["next"] = page[len(page)-1]["sequence"]
		}
		return result, nil
	})
}
