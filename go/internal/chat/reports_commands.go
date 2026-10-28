package chat

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"reflect"
	"time"
)

func (s *ReportService) reportKind(a reportCaller) string {
	if !a.IsOperator {
		return "official-account"
	}
	if s.admin().IsDuty(a.Operator) {
		return "operations-ai-service"
	}
	if s.admin().IsExecution(a.Operator) {
		return "operations-executor"
	}
	return "business-operator"
}
func (s *ReportService) priorReport(ctx context.Context, tx pgx.Tx, a reportCaller, x Object) (Object, error) {
	event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM account_chat_governance_events_v1 e WHERE id=$1 FOR SHARE", x["operationId"])
	if e != nil || event == nil {
		return nil, e
	}
	same := str(event, "actor_kind") == s.reportKind(a)
	if a.IsOperator {
		same = same && str(event, "operator_id") == a.Operator.ID
	} else {
		same = same && str(event, "account_id") == a.Account.AccountID
	}
	same = same && reflect.DeepEqual(obj(event, "input"), reportNormalized(x))
	if !same {
		return nil, fail("chat_report_operation_conflict")
	}
	r, e := s.reportRow(ctx, tx, str(event, "report_id"), false)
	if e != nil {
		return nil, e
	}
	return s.reportView(ctx, tx, r, a, true)
}
func reportNormalized(x Object) Object {
	var out Object
	_ = json.Unmarshal(encode(x), &out)
	return out
}
func (s *ReportService) insertReportEvent(ctx context.Context, tx pgx.Tx, r Object, a reportCaller, x Object, kind string, version int64) error {
	var account, operator, request any
	if a.IsOperator {
		operator = a.Operator.ID
		request = a.Operator.RequestID
	} else {
		account = a.Account.AccountID
		if a.Account.RequestID != "" {
			request = a.Account.RequestID
		}
	}
	_, e := tx.Exec(ctx, `INSERT INTO account_chat_governance_events_v1(id,report_id,actor_kind,account_id,operator_id,http_request_id,version,kind,input,summary,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, x["operationId"], r["id"], s.reportKind(a), account, operator, request, version, kind, encode(x), x["summary"], s.Chat.now())
	return e
}
func (s *ReportService) Report(ctx context.Context, a Actor, x Object) (Object, error) {
	x, e := parseReport(x, false)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, func(tx pgx.Tx) (Object, error) {
		caller := reportCaller{Account: a}
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912326,hashtext($1))", x["operationId"]); e != nil {
			return nil, e
		}
		prior, e := s.priorReport(ctx, tx, caller, x)
		if e != nil || prior != nil {
			return prior, e
		}
		ids := []string{}
		for _, m := range reportObjects(x["materials"]) {
			ids = append(ids, str(m, "messageId"))
		}
		c, _, e := s.reportSource(ctx, tx, a, str(x, "roomId"), ids, true)
		if e != nil {
			return nil, e
		}
		if num(c.Room, "revision") != num(x, "roomVersion") {
			return nil, fail("chat_report_target_changed")
		}
		var open int64
		if e = tx.QueryRow(ctx, "SELECT count(*) FROM account_chat_reports_v1 WHERE reporter_account_id=$1 AND room_id=$2 AND state NOT IN ('resolved','withdrawn')", a.AccountID, x["roomId"]).Scan(&open); e != nil {
			return nil, e
		}
		if open >= 3 {
			return nil, fail("chat_report_open_limit")
		}
		materials, e := s.captureReports(ctx, tx, a, str(x, "roomId"), reportObjects(x["materials"]))
		if e != nil {
			return nil, e
		}
		parties := []string{}
		for _, m := range c.Members {
			parties = append(parties, str(m, "subject_id"))
		}
		parties = append(parties, c.Parties...)
		for _, m := range materials {
			parties = append(parties, str(m, "authorRef"))
		}
		ref, _ := actorRef(a)
		parties = append(parties, ref)
		r, e := row(ctx, tx, `INSERT INTO account_chat_reports_v1(id,endpoint,room_id,reporter_account_id,target_version,category,party_refs,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING to_jsonb(account_chat_reports_v1)`, x["operationId"], s.Chat.Endpoint, x["roomId"], a.AccountID, x["roomVersion"], x["category"], encode(reportStrings(parties)), s.Chat.now())
		if e != nil {
			return nil, e
		}
		if e = s.insertReportEvent(ctx, tx, r, caller, x, "report", 1); e != nil {
			return nil, e
		}
		if e = s.saveReportMaterials(ctx, tx, r, str(x, "operationId"), materials); e != nil {
			return nil, e
		}
		return s.reportView(ctx, tx, r, caller, true)
	})
}
func (s *ReportService) Event(ctx context.Context, a Actor, x Object) (Object, error) {
	x, e := parseReport(x, true)
	if e != nil {
		return nil, e
	}
	if has(reportDecisions, str(x, "kind")) {
		return nil, fail("chat_report_moderation_denied", 403)
	}
	return s.run(ctx, a, true, func(tx pgx.Tx) (Object, error) { return s.applyReportEvent(ctx, tx, reportCaller{Account: a}, x) })
}
func (s *ReportService) OperatorEvent(ctx context.Context, a operationspermissions.Actor, x Object) (Object, error) {
	x, e := parseReport(x, true)
	if e != nil {
		return nil, e
	}
	if !has(reportDecisions, str(x, "kind")) {
		return nil, fail("chat_report_moderation_denied", 403)
	}
	return postgres.InTx(ctx, s.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		current, e := s.admin().Operation(ctx, tx, a, "chat-report-event", Object{"kind": x["kind"]})
		if e != nil {
			return nil, e
		}
		return s.applyReportEvent(ctx, tx, reportCaller{Operator: current, IsOperator: true}, x)
	})
}
func (s *ReportService) validRestriction(x Object, max int64) bool {
	return len(reportStrings(x["scopes"])) > 0 && num(x, "until") > s.Chat.now().Unix() && num(x, "until") <= s.Chat.now().Unix()+max
}
func (s *ReportService) applyReportEvent(ctx context.Context, tx pgx.Tx, a reportCaller, x Object) (Object, error) {
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912326,hashtext($1))", x["operationId"]); e != nil {
		return nil, e
	}
	old, e := s.priorReport(ctx, tx, a, x)
	if e != nil || old != nil {
		return old, e
	}
	r, e := s.reportRow(ctx, tx, str(x, "reportId"), true)
	if e != nil {
		return nil, e
	}
	c, e := s.reportContext(ctx, tx, r, a)
	if e != nil {
		return nil, e
	}
	if s.expiredReport(r) {
		return nil, fail("chat_report_materials_expired", 410)
	}
	if num(r, "version") != num(x, "expectedVersion") {
		return nil, fail("chat_report_version_changed")
	}
	kind := str(x, "kind")
	if has(reportDecisions, kind) {
		if !truth(c, "canModerate") {
			return nil, fail("chat_report_moderation_denied", 403)
		}
	} else if a.IsOperator || !truth(c, "party") {
		return nil, fail("chat_report_response_denied", 403)
	}
	selections := reportObjects(x["materials"])
	if len(selections) > 0 && !has([]string{"supplement", "appeal"}, kind) {
		return nil, reportInvalid()
	}
	if num(r, "version") >= 100 && !has([]string{"resume", "withdraw-report"}, kind) {
		return nil, fail("chat_report_event_limit")
	}
	restricted := r["restriction_until"] != nil && millis(r["restriction_until"]) > s.Chat.now().UnixMilli()
	messageRestricted, e := s.caseMessageBlocked(ctx, tx, str(r, "id"))
	if e != nil {
		return nil, e
	}
	state := str(r, "state")
	scopes, until, restriction, decision, closed := r["restriction_scopes"], reportDate(r["restriction_until"]), r["restriction_event_id"], r["decision_event_id"], reportDate(r["closed_at"])
	appeals := num(r, "appeal_count")
	switch kind {
	case "supplement":
		if state == "withdrawn" {
			return nil, fail("chat_report_state")
		}
	case "withdraw-report":
		if !truth(c, "reporter") || state == "withdrawn" {
			return nil, fail("chat_report_state")
		}
		state = "withdrawn"
		closed = s.Chat.now()
	case "appeal":
		if !(state == "resolved" || restricted || messageRestricted) || appeals >= 3 {
			return nil, fail("chat_report_state")
		}
		state = "appealed"
		closed = nil
		appeals++
	case "review":
		if !has([]string{"received", "appealed", "reviewing"}, state) {
			return nil, fail("chat_report_state")
		}
		state = "reviewing"
	case "resume":
		if !restricted {
			return nil, fail("chat_report_state")
		}
		scopes = []any{}
		until = nil
		restriction = nil
	case "pause", "resolve":
		if has([]string{"resolved", "withdrawn"}, state) {
			return nil, fail("chat_report_state")
		}
		target, e := s.currentReportTarget(ctx, tx, r)
		if e != nil {
			return nil, e
		}
		if target == nil || num(target, "version") != num(x, "targetVersion") {
			return nil, fail("chat_report_target_changed")
		}
		if kind == "pause" {
			if !s.validRestriction(x, 7*86400) {
				return nil, fail("chat_report_restriction_invalid", 400)
			}
			state = "reviewing"
			scopes = x["scopes"]
			until = reportStamp(num(x, "until"))
			restriction = x["operationId"]
		} else {
			rr := obj(x, "restriction")
			if str(x, "verdict") == "dismissed" && rr != nil || rr != nil && !s.validRestriction(rr, 30*86400) {
				return nil, fail("chat_report_restriction_invalid", 400)
			}
			state = "resolved"
			closed = s.Chat.now()
			decision = x["operationId"]
			scopes = []any{}
			until = nil
			restriction = nil
			if rr != nil {
				scopes = rr["scopes"]
				until = reportStamp(num(rr, "until"))
				restriction = x["operationId"]
			}
		}
	}
	materials := []Object{}
	if len(selections) > 0 {
		materials, e = s.captureReports(ctx, tx, a.Account, str(r, "room_id"), selections)
		if e != nil {
			return nil, e
		}
	}
	if e = s.insertReportEvent(ctx, tx, r, a, x, kind, num(r, "version")+1); e != nil {
		return nil, e
	}
	parties := reportStrings(r["party_refs"])
	for _, m := range materials {
		parties = append(parties, str(m, "authorRef"))
	}
	updated, e := row(ctx, tx, `UPDATE account_chat_reports_v1 SET version=version+1,state=$2,restriction_scopes=$3,restriction_until=$4,restriction_event_id=$5,decision_event_id=$6,closed_at=$7,appeal_count=$8,updated_at=$9,party_refs=$10 WHERE id=$1 RETURNING to_jsonb(account_chat_reports_v1)`, r["id"], state, encode(scopes), until, restriction, decision, closed, appeals, s.Chat.now(), encode(reportStrings(parties)))
	if e != nil {
		return nil, e
	}
	if e = s.saveReportMaterials(ctx, tx, r, str(x, "operationId"), materials); e != nil {
		return nil, e
	}
	if a.IsOperator {
		if e = s.admin().Record(ctx, tx, a.Operator, "chat-report-event", Object{"reportId": r["id"], "kind": kind, "roomId": r["room_id"]}, Object{"version": updated["version"], "state": updated["state"]}, x["operationId"]); e != nil {
			return nil, e
		}
	}
	return s.reportView(ctx, tx, updated, a, true)
}
func (s *ReportService) Receipt(ctx context.Context, a Actor, x Object) (Object, error) {
	if !strict(x, "operationId") || !reportID(x, "operationId") {
		return nil, reportInvalid()
	}
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM account_chat_governance_events_v1 e WHERE id=$1 AND actor_kind='official-account' AND account_id=$2", x["operationId"], a.AccountID)
		if e != nil {
			return nil, e
		}
		if event == nil {
			return Object{"operationId": x["operationId"], "state": "absent"}, nil
		}
		r, e := s.reportRow(ctx, tx, str(event, "report_id"), false)
		if e != nil {
			return nil, e
		}
		if _, e = s.reportContext(ctx, tx, r, reportCaller{Account: a}); e != nil {
			return nil, e
		}
		return Object{"operationId": x["operationId"], "state": "recorded", "reportId": r["id"], "version": event["version"], "currentVersion": r["version"]}, nil
	})
}
func (s *ReportService) PurgeExpired(ctx context.Context, limit int) (Object, error) {
	if limit < 1 || limit > 500 {
		return nil, reportInvalid()
	}
	return postgres.InTx(ctx, s.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		rr, e := rows(ctx, tx, `SELECT to_jsonb(r) FROM account_chat_reports_v1 r WHERE closed_at<=$1 AND EXISTS(SELECT 1 FROM account_chat_governance_events_v1 e WHERE e.report_id=r.id AND e.erased_at IS NULL) ORDER BY closed_at LIMIT $2 FOR UPDATE`, s.Chat.now().Add(-180*24*time.Hour), limit)
		if e != nil {
			return nil, e
		}
		ids := []string{}
		for _, r := range rr {
			ids = append(ids, str(r, "id"))
		}
		if len(ids) == 0 {
			return Object{"erasedCases": 0}, nil
		}
		if _, e = tx.Exec(ctx, "UPDATE account_chat_governance_materials_v1 SET text='',attachments='[]',erased_at=COALESCE(erased_at,$2) WHERE report_id=ANY($1::uuid[])", ids, s.Chat.now()); e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, "UPDATE account_chat_governance_events_v1 SET summary='',input=jsonb_build_object('operationId',id,'reportId',report_id,'kind',kind),erased_at=COALESCE(erased_at,$2) WHERE report_id=ANY($1::uuid[])", ids, s.Chat.now())
		return Object{"erasedCases": len(ids)}, e
	})
}
