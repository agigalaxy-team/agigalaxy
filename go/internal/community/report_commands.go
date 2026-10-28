package community

import (
	"context"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) ReportEvent(ctx context.Context, account, id, raw string) (Object, error) {
	p, e := s.parseReport(raw, true)
	if e != nil {
		return nil, e
	}
	if str(p, "reportId") != id {
		return nil, fail("forum_report_target_mismatch", 400)
	}
	account, e = s.writeTarget(account, p)
	if e != nil {
		return nil, e
	}
	kind := str(p, "kind")
	if s.actor != nil {
		s.actor.scope = "assistance"
		if kind == "resolve" {
			s.actor.scope = "moderation"
		}
	}
	return s.runWrite(ctx, account, kind != "supplement", func(tx pgx.Tx) (Object, error) {
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
		operationKind := kind
		if kind == "withdraw" {
			operationKind = "withdraw-report"
		}
		if str(p, "governanceEventId") != deriveID("governance-event", operationKind, s.actorKey(account), p, "governanceEventId") {
			return nil, fail("forum_locator_mismatch", 409)
		}
		source, e := row(ctx, tx, "SELECT to_jsonb(r) FROM forum_reports_v1 r WHERE id=$1", id)
		if e != nil {
			return nil, e
		}
		if source == nil {
			return nil, fail("not_found", 404)
		}
		control := kind != "supplement"
		if kind != "resolve" {
			account, e = s.reportContext(ctx, tx, account, source, kind)
			if e != nil {
				return nil, e
			}
			if s.actor != nil {
				available, e := s.availableIdentityAccounts(ctx, tx)
				if e != nil {
					return nil, e
				}
				if len(available) > 0 {
					resolved, e := s.resolveIdentityAccount(ctx, tx, account, true)
					if e != nil {
						return nil, e
					}
					account = str(resolved, "id")
				} else {
					_, party := s.party(source, account)
					if !control || !party {
						return nil, fail("account_verification_required", 403)
					}
				}
			}
			if account != "" {
				if _, e = s.writeAccount(ctx, tx, account, control); e != nil {
					return nil, e
				}
			}
		} else if s.actor == nil {
			return nil, fail("forum_independent_handler_required", 403)
		}
		r, e := row(ctx, tx, "SELECT to_jsonb(r) FROM forum_reports_v1 r WHERE id=$1 FOR UPDATE", id)
		if e != nil {
			return nil, e
		}
		if r == nil {
			return nil, fail("not_found", 404)
		}
		if num(r, "version") != num(p, "expectedReportVersion") {
			return nil, fail("forum_report_version_conflict", 409)
		}
		view, e := s.readReport(ctx, tx, account, id)
		if e != nil {
			return nil, e
		}
		eligible, e := s.eligible(ctx, tx, r)
		if e != nil {
			return nil, e
		}
		if kind == "resolve" {
			if !truth(view, "canModerate") {
				return nil, fail("forum_independent_handler_required", 403)
			}
			if !hasString([]string{"pending", "appealed"}, str(r, "state")) {
				return nil, fail("forum_report_transition", 409)
			}
			if effect := obj(p, "effect"); effect != nil {
				until := num(effect, "until")
				if str(p, "resolution") != "accepted" || until <= s.clock() || until > s.clock()+num(s.policy(), "maxGovernanceHideSeconds") {
					return nil, fail("forum_hide_expiry", 409)
				}
				target := obj(r, "target")
				base, _, e := s.reportTarget(ctx, tx, target, account, false)
				if e != nil {
					return nil, e
				}
				if str(base, "state") != "published" || str(target, "kind") == "post-version" && str(base, "post_state") != "published" || str(base, "payload_text") == "" || base["erased_at"] != nil || base["event_erased"] != nil {
					return nil, fail("forum_source_unavailable", 403)
				}
				action, objectID := "forum.post.publish", str(target, "versionId")
				if str(target, "kind") == "reply" {
					action = "forum.reply.publish"
					objectID = str(target, "replyId")
				}
				_, state, e := s.permission(ctx, tx, base, action, objectID)
				if e != nil {
					return nil, e
				}
				allowed, e := s.audienceAllowed(ctx, tx, account, base)
				if e != nil {
					return nil, e
				}
				if state != "available" || !allowed {
					return nil, fail("forum_content_unavailable", 403)
				}
			}
		} else if kind == "appeal" {
			if !truth(view, "canAppeal") {
				return nil, fail("forum_appeal_unavailable", 409)
			}
		} else if kind == "withdraw" {
			if !truth(view, "canWithdrawReport") {
				return nil, fail("forum_report_transition", 409)
			}
		} else if !truth(view, "canSupplement") {
			return nil, fail("forum_report_transition", 409)
		}
		if num(r, "version") >= num(s.policy(), "maxReportEvents")+2*num(s.policy(), "maxAppeals")+2 {
			return nil, fail("forum_report_event_limit", 413)
		}
		var before int64
		if !control {
			if account != str(r, "reporter_account_id") {
				return nil, fail("forum_report_account_changed", 409)
			}
			before, e = s.usage(ctx, tx, account)
			if e != nil {
				return nil, e
			}
		}
		parties := []string{}
		accounts := []string{}
		for _, key := range []string{"reporter_id", "target_author_id"} {
			if value := str(r, key); value != "" && !hasString(parties, value) {
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
		allowed, e := handlers(p, eligible)
		if e != nil {
			return nil, e
		}
		action := "forum.report.event"
		var required, requiredAccounts []string
		if kind == "resolve" {
			action = "forum.governance.resolve"
			allowed = append(append([]string{}, eligible...), parties...)
			required = parties
			requiredAccounts = accounts
		}
		permission, until, e := s.privateCapture(ctx, tx, account, raw, action, str(p, "governanceEventId"), str(p, "governanceEventId"), allowed, required, accounts, requiredAccounts)
		if e != nil {
			return nil, e
		}
		if effect := obj(p, "effect"); effect != nil && num(effect, "until") > until {
			return nil, fail("forum_hide_expiry", 409)
		}
		version := num(r, "version") + 1
		state := str(r, "state")
		switch kind {
		case "resolve":
			state = "resolved"
		case "appeal":
			state = "appealed"
		case "withdraw":
			state = "withdrawn"
		}
		result := Object{"acknowledged": true, "reportId": id, "governanceEventId": p["governanceEventId"], "version": version, "state": state, "accountId": null(account), "subjectId": s.subject(), "authority": "accepted-operation-only"}
		if e = s.saveReportEvent(ctx, tx, account, raw, kind, id, version, permission, p, result); e != nil {
			return nil, e
		}
		var closed, audit, restriction, restrictionID any
		if state == "resolved" || state == "withdrawn" {
			closed = s.now()
			audit = s.now().Add(time.Duration(num(s.policy(), "auditDays")) * 24 * time.Hour)
		}
		if effect := obj(p, "effect"); effect != nil {
			restriction = time.Unix(num(effect, "until"), 0)
			restrictionID = p["governanceEventId"]
		}
		appeal := 0
		if kind == "appeal" {
			appeal = 1
		}
		_, e = tx.Exec(ctx, `UPDATE forum_reports_v1 SET version=$2,state=$3,appeal_count=appeal_count+$4,closed_at=$5,audit_until=$6,decision_event_id=CASE WHEN $7::boolean THEN $8::uuid ELSE decision_event_id END,restriction_event_id=CASE WHEN $7::boolean THEN $9::uuid ELSE restriction_event_id END,restriction_until=CASE WHEN $7::boolean THEN $10::timestamptz ELSE restriction_until END WHERE id=$1`, id, version, state, appeal, closed, audit, kind == "resolve", p["governanceEventId"], restrictionID, restriction)
		if e != nil {
			return nil, e
		}
		if kind == "withdraw" {
			if account != "" && truth(r, "account_governance") {
				_, e = tx.Exec(ctx, "UPDATE forum_permissions_v1 SET revoked_at=coalesce(revoked_at,$3) WHERE id IN (SELECT permission_id FROM forum_governance_events_v1 WHERE report_id=$1 AND account_id=$2 AND kind IN ('report','supplement'))", id, account, s.now())
			} else {
				_, e = tx.Exec(ctx, "UPDATE forum_permissions_v1 SET revoked_at=coalesce(revoked_at,$3) WHERE id IN (SELECT permission_id FROM forum_governance_events_v1 WHERE report_id=$1 AND subject_id=$2 AND kind IN ('report','supplement'))", id, s.subject(), s.now())
			}
			if e != nil {
				return nil, e
			}
		}
		if s.actor != nil {
			s.actor.action = action
		}
		if e = s.complete(ctx, tx, account, raw, "", p, Object{"kind": "report", "reportId": id}, result); e != nil {
			return nil, e
		}
		if !control {
			after, e := s.usage(ctx, tx, account)
			if e != nil {
				return nil, e
			}
			if after > num(s.policy(), "accountForumMaxBytes") && after > before {
				return nil, fail("forum_storage_quota_exceeded", 409)
			}
		}
		return result, nil
	})
}
