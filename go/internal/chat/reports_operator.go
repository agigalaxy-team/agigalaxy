package chat

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func (s *ReportService) OperatorAttachment(ctx context.Context, a operationspermissions.Actor, report, id string, authorize func() (operationspermissions.Actor, error)) (AttachmentContent, error) {
	empty := AttachmentContent{}
	if !reportUUID.MatchString(report) || !reportUUID.MatchString(id) {
		return empty, reportInvalid()
	}
	if authorize == nil {
		return empty, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Chat.Pool, func(tx pgx.Tx) (AttachmentContent, error) {
		current := func() (operationspermissions.Actor, error) {
			fresh, e := authorize()
			if e != nil {
				return fresh, e
			}
			fresh, e = s.admin().Fresh(ctx, tx, fresh, "chat-reports.attachments.read")
			if e == nil && (fresh.ID != a.ID || fresh.Endpoint != a.Endpoint) {
				e = fail("business_admin_denied", 403)
			}
			return fresh, e
		}
		assertCase := func(context.Context, pgx.Tx) (Object, error) {
			fresh, e := current()
			if e != nil {
				return nil, e
			}
			r, e := s.reportRow(ctx, tx, report, false)
			if e != nil {
				return nil, e
			}
			c, e := s.reportContext(ctx, tx, r, reportCaller{Operator: fresh, IsOperator: true})
			if e != nil {
				return nil, e
			}
			if !truth(c, "independent") || s.expiredReport(r) {
				return nil, fail("chat_report_attachment_unavailable", 404)
			}
			mm, e := rows(ctx, tx, "SELECT to_jsonb(m) FROM account_chat_governance_materials_v1 m WHERE report_id=$1 AND attachments @> $2::jsonb ORDER BY event_id FOR SHARE", r["id"], encode([]Object{{"attachmentId": id}}))
			if e != nil {
				return nil, e
			}
			for _, m := range mm {
				ok, e := s.reportSourceAvailable(ctx, tx, m)
				if e != nil {
					return nil, e
				}
				if ok {
					return Object{"roomId": m["room_id"], "messageId": m["message_id"], "revision": m["revision"]}, nil
				}
			}
			return nil, fail("chat_report_attachment_unavailable", 404)
		}
		selected, e := assertCase(ctx, tx)
		if e != nil {
			return empty, e
		}
		if s.Attachments == nil {
			return empty, fail("attachment_service_unavailable", 503)
		}
		file, e := s.Attachments.SelectedCaseContentWithin(ctx, tx, AttachmentCaseSelection{AttachmentID: id, RoomID: str(selected, "roomId"), MessageID: str(selected, "messageId"), Revision: num(selected, "revision"), AssertCase: assertCase})
		if e != nil {
			return empty, e
		}
		if _, e = current(); e != nil {
			return empty, e
		}
		e = s.admin().Record(ctx, tx, a, "chat-report-attachment", Object{"reportId": report, "attachmentId": id}, Object{"bytes": len(file.Bytes)}, nil)
		return file, e
	})
}
func (s *ReportService) CommandResult(ctx context.Context, a operationspermissions.Actor, report, op string) (Object, error) {
	if !reportUUID.MatchString(report) || !reportUUID.MatchString(op) {
		return nil, fail("invalid_operations_command_receipt", 400)
	}
	return postgres.InTx(ctx, s.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		fresh, e := s.admin().Fresh(ctx, tx, a, "chat-reports.read")
		if e != nil {
			return nil, e
		}
		if s.admin().IsDuty(fresh) || s.admin().IsExecution(fresh) {
			return nil, fail("business_admin_denied", 403)
		}
		receipts, missing, e := s.loadReportReceipt(ctx, tx, op)
		if e != nil {
			return nil, fail("operations_command_receipt_unavailable", 503)
		}
		for _, candidate := range receipts {
			if str(candidate, "operator_id") != a.ID {
				if _, e = s.admin().Fresh(ctx, tx, fresh, "chat-reports.read"); e != nil {
					return nil, e
				}
				return nil, fail("operations_command_receipt_not_found", 404)
			}
		}
		var r Object
		if len(receipts) == 1 {
			r = receipts[0]
		}
		if e != nil {
			return nil, e
		}
		state := "not-recorded"
		if missing || len(receipts) > 1 {
			state = "unknown"
		}
		var kind, result any
		if r != nil {
			if str(r, "operator_id") != a.ID {
				return nil, fail("operations_command_receipt_not_found", 404)
			}
			state = "unknown"
			x := obj(r, "input")
			original := obj(r, "result")
			selection := obj(r, "selection")
			name := str(r, "kind")
			valid := str(r, "actor_kind") == "business-operator" && str(r, "audit_actor_kind") == "business-operator" && r["audit_operator_id"] == r["operator_id"] && str(r, "audit_action") == "chat-report-event" && r["erased_at"] == nil && str(r, "report_id") == report && str(r, "audit_operation_id") == op && str(selection, "reportId") == report && str(selection, "kind") == name
			var parsed Object
			if has([]string{"message-hide", "message-restore", "message-keep"}, name) {
				body := Object{}
				for k, v := range x {
					if k != "reportId" && k != "messageId" && k != "kind" {
						body[k] = v
					}
				}
				parsed, e = parseReportMessage(body)
				if e == nil && reportID(x, "messageId") && reportID(x, "reportId") && "message-"+str(parsed, "action") == name {
					parsed["reportId"], parsed["messageId"], parsed["kind"] = x["reportId"], x["messageId"], name
				} else {
					valid = false
				}
			} else {
				parsed, e = parseReport(x, true)
				valid = valid && e == nil && has([]string{"review", "pause", "resume", "resolve"}, name) && len(reportObjects(x["materials"])) == 0
			}
			valid = valid && str(parsed, "operationId") == op && str(parsed, "reportId") == report && str(parsed, "kind") == name && num(r, "version") == num(parsed, "expectedVersion")+1 && num(original, "version") == num(r, "version") && has(reportStates, str(original, "state"))
			if has([]string{"review", "pause"}, name) && str(original, "state") != "reviewing" || name == "resolve" && str(original, "state") != "resolved" {
				valid = false
			}
			if valid {
				canonical, e := identity.Canonical(Object{"action": "chat-report-event", "input": parsed})
				if e != nil {
					return nil, e
				}
				out := Object{"reportId": report, "version": original["version"], "state": original["state"], "recordedAt": iso(r["audit_created_at"]), "intentHash": identity.Digest(canonical)}
				if has([]string{"message-hide", "message-restore", "message-keep"}, name) {
					_, boolOK := original["hidden"].(bool)
					valid = selection["messageId"] == parsed["messageId"] && num(selection, "sourceRevision") == num(parsed, "messageRevision") && num(original, "revision") == num(parsed, "expectedRevision")+1 && boolOK
					out["messageId"], out["messageRevision"], out["dispositionRevision"], out["overallHiddenAtCommit"] = parsed["messageId"], parsed["messageRevision"], original["revision"], original["hidden"]
				}
				if valid && out["recordedAt"] != nil {
					kind, result, state = name, out, "recorded"
				}
			}
		}
		if _, e = s.admin().Fresh(ctx, tx, fresh, "chat-reports.read"); e != nil {
			return nil, e
		}
		return Object{"state": state, "operationId": op, "kind": kind, "result": result, "checkedAt": s.Chat.now().Unix(), "readExpiresAt": s.Chat.now().Unix() + 30, "metadataOnly": true}, nil
	})
}

func (s *ReportService) loadReportReceipt(ctx context.Context, tx pgx.Tx, op string) ([]Object, bool, error) {
	child, e := tx.Begin(ctx)
	if e != nil {
		return nil, false, e
	}
	rr, e := rows(ctx, child, `SELECT to_jsonb(q) FROM (SELECT e.operator_id,e.actor_kind,e.report_id,e.kind,e.version,e.input,e.erased_at,e.created_at,a.operator_id AS audit_operator_id,a.actor_kind AS audit_actor_kind,a.action AS audit_action,a.operation_id AS audit_operation_id,a.created_at AS audit_created_at,a.selection,a.result FROM account_chat_governance_events_v1 e JOIN account_chat_reports_v1 r ON r.id=e.report_id LEFT JOIN business_admin_audit_v1 a ON a.endpoint=r.endpoint AND a.operation_id=e.id WHERE r.endpoint=$1 AND e.id=$2)q`, s.Chat.Endpoint, op)
	if e != nil {
		_ = child.Rollback(ctx)
		var pg *pgconn.PgError
		if errors.As(e, &pg) && pg.Code == "42P01" {
			return nil, true, nil
		}
		return nil, false, e
	}
	e = child.Commit(ctx)
	return rr, false, e
}
