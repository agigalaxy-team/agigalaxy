package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *ReportService) reportMessageHead(ctx context.Context, tx pgx.Tx, report, message string) (Object, error) {
	return row(ctx, tx, "SELECT to_jsonb(h) FROM operations_chat_message_visibility_v1 h WHERE endpoint=$1 AND report_id=$2 AND message_id=$3", s.Chat.Endpoint, report, message)
}
func (s *ReportService) reportMessageDecision(ctx context.Context, tx pgx.Tx, report string, id any) (Object, error) {
	if id == nil {
		return nil, nil
	}
	v, e := row(ctx, tx, "SELECT to_jsonb(e) FROM account_chat_governance_events_v1 e WHERE id=$1 AND report_id=$2", id, report)
	if e != nil || v == nil {
		return nil, e
	}
	if !has([]string{"message-hide", "message-restore", "message-keep"}, str(v, "kind")) {
		return nil, nil
	}
	return Object{"eventId": v["id"], "actorKind": v["actor_kind"], "operatorId": v["operator_id"], "at": iso(v["created_at"]), "action": str(v, "kind")[8:], "sourceRevision": obj(v, "input")["messageRevision"]}, nil
}
func (s *ReportService) reportMessageView(ctx context.Context, tx pgx.Tx, r, c, m Object, available bool) (Object, error) {
	h, e := s.reportMessageHead(ctx, tx, str(r, "id"), str(m, "message_id"))
	if e != nil {
		return nil, e
	}
	var blocked bool
	if e = tx.QueryRow(ctx, "SELECT "+operationsBlocked+" FROM chat_message_refs m WHERE message_id=$1", m["message_id"]).Scan(&blocked); e == pgx.ErrNoRows {
		blocked = false
		e = nil
	}
	if e != nil {
		return nil, e
	}
	own := truth(h, "hidden")
	allowed := truth(c, "canModerate") && !s.expiredReport(r) && available
	permissions := reportStrings(c["permissions"])
	initial, e := s.reportMessageDecision(ctx, tx, str(r, "id"), h["initial_event_id"])
	if e != nil {
		return nil, e
	}
	current, e := s.reportMessageDecision(ctx, tx, str(r, "id"), h["current_event_id"])
	if e != nil {
		return nil, e
	}
	var source any
	if h != nil {
		source = h["message_revision"]
	}
	return Object{"hidden": blocked, "ownHidden": own, "revision": num(h, "revision"), "sourceRevision": source, "appliesToCurrent": h != nil && available && num(h, "message_revision") == num(m, "revision"), "canHide": allowed && has(permissions, "chat-messages.hide") && !own && num(r, "version") < 100 && has([]string{"received", "reviewing", "appealed"}, str(r, "state")), "canRestore": allowed && has(permissions, "chat-messages.restore") && own, "canKeep": allowed && has(permissions, "chat-messages.keep") && str(r, "state") != "withdrawn" && own && num(r, "version") < 100, "initialDecision": initial, "currentDecision": current}, nil
}
func parseReportMessage(x Object) (Object, error) {
	if !strict(x, "operationId", "expectedVersion", "expectedRevision", "messageRevision", "action", "summary") || !reportID(x, "operationId") || !reportPositive(x["expectedVersion"]) || !reportPositive(x["messageRevision"]) || !reportInteger(x["expectedRevision"]) || num(x, "expectedRevision") < 0 || !has([]string{"hide", "restore", "keep"}, str(x, "action")) || !reportText(x, "summary", 1600) {
		return nil, reportInvalid()
	}
	return x, nil
}
func (s *ReportService) OperatorMessageVisibility(ctx context.Context, a operationspermissions.Actor, target, x Object, authorize func() (operationspermissions.Actor, error)) (Object, error) {
	if !strict(target, "reportId", "messageId") || !reportID(target, "reportId") || !reportID(target, "messageId") {
		return nil, reportInvalid()
	}
	x, e := parseReportMessage(x)
	if e != nil {
		return nil, e
	}
	if authorize == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	kind := "message-" + str(x, "action")
	recorded := Object{}
	for k, v := range x {
		recorded[k] = v
	}
	for k, v := range target {
		recorded[k] = v
	}
	recorded["kind"] = kind
	return postgres.InTx(ctx, s.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		current := func() (operationspermissions.Actor, error) {
			fresh, e := authorize()
			if e != nil {
				return fresh, e
			}
			fresh, e = s.admin().Fresh(ctx, tx, fresh, "chat-messages."+str(x, "action"))
			if e == nil && (fresh.ID != a.ID || fresh.Endpoint != a.Endpoint) {
				e = fail("business_admin_denied", 403)
			}
			return fresh, e
		}
		fresh, e := current()
		if e != nil {
			return nil, e
		}
		if s.admin().IsDuty(fresh) {
			if e = s.dutyCase(ctx, tx, fresh, str(target, "reportId")); e != nil {
				return nil, e
			}
			selection := Object{"id": target["reportId"], "messageId": target["messageId"], "kind": kind}
			for k, v := range x {
				selection[k] = v
			}
			fresh, e = s.admin().Operation(ctx, tx, fresh, "chat-report-event", selection)
			if e != nil {
				return nil, e
			}
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912326,hashtext($1))", x["operationId"]); e != nil {
			return nil, e
		}
		r, e := s.reportRow(ctx, tx, str(target, "reportId"), true)
		if e != nil {
			return nil, e
		}
		caller := reportCaller{Operator: fresh, IsOperator: true}
		c, e := s.reportContext(ctx, tx, r, caller)
		if e != nil {
			return nil, e
		}
		if !truth(c, "canModerate") {
			return nil, fail("chat_report_moderation_denied", 403)
		}
		prior, e := s.priorReport(ctx, tx, caller, recorded)
		if e != nil {
			return nil, e
		}
		if prior != nil {
			receipt, e := row(ctx, tx, "SELECT jsonb_build_object('version',e.version,'revision',a.result->'revision') FROM account_chat_governance_events_v1 e JOIN business_admin_audit_v1 a ON a.endpoint=$1 AND a.operation_id=e.id AND a.action='chat-report-event' WHERE e.id=$2", s.Chat.Endpoint, x["operationId"])
			if e != nil {
				return nil, e
			}
			if _, e = current(); e != nil {
				return nil, e
			}
			prior["messageOperation"] = Object{"operationId": x["operationId"], "replayed": true, "revision": receipt["revision"], "reportVersion": receipt["version"]}
			return prior, nil
		}
		if s.expiredReport(r) {
			return nil, fail("chat_report_materials_expired", 410)
		}
		if num(r, "version") != num(x, "expectedVersion") {
			return nil, fail("chat_report_version_changed")
		}
		if str(r, "state") == "withdrawn" && str(x, "action") != "restore" {
			return nil, fail("chat_report_state")
		}
		if num(r, "version") >= 100 && str(x, "action") != "restore" {
			return nil, fail("chat_report_event_limit")
		}
		m, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE message_id=$1 AND room_id=$2 FOR UPDATE", target["messageId"], r["room_id"])
		if e != nil {
			return nil, e
		}
		materials, e := rows(ctx, tx, "SELECT to_jsonb(m) FROM account_chat_governance_materials_v1 m WHERE report_id=$1 AND message_id=$2 AND revision=$3 AND room_id=$4 AND erased_at IS NULL ORDER BY event_id", r["id"], target["messageId"], x["messageRevision"], r["room_id"])
		if e != nil {
			return nil, e
		}
		if m == nil || len(materials) == 0 {
			return nil, fail("chat_report_message_not_selected", 404)
		}
		if num(m, "revision") != num(x, "messageRevision") {
			return nil, fail("chat_report_source_changed")
		}
		material := materials[0]
		available, e := s.reportSourceAvailable(ctx, tx, material)
		if e != nil {
			return nil, e
		}
		if !available {
			return nil, fail("chat_report_source_unavailable")
		}
		h, e := s.reportMessageHead(ctx, tx, str(r, "id"), str(target, "messageId"))
		if e != nil {
			return nil, e
		}
		if num(h, "revision") != num(x, "expectedRevision") {
			return nil, fail("chat_report_message_version_changed")
		}
		if str(x, "action") == "hide" && (truth(h, "hidden") || !has([]string{"received", "reviewing", "appealed"}, str(r, "state"))) || str(x, "action") != "hide" && !truth(h, "hidden") {
			return nil, fail("chat_report_message_state")
		}
		fresh, e = current()
		if e != nil {
			return nil, e
		}
		caller.Operator = fresh
		if e = s.insertReportEvent(ctx, tx, r, caller, recorded, kind, num(r, "version")+1); e != nil {
			return nil, e
		}
		hidden, revision := str(x, "action") != "restore", num(h, "revision")+1
		initial := h["initial_event_id"]
		if initial == nil {
			initial = x["operationId"]
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_chat_message_visibility_v1(endpoint,report_id,message_id,message_revision,revision,hidden,initial_event_id,current_event_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(endpoint,report_id,message_id) DO UPDATE SET message_revision=$4,revision=$5,hidden=$6,current_event_id=$8,updated_at=$9`, s.Chat.Endpoint, r["id"], target["messageId"], x["messageRevision"], revision, hidden, initial, x["operationId"], s.Chat.now()); e != nil {
			return nil, e
		}
		updated, e := row(ctx, tx, "UPDATE account_chat_reports_v1 SET version=version+1,state=CASE WHEN state IN ('received','appealed') THEN 'reviewing' ELSE state END,updated_at=$2 WHERE id=$1 RETURNING to_jsonb(account_chat_reports_v1)", r["id"], s.Chat.now())
		if e != nil {
			return nil, e
		}
		fresh, e = current()
		if e != nil {
			return nil, e
		}
		available, e = s.reportSourceAvailable(ctx, tx, material)
		if e != nil {
			return nil, e
		}
		if !available {
			return nil, fail("chat_report_source_unavailable")
		}
		var allHidden bool
		if e = tx.QueryRow(ctx, "SELECT "+operationsBlocked+" FROM chat_message_refs m WHERE message_id=$1", target["messageId"]).Scan(&allHidden); e != nil {
			return nil, e
		}
		if e = s.admin().Record(ctx, tx, fresh, "chat-report-event", Object{"reportId": r["id"], "kind": kind, "roomId": r["room_id"], "messageId": target["messageId"], "sourceRevision": x["messageRevision"]}, Object{"version": updated["version"], "state": updated["state"], "revision": revision, "hidden": allHidden, "replayed": false}, x["operationId"]); e != nil {
			return nil, e
		}
		v, e := s.reportView(ctx, tx, updated, reportCaller{Operator: fresh, IsOperator: true}, true)
		if e != nil {
			return nil, e
		}
		v["messageOperation"] = Object{"operationId": x["operationId"], "replayed": false, "revision": revision, "reportVersion": updated["version"]}
		return v, nil
	})
}
