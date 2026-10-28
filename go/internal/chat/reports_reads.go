package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

var reportDecisions = []string{"review", "pause", "resume", "resolve", "message-hide", "message-restore", "message-keep"}

func (s *ReportService) caseMessageBlocked(ctx context.Context, tx pgx.Tx, id string) (bool, error) {
	var b bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operations_chat_message_visibility_v1 WHERE endpoint=$1 AND report_id=$2 AND hidden)", s.Chat.Endpoint, id).Scan(&b)
	return b, e
}
func (s *ReportService) reportMaterialsView(ctx context.Context, tx pgx.Tx, r, c Object) ([]Object, error) {
	out := []Object{}
	if s.expiredReport(r) || !(truth(c, "reporter") || truth(c, "operator") && truth(c, "independent") && truth(c, "canReadMaterials")) {
		return out, nil
	}
	mm, e := rows(ctx, tx, "SELECT to_jsonb(m) FROM account_chat_governance_materials_v1 m WHERE report_id=$1 ORDER BY event_id,sent_at,message_id", r["id"])
	if e != nil {
		return nil, e
	}
	for _, m := range mm {
		available, e := s.reportSourceAvailable(ctx, tx, m)
		if e != nil {
			return nil, e
		}
		files := []Object{}
		if available {
			for _, v := range reportObjects(m["attachments"]) {
				var file Object
				if s.Attachments != nil {
					file, e = s.Attachments.row(ctx, tx, str(v, "attachmentId"), false)
					if e != nil {
						return nil, e
					}
				}
				readable := (!truth(c, "operator") || truth(c, "canReadAttachments")) && file != nil && file["room_id"] == m["room_id"] && file["message_id"] == m["message_id"] && s.Attachments.status(file) == "available"
				if readable {
					pending, e := s.Attachments.authorPending(ctx, tx, file)
					if e != nil {
						return nil, e
					}
					access, e := s.Attachments.access(ctx, tx, str(file, "id"))
					if e != nil {
						return nil, e
					}
					readable = !pending && !truth(access, "stopped")
				}
				if readable {
					v["state"], v["contentAvailable"] = "available", true
					files = append(files, v)
				} else {
					files = append(files, Object{"attachmentId": v["attachmentId"], "state": "unavailable", "contentAvailable": false})
				}
			}
		}
		author := Object{"authorAccountId": nil, "authorDisplayName": nil, "authorUid": nil}
		var text any
		state := "unavailable"
		if available {
			author, e = s.reportAuthor(ctx, tx, str(m, "author_ref"))
			if e != nil {
				return nil, e
			}
			text = m["text"]
			state = "available"
		}
		moderation, e := s.reportMessageView(ctx, tx, r, c, m, available)
		if e != nil {
			return nil, e
		}
		v := Object{"eventId": m["event_id"], "messageId": m["message_id"], "revision": m["revision"], "roomId": m["room_id"], "authorRef": m["author_ref"], "sentAt": iso(m["sent_at"]), "sourceExpiresAt": iso(m["source_expires_at"]), "state": state, "text": text, "attachments": files, "sourcePath": "/app/rooms/" + str(m, "room_id") + "?message=" + str(m, "message_id"), "moderation": moderation}
		for k, value := range author {
			v[k] = value
		}
		out = append(out, v)
	}
	return out, nil
}
func (s *ReportService) reportView(ctx context.Context, tx pgx.Tx, r Object, a reportCaller, detail bool) (Object, error) {
	c, e := s.reportContext(ctx, tx, r, a)
	if e != nil {
		return nil, e
	}
	expired := s.expiredReport(r)
	target, e := s.currentReportTarget(ctx, tx, r)
	if e != nil {
		return nil, e
	}
	effective := r["restriction_until"] != nil && millis(r["restriction_until"]) > s.Chat.now().UnixMilli()
	blocked, e := s.caseMessageBlocked(ctx, tx, str(r, "id"))
	if e != nil {
		return nil, e
	}
	var n int64
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM account_chat_governance_materials_v1 WHERE report_id=$1 AND erased_at IS NULL", r["id"]).Scan(&n); e != nil {
		return nil, e
	}
	capacity := int64(20) - n
	if capacity < 0 {
		capacity = 0
	}
	var reporter, restriction any
	if truth(c, "reporter") || truth(c, "operator") && truth(c, "independent") {
		reporter = r["reporter_account_id"]
	}
	if effective {
		restriction = Object{"scopes": r["restriction_scopes"], "until": iso(r["restriction_until"]), "eventId": r["restriction_event_id"]}
	}
	handling := "recorded"
	if str(r, "state") == "received" {
		handling = "awaiting-handler"
	}
	moderate := truth(c, "canModerate")
	if a.IsOperator {
		moderate = truth(c, "canManageCase")
	}
	out := Object{"reportId": r["id"], "target": Object{"type": "room", "id": r["room_id"], "version": r["target_version"]}, "currentTarget": target, "category": r["category"], "materialCount": n, "additionalMaterialCapacity": capacity, "version": r["version"], "state": r["state"], "reporterAccountId": reporter, "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"]), "closedAt": iso(r["closed_at"]), "handling": handling, "ownRestriction": restriction, "canModerate": moderate && !expired, "canRespond": !a.IsOperator && truth(c, "party") && str(r, "state") != "withdrawn" && !expired, "canWithdraw": truth(c, "reporter") && str(r, "state") != "withdrawn" && !expired, "canAppeal": !a.IsOperator && truth(c, "party") && (str(r, "state") == "resolved" || effective || blocked) && num(r, "appeal_count") < 3 && !expired, "materialsExpired": expired, "roomHistoryGranted": false, "readExpiresAt": s.Chat.now().Unix() + 60}
	if !detail {
		return out, nil
	}
	ee, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM account_chat_governance_events_v1 e WHERE report_id=$1 ORDER BY version", r["id"])
	if e != nil {
		return nil, e
	}
	events := []Object{}
	for _, event := range ee {
		visible := !expired && event["erased_at"] == nil && (truth(c, "reporter") || a.IsOperator && truth(c, "independent") && truth(c, "canReadMaterials") || !a.IsOperator && has(reportDecisions, str(event, "kind")) || str(event, "account_id") != "" && str(event, "account_id") == a.Account.AccountID)
		var account, operator, summary any
		if visible {
			account, operator, summary = event["account_id"], event["operator_id"], event["summary"]
		}
		v := Object{"eventId": event["id"], "kind": event["kind"], "version": event["version"], "at": iso(event["created_at"]), "actorKind": event["actor_kind"], "accountId": account, "operatorId": operator, "summary": summary}
		input := obj(event, "input")
		if visible && has([]string{"pause", "resolve"}, str(event, "kind")) {
			scopes, until := input["scopes"], input["until"]
			if scopes == nil {
				scopes = obj(input, "restriction")["scopes"]
			}
			if scopes == nil {
				scopes = []any{}
			}
			if until == nil {
				until = obj(input, "restriction")["until"]
			}
			v["decision"] = Object{"rule": input["rule"], "verdict": input["verdict"], "scopes": scopes, "until": until}
		}
		if visible && has([]string{"message-hide", "message-restore", "message-keep"}, str(event, "kind")) {
			v["decision"] = Object{"message": Object{"messageId": input["messageId"], "revision": input["messageRevision"], "action": input["action"], "hidden": str(input, "action") != "restore"}}
		}
		events = append(events, v)
	}
	materials, e := s.reportMaterialsView(ctx, tx, r, c)
	if e != nil {
		return nil, e
	}
	if a.IsOperator {
		ids := []string{}
		for _, event := range events {
			if str(event, "actorKind") == "business-operator" {
				ids = append(ids, str(event, "operatorId"))
			}
		}
		for _, m := range materials {
			if str(m, "state") == "available" {
				for _, key := range []string{"initialDecision", "currentDecision"} {
					ids = append(ids, str(obj(obj(m, "moderation"), key), "operatorId"))
				}
			}
		}
		names := map[string]string{}
		if len(ids) > 0 {
			if s.NamesWithin == nil {
				return nil, fail("operations_authorization_unavailable", 503)
			}
			names, e = s.NamesWithin(ctx, tx, ids)
			if e != nil {
				return nil, e
			}
		}
		for _, event := range events {
			event["operatorDisplayName"] = nil
			if str(event, "actorKind") == "business-operator" && names[str(event, "operatorId")] != "" {
				event["operatorDisplayName"] = names[str(event, "operatorId")]
			}
		}
		for _, m := range materials {
			for _, key := range []string{"initialDecision", "currentDecision"} {
				d := obj(obj(m, "moderation"), key)
				if d != nil {
					d["operatorDisplayName"] = nil
					if str(m, "state") == "available" && names[str(d, "operatorId")] != "" {
						d["operatorDisplayName"] = names[str(d, "operatorId")]
					}
				}
			}
		}
	}
	expires := num(out, "readExpiresAt")
	for _, m := range materials {
		if str(m, "state") == "available" {
			if t := sec(m["sourceExpiresAt"]); t < expires {
				expires = t
			}
			for _, f := range reportObjects(m["attachments"]) {
				if str(f, "state") == "available" && sec(f["expiresAt"]) < expires {
					expires = sec(f["expiresAt"])
				}
			}
		}
	}
	out["events"], out["materials"], out["readExpiresAt"] = events, materials, expires
	return out, nil
}
func (s *ReportService) Get(ctx context.Context, a Actor, x Object) (Object, error) {
	if !strict(x, "reportId") || !reportID(x, "reportId") {
		return nil, reportInvalid()
	}
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		r, e := s.reportRow(ctx, tx, str(x, "reportId"), false)
		if e != nil {
			return nil, e
		}
		return s.reportView(ctx, tx, r, reportCaller{Account: a}, true)
	})
}
func (s *ReportService) Query(ctx context.Context, a Actor, x Object) (Object, error) {
	q, e := parseReportQuery(x)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		ref, _ := actorRef(a)
		rr, e := rows(ctx, tx, `SELECT to_jsonb(r) FROM account_chat_reports_v1 r WHERE endpoint=$1 AND (reporter_account_id=$2 OR party_refs @> $3::jsonb OR EXISTS(SELECT 1 FROM chat_memberships m WHERE m.room_id=r.room_id AND m.subject_id=$4 AND m.left_at IS NULL)) AND ($5::uuid IS NULL OR room_id=$5) AND ($6::text IS NULL OR state=$6) AND ($7::uuid IS NULL OR id>$7) ORDER BY id LIMIT $8`, s.Chat.Endpoint, a.AccountID, encode([]string{ref}), ref, q["roomId"], q["state"], q["after"], num(q, "limit")+1)
		if e != nil {
			return nil, e
		}
		return s.reportPage(ctx, tx, rr, reportCaller{Account: a}, int(num(q, "limit")))
	})
}
func (s *ReportService) reportPage(ctx context.Context, tx pgx.Tx, rr []Object, a reportCaller, limit int) (Object, error) {
	items := []Object{}
	for i, r := range rr {
		if i >= limit {
			break
		}
		v, e := s.reportView(ctx, tx, r, a, false)
		if e != nil {
			return nil, e
		}
		items = append(items, v)
	}
	var next any
	if len(rr) > limit {
		next = rr[limit-1]["id"]
	}
	return Object{"items": items, "nextAfter": next, "readExpiresAt": s.Chat.now().Unix() + 60}, nil
}
func (s *ReportService) OperatorGet(ctx context.Context, a operationspermissions.Actor, x Object) (Object, error) {
	if !strict(x, "reportId") || !reportID(x, "reportId") {
		return nil, reportInvalid()
	}
	return postgres.InTx(ctx, s.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		fresh, e := s.admin().Fresh(ctx, tx, a, "chat-reports.read")
		if e != nil {
			return nil, e
		}
		r, e := s.reportRow(ctx, tx, str(x, "reportId"), false)
		if e != nil {
			return nil, e
		}
		v, e := s.reportView(ctx, tx, r, reportCaller{Operator: fresh, IsOperator: true}, true)
		if e != nil {
			return nil, e
		}
		e = s.admin().Record(ctx, tx, fresh, "chat-report-read", Object{"reportId": r["id"]}, Object{"materials": len(reportObjects(v["materials"])), "canModerate": v["canModerate"]}, nil)
		return v, e
	})
}
func (s *ReportService) OperatorQuery(ctx context.Context, a operationspermissions.Actor, x Object) (Object, error) {
	q, e := parseReportQuery(x)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		fresh, e := s.admin().Fresh(ctx, tx, a, "chat-reports.read")
		if e != nil {
			return nil, e
		}
		rr, e := rows(ctx, tx, `SELECT to_jsonb(r) FROM account_chat_reports_v1 r WHERE endpoint=$1 AND ($2::uuid IS NULL OR room_id=$2) AND ($3::text IS NULL OR state=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`, s.Chat.Endpoint, q["roomId"], q["state"], q["after"], num(q, "limit")+1)
		if e != nil {
			return nil, e
		}
		out, e := s.reportPage(ctx, tx, rr, reportCaller{Operator: fresh, IsOperator: true}, int(num(q, "limit")))
		if e != nil {
			return nil, e
		}
		ids := []string{}
		for _, v := range reportObjects(out["items"]) {
			ids = append(ids, str(v, "reportId"))
		}
		selection := Object{"roomId": q["roomId"], "state": q["state"], "after": q["after"], "limit": q["limit"]}
		e = s.admin().Record(ctx, tx, fresh, "chat-reports-query", selection, Object{"reportIds": ids}, nil)
		return out, e
	})
}
