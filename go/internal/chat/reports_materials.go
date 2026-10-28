package chat

import (
	"context"
	"github.com/jackc/pgx/v5"
	"strings"
)

func (s *ReportService) reportAuthor(ctx context.Context, tx pgx.Tx, ref string) (Object, error) {
	out := Object{"authorAccountId": nil, "authorDisplayName": nil, "authorUid": nil}
	if !strings.HasPrefix(ref, "account:") {
		return out, nil
	}
	r, e := row(ctx, tx, "SELECT jsonb_build_object('id',a.id,'uid',a.uid,'display_name',p.display_name) FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2", ref[8:], s.Chat.Endpoint)
	if e != nil {
		return nil, e
	}
	if r != nil {
		out["authorAccountId"], out["authorDisplayName"], out["authorUid"] = r["id"], r["display_name"], r["uid"]
	}
	return out, nil
}
func (s *ReportService) reportSource(ctx context.Context, tx pgx.Tx, a Actor, room string, ids []string, write bool) (roomContext, Object, error) {
	c, e := s.Chat.requireRoom(ctx, tx, a, room, true, write)
	if e != nil {
		return c, nil, e
	}
	if len(ids) == 0 {
		return c, Object{"messages": []Object{}, "readExpiresAt": s.Chat.now().Unix() + 60}, nil
	}
	rr, e := s.Chat.messageRows(ctx, tx, a, room, "m.message_id=ANY($3::uuid[])", []any{ids}, "m.sequence ASC", 0)
	if e != nil {
		return c, nil, e
	}
	out, e := s.Chat.readMessages(ctx, tx, a, c, rr, Object{})
	if e != nil {
		return c, nil, e
	}
	mm := reportObjects(out["messages"])
	for _, id := range ids {
		found := false
		for _, m := range mm {
			found = found || str(m, "messageId") == id && str(m, "state") == "accepted"
		}
		if !found {
			return c, nil, fail("chat_report_source_unavailable")
		}
	}
	return c, out, nil
}
func reportObjects(v any) []Object {
	if a, ok := v.([]Object); ok {
		return a
	}
	out := []Object{}
	if a, ok := v.([]any); ok {
		for _, i := range a {
			if o, ok := i.(map[string]any); ok {
				out = append(out, o)
			}
		}
	}
	return out
}
func (s *ReportService) Source(ctx context.Context, a Actor, x Object) (Object, error) {
	if !strict(x, "roomId", "messageIds") || !reportID(x, "roomId") {
		return nil, reportInvalid()
	}
	if _, ok := x["messageIds"]; !ok {
		x["messageIds"] = []any{}
	}
	ids := reportStrings(x["messageIds"])
	raw, ok := x["messageIds"].([]any)
	if !ok || len(raw) != len(ids) || len(ids) > 20 {
		return nil, reportInvalid()
	}
	for _, id := range ids {
		if !reportUUID.MatchString(id) {
			return nil, reportInvalid()
		}
	}
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		c, v, e := s.reportSource(ctx, tx, a, str(x, "roomId"), ids, false)
		if e != nil {
			return nil, e
		}
		authors := []Object{}
		for _, m := range c.Members {
			authors = append(authors, Object{"authorRef": m["subject_id"], "authorDisplayName": m["display_name"], "authorUid": m["uid"]})
		}
		messages := []Object{}
		for _, m := range reportObjects(v["messages"]) {
			author, e := s.reportAuthor(ctx, tx, str(m, "subjectId"))
			if e != nil {
				return nil, e
			}
			files := []Object{}
			for _, f := range reportObjects(m["attachments"]) {
				if str(f, "state") == "available" {
					files = append(files, Object{"attachmentId": f["attachmentId"], "name": f["name"], "mediaType": f["mediaType"], "size": f["size"], "expiresAt": f["expiresAt"], "state": "available"})
				}
			}
			messages = append(messages, Object{"messageId": m["messageId"], "revision": m["revision"], "authorRef": m["subjectId"], "authorDisplayName": author["authorDisplayName"], "authorUid": author["authorUid"], "sentAt": m["sentAt"], "expiresAt": m["expiresAt"], "text": m["text"], "attachments": files})
		}
		return Object{"roomId": x["roomId"], "roomVersion": c.Room["revision"], "title": c.Room["title"], "readExpiresAt": v["readExpiresAt"], "authors": authors, "messages": messages}, nil
	})
}
func (s *ReportService) captureReports(ctx context.Context, tx pgx.Tx, a Actor, room string, selections []Object) ([]Object, error) {
	out := []Object{}
	if len(selections) == 0 {
		return out, nil
	}
	ids := []string{}
	for _, v := range selections {
		ids = append(ids, str(v, "messageId"))
	}
	_, v, e := s.reportSource(ctx, tx, a, room, ids, true)
	if e != nil {
		return nil, e
	}
	for _, selected := range selections {
		var m Object
		for _, candidate := range reportObjects(v["messages"]) {
			if candidate["messageId"] == selected["messageId"] {
				m = candidate
				break
			}
		}
		if m == nil || num(m, "revision") != num(selected, "revision") {
			return nil, fail("chat_report_source_changed")
		}
		files := []Object{}
		for _, id := range reportStrings(selected["attachmentIds"]) {
			var file Object
			for _, f := range reportObjects(m["attachments"]) {
				if str(f, "attachmentId") == id && str(f, "state") == "available" {
					file = f
					break
				}
			}
			if file == nil || s.Attachments == nil {
				return nil, fail("chat_report_attachment_unavailable")
			}
			r, e := s.Attachments.row(ctx, tx, id, false)
			if e != nil {
				return nil, e
			}
			if r == nil || str(r, "room_id") != room || str(r, "message_id") != str(m, "messageId") {
				return nil, fail("chat_report_attachment_unavailable")
			}
			if e = s.Attachments.readable(ctx, tx, a, r, false); e != nil {
				return nil, e
			}
			files = append(files, Object{"attachmentId": id, "name": file["name"], "mediaType": file["mediaType"], "size": file["size"], "expiresAt": file["expiresAt"]})
		}
		out = append(out, Object{"messageId": m["messageId"], "revision": m["revision"], "roomId": room, "authorRef": m["subjectId"], "sentAt": m["sentAt"], "sourceExpiresAt": m["expiresAt"], "text": m["text"], "attachments": files})
	}
	current, e := s.Chat.messageRows(ctx, tx, a, room, "m.message_id=ANY($3::uuid[])", []any{ids}, "m.sequence ASC", 0)
	if e != nil {
		return nil, e
	}
	for _, selected := range out {
		found := false
		for _, r := range current {
			found = found || s.Chat.visible(r) && r["message_id"] == selected["messageId"] && str(r, "state") == "accepted" && num(r, "revision") == num(selected, "revision")
		}
		if !found {
			return nil, fail("chat_report_source_changed")
		}
	}
	return out, nil
}
func (s *ReportService) saveReportMaterials(ctx context.Context, tx pgx.Tx, r Object, event string, materials []Object) error {
	var n int64
	if e := tx.QueryRow(ctx, "SELECT count(*) FROM account_chat_governance_materials_v1 WHERE report_id=$1 AND erased_at IS NULL", r["id"]).Scan(&n); e != nil {
		return e
	}
	if n+int64(len(materials)) > 20 {
		return fail("chat_report_material_limit")
	}
	for _, m := range materials {
		if _, e := tx.Exec(ctx, `INSERT INTO account_chat_governance_materials_v1(report_id,event_id,message_id,revision,room_id,author_ref,sent_at,source_expires_at,text,attachments) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, r["id"], event, m["messageId"], m["revision"], m["roomId"], m["authorRef"], reportDate(m["sentAt"]), reportDate(m["sourceExpiresAt"]), m["text"], encode(m["attachments"])); e != nil {
			return e
		}
	}
	return nil
}
func (s *ReportService) reportSourceAvailable(ctx context.Context, tx pgx.Tx, m Object) (bool, error) {
	if m["erased_at"] != nil || millis(m["source_expires_at"]) <= s.Chat.now().UnixMilli() {
		return false, nil
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE message_id=$1 AND room_id=$2 FOR SHARE", m["message_id"], m["room_id"])
	if e != nil {
		return false, e
	}
	if r == nil || str(r, "state") != "accepted" || num(r, "revision") != num(m, "revision") || millis(r["expires_at"]) <= s.Chat.now().UnixMilli() {
		return false, nil
	}
	var pending bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))", m["author_ref"]).Scan(&pending)
	return !pending, e
}
