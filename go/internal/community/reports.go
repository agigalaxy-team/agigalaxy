package community

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"sort"
	"time"
)

func (s *Service) eligible(ctx context.Context, tx pgx.Tx, r Object) ([]string, error) {
	out := []string{}
	for _, subject := range s.ModeratorIDs {
		if hasString(out, subject) {
			continue
		}
		yes, e := s.independent(ctx, tx, subject, r)
		if e != nil {
			return nil, e
		}
		if yes {
			out = append(out, subject)
		}
	}
	return out, nil
}
func handlers(p Object, eligible []string) ([]string, error) {
	v, present := p["handlerIds"]
	if !present {
		return eligible, nil
	}
	a, _ := v.([]any)
	out := []string{}
	for _, id := range a {
		s := asString(id)
		if hasString(out, s) || !hasString(eligible, s) {
			return nil, fail("forum_private_audience_mismatch", 403)
		}
		out = append(out, s)
	}
	return out, nil
}
func (s *Service) privateCapture(ctx context.Context, tx pgx.Tx, account, raw, action, objectID, event string, allowed, required, allowedAccounts, requiredAccounts []string) (string, int64, error) {
	if s.actor != nil {
		return s.captureIdentity(ctx, tx, account, raw, action, objectID, event, 0, "Private", allowed, required, allowedAccounts, requiredAccounts)
	}
	if account == "" || action != "forum.report.publish" && action != "forum.report.event" {
		return "", 0, fail("forum_permission_mismatch", 403)
	}
	until := s.clock() + min(int64(3600), num(s.policy(), "maxPermissionSeconds"))
	id := uuid.NewString()
	var payload Object
	if decodeObject(raw, &payload) != nil {
		return "", 0, fail("invalid_forum_payload", 400)
	}
	fields := []string{}
	for k := range payload {
		fields = append(fields, k)
	}
	_, e := tx.Exec(ctx, `INSERT INTO forum_permissions_v1(id,account_id,event_id,authorization_kind,payload_hash,action,object_id,visibility,fields,viewers,issued_at,published_until,accepted_at,authorization_audit_until,policy_hash,account_viewers) VALUES($1,$2,$3,'official-account',$4,$5,$6,'Private',$7,$8,$9,$10,$9,$11,$12,$13)`, id, account, event, identity.Digest([]byte(raw)), action, objectID, encode(fields), encode(allowed), s.now(), time.Unix(until, 0), time.Unix(until+num(s.policy(), "auditDays")*86400, 0), s.policyHash(), encode([]string{account}))
	return id, until, e
}
func (s *Service) saveReportEvent(ctx context.Context, tx pgx.Tx, account, raw, kind, report string, version int64, permission string, p, result Object) error {
	id := p["governanceEventId"]
	if id == nil {
		id = p["operationId"]
	}
	var effect any
	if eff := obj(p, "effect"); eff != nil {
		effect = time.Unix(num(eff, "until"), 0)
	}
	_, e := tx.Exec(ctx, `INSERT INTO forum_governance_events_v1(id,operation_id,report_id,subject_id,account_id,version,kind,consent_id,permission_id,payload_text,payload_hash,created_at,resolution,effect_until,result,actor_kind,http_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, id, p["operationId"], report, s.subject(), null(account), version, kind, s.consentID(), permission, raw, identity.Digest([]byte(raw)), s.now(), p["resolution"], effect, encode(result), s.actorKind(), null(s.RequestID))
	return e
}
func (s *Service) Report(ctx context.Context, account, raw string) (Object, error) {
	p, e := s.parseReport(raw, false)
	if e != nil {
		return nil, e
	}
	account, e = s.writeTarget(account, p)
	if e != nil {
		return nil, e
	}
	return s.runWrite(ctx, account, false, func(tx pgx.Tx) (Object, error) {
		if account == "" && s.actor == nil {
			return nil, fail("official_account_login_required", 401)
		}
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912318,hashtext($1))", p["operationId"]); e != nil {
			return nil, e
		}
		prior, e := s.prior(ctx, tx, account, str(p, "operationId"), raw)
		if e != nil || prior != nil {
			return prior, e
		}
		if str(p, "reportId") != deriveID("report", "create-report", s.actorKey(account), p, "reportId") {
			return nil, fail("forum_locator_mismatch", 409)
		}
		if s.actor != nil {
			account, e = s.selectIdentityWrite(ctx, tx, account, "create-report", p)
			if e != nil {
				return nil, e
			}
		}
		owner, e := s.writeAccount(ctx, tx, account, false)
		if e != nil {
			return nil, e
		}
		target := obj(p, "target")
		if str(target, "kind") == "post-version" {
			if _, e = s.head(ctx, tx, str(target, "postId"), true); e != nil {
				return nil, e
			}
		} else {
			var id string
			if e = tx.QueryRow(ctx, "SELECT id::text FROM forum_replies_v1 WHERE id=$1 FOR UPDATE", target["replyId"]).Scan(&id); e != nil {
				return nil, e
			}
		}
		source, view, e := s.reportTarget(ctx, tx, target, account, true)
		if e != nil {
			return nil, e
		}
		if str(view, "availability") != "available" {
			return nil, fail("forum_report_source_unavailable", 403)
		}
		quota, e := s.quota(ctx, tx, owner, "report")
		if e != nil {
			return nil, e
		}
		if num(quota, "remaining") == 0 {
			return nil, fail("forum_quota_exceeded", 429)
		}
		before, e := s.usage(ctx, tx, account)
		if e != nil {
			return nil, e
		}
		context := Object{"reporter_id": s.subject(), "target_author_id": source["subject_id"], "reporter_account_id": account, "target_author_account_id": source["account_id"], "account_governance": true}
		eligible, e := s.eligible(ctx, tx, context)
		if e != nil {
			return nil, e
		}
		selected, e := handlers(p, eligible)
		if e != nil {
			return nil, e
		}
		permission, _, e := s.privateCapture(ctx, tx, account, raw, "forum.report.publish", str(p, "reportId"), str(p, "operationId"), selected, nil, []string{}, nil)
		if e != nil {
			return nil, e
		}
		accountGovernance := s.actor == nil || p["accountId"] != nil || source["subject_id"] == nil
		_, e = tx.Exec(ctx, `INSERT INTO forum_reports_v1(id,subject_id,reporter_id,account_id,target,target_author_id,version,state,created_at,reporter_account_id,target_author_account_id,account_governance,operations_disclosed) VALUES($1,$2,$2,$3,$4,$5,1,'pending',$6,$3,$7,$8,$9)`, p["reportId"], s.subject(), account, encode(target), source["subject_id"], s.now(), source["account_id"], accountGovernance, s.actor == nil && s.OperationsHandling)
		if e != nil {
			return nil, e
		}
		handling := "awaiting-authorized-handler"
		hasHandler := len(selected) > 0
		if s.actor != nil {
			hasHandler = false
			for _, id := range eligible {
				hasHandler = hasHandler || hasString(s.actor.capture.Intent.Viewers, id)
			}
		}
		if hasHandler {
			handling = "awaiting-independent-handler"
		}
		if s.actor == nil && s.OperationsHandling {
			handling = "awaiting-operations-handler"
		}
		result := Object{"acknowledged": true, "reportId": p["reportId"], "governanceEventId": p["operationId"], "version": 1, "state": "pending", "accountId": account, "subjectId": s.subject(), "handlingState": handling, "authority": "accepted-operation-only"}
		if e = s.saveReportEvent(ctx, tx, account, raw, "report", str(p, "reportId"), 1, permission, p, result); e != nil {
			return nil, e
		}
		if e = s.complete(ctx, tx, account, raw, "report", p, Object{"kind": "report", "reportId": p["reportId"]}, result); e != nil {
			return nil, e
		}
		quota, e = s.finishBudget(ctx, tx, account, before, quota)
		if e != nil {
			return nil, e
		}
		out := clone(result)
		out["quota"] = quota
		return out, nil
	})
}
func (s *Service) reportContext(ctx context.Context, tx pgx.Tx, account string, r Object, kind string) (string, error) {
	if s.actor == nil || account != "" {
		return account, nil
	}
	candidates := []string{}
	if kind == "supplement" || kind == "withdraw" {
		candidates = append(candidates, str(r, "reporter_account_id"))
	} else if truth(r, "account_governance") {
		candidates = append(candidates, str(r, "reporter_account_id"), str(r, "target_author_account_id"))
	} else {
		if str(r, "reporter_id") == s.actor.actor.SubjectID {
			candidates = append(candidates, str(r, "reporter_account_id"))
		}
		if str(r, "target_author_id") == s.actor.actor.SubjectID {
			candidates = append(candidates, str(r, "target_author_account_id"))
		}
	}
	available, e := s.availableIdentityAccounts(ctx, tx)
	if e != nil {
		return "", e
	}
	matches := []string{}
	for _, candidate := range candidates {
		for _, a := range available {
			if candidate != "" && candidate == str(a, "id") && !hasString(matches, candidate) {
				matches = append(matches, candidate)
			}
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	return account, nil
}
func (s *Service) party(r Object, account string) (bool, bool) {
	subject := asString(s.subject())
	reporter := subject != "" && str(r, "reporter_id") == subject && (account == "" || account == str(r, "reporter_account_id"))
	target := subject != "" && str(r, "target_author_id") == subject && (account == "" || account == str(r, "target_author_account_id"))
	if account != "" && truth(r, "account_governance") {
		reporter = reporter || str(r, "reporter_account_id") == account
		target = target || str(r, "target_author_account_id") == account
	}
	return reporter, reporter || target
}
func (s *Service) privateEventAllowed(ctx context.Context, tx pgx.Tx, r Object, account string) (bool, error) {
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1", r["permission_id"])
	if e != nil || p == nil {
		return false, e
	}
	permission, state, e := s.permissionFor(ctx, tx, r, str(p, "action"), str(p, "object_id"), "Private")
	if e != nil || state != "available" {
		return false, e
	}
	subject := asString(s.subject())
	if subject != "" && (str(permission, "subject_id") == subject || containsAny(permission["viewers"], subject)) {
		return true, nil
	}
	if account == "" && s.actor != nil {
		a, e := s.resolveIdentityAccount(ctx, tx, "", false)
		if e != nil {
			if faultCode(e) != "account_verification_required" && faultCode(e) != "account_selection_required" {
				return false, e
			}
		} else {
			account = str(a, "id")
		}
	}
	if account != "" {
		if str(permission, "authorization_kind") == "official-account" && str(permission, "account_id") == account {
			return true, nil
		}
		if containsAny(permission["account_viewers"], account) {
			return true, nil
		}
	}
	return false, nil
}
func containsAny(v any, value string) bool {
	a, _ := v.([]any)
	for _, item := range a {
		if item == value {
			return true
		}
	}
	return false
}
func (s *Service) readReport(ctx context.Context, tx pgx.Tx, account, id string) (Object, error) {
	r, e := row(ctx, tx, "SELECT to_jsonb(r) FROM forum_reports_v1 r WHERE id=$1", id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("not_found", 404)
	}
	account, e = s.reportContext(ctx, tx, account, r, "")
	if e != nil {
		return nil, e
	}
	reporter, party := s.party(r, account)
	independent, e := s.independent(ctx, tx, asString(s.subject()), r)
	if e != nil {
		return nil, e
	}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM forum_governance_events_v1 e WHERE report_id=$1 ORDER BY version", id)
	if e != nil {
		return nil, e
	}
	events := []Object{}
	for _, event := range rr {
		if str(event, "payload_text") == "" || event["erased_at"] != nil {
			continue
		}
		allowed, e := s.privateEventAllowed(ctx, tx, event, account)
		if e != nil {
			return nil, e
		}
		if !allowed {
			continue
		}
		var payload Object
		_ = json.Unmarshal([]byte(str(event, "payload_text")), &payload)
		kind := "account"
		if event["subject_id"] != nil {
			kind = "identity"
		}
		events = append(events, Object{"operationId": event["operation_id"], "governanceEventId": event["id"], "version": event["version"], "kind": event["kind"], "authorId": event["subject_id"], "authorAccountId": event["account_id"], "author": Object{"kind": kind, "subjectId": event["subject_id"], "accountId": event["account_id"]}, "payload": payload, "checkedAt": s.clock()})
	}
	if party || len(events) > 0 && independent {
		ops, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM forum_operations_events_v1 e WHERE report_id=$1 AND retained_until>$2 ORDER BY version", id, s.now())
		if e != nil {
			return nil, e
		}
		for _, event := range ops {
			var effect any
			if event["effect_until"] != nil {
				effect = Object{"kind": "hide-version", "until": seconds(event["effect_until"])}
			}
			events = append(events, Object{"operationId": event["id"], "governanceEventId": event["id"], "version": event["version"], "kind": "resolve", "authorId": nil, "authorAccountId": nil, "author": Object{"kind": "business-operator", "operatorId": event["operator_id"]}, "payload": Object{"kind": "resolve", "reportId": id, "reason": event["summary"], "resolution": event["resolution"], "restrictionAction": event["restriction_action"], "effect": effect}, "checkedAt": s.clock()})
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return num(events[i], "version") < num(events[j], "version") })
	if !party && (!independent || len(events) == 0) {
		return nil, fail("not_found", 404)
	}
	canModerate := false
	if s.actor != nil && hasString(s.actor.actor.Scopes, "moderation") && independent {
		for _, event := range events {
			canModerate = canModerate || hasString([]string{"report", "supplement", "appeal"}, str(event, "kind"))
		}
	}
	var narratives int64
	e = tx.QueryRow(ctx, "SELECT count(*) FROM forum_governance_events_v1 WHERE report_id=$1 AND kind IN ('report','supplement')", id).Scan(&narratives)
	if e != nil {
		return nil, e
	}
	var decision any
	if r["decision_event_id"] != nil {
		d, e := row(ctx, tx, `SELECT to_jsonb(d) FROM (SELECT id,operation_id,version,kind,resolution,effect_until FROM forum_governance_events_v1 WHERE id=$1 UNION ALL SELECT id,id operation_id,version,'resolve' kind,resolution,effect_until FROM forum_operations_events_v1 WHERE id=$1 LIMIT 1)d`, r["decision_event_id"])
		if e != nil {
			return nil, e
		}
		if d != nil {
			var until any
			if d["effect_until"] != nil {
				until = seconds(d["effect_until"])
			}
			decision = Object{"governanceEventId": d["id"], "operationId": d["operation_id"], "version": d["version"], "kind": d["kind"], "resolution": d["resolution"], "effectUntil": until}
		}
	}
	handling := "awaiting-authorized-handler"
	if canModerate {
		handling = "awaiting-or-recorded-handler"
	} else if len(events) > 0 && len(s.ModeratorIDs) > 0 {
		handling = "pending-or-recorded"
	}
	disclosed := truth(r, "operations_disclosed")
	if disclosed {
		handling = "recorded"
		if str(r, "state") == "pending" || str(r, "state") == "appealed" {
			handling = "awaiting-operations-handler"
		}
	}
	out := Object{"reportId": id, "target": r["target"], "version": r["version"], "state": r["state"], "operationsHandling": disclosed, "handlingState": handling, "decisionLocator": decision, "events": events, "actionAccountId": null(account), "canAppeal": party && r["decision_event_id"] != nil && hasString([]string{"resolved", "withdrawn"}, str(r, "state")) && num(r, "appeal_count") < num(s.policy(), "maxAppeals"), "canSupplement": reporter && hasString([]string{"pending", "appealed"}, str(r, "state")) && narratives < num(s.policy(), "maxReportEvents"), "canWithdrawReport": reporter && str(r, "state") != "withdrawn", "canModerate": canModerate, "checkedAt": s.clock(), "guaranteesResponse": false, "authority": "configured-role-process; not-real-world-independence"}
	if disclosed {
		out["operationsDisclosure"] = "仅发送给运营处理人员"
	}
	if canModerate {
		parties := []string{}
		accounts := []string{}
		for _, key := range []string{"reporter_id", "target_author_id"} {
			if value := str(r, key); value != "" && value != asString(s.subject()) && !hasString(parties, value) {
				parties = append(parties, value)
			}
		}
		if truth(r, "account_governance") {
			for _, key := range []string{"reporter_account_id", "target_author_account_id"} {
				if value := str(r, key); value != "" && !hasString(accounts, value) {
					accounts = append(accounts, value)
				}
			}
		}
		out["decisionRecipients"] = parties
		out["decisionAccountRecipients"] = accounts
	}
	return out, nil
}
func (s *Service) GetReport(ctx context.Context, account, id string) (Object, error) {
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) { return s.readReport(ctx, tx, account, id) })
}
