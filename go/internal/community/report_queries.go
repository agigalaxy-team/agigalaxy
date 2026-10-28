package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ReportConfig(ctx context.Context, account string, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil || !strict(q, "target") {
		return nil, invalid()
	}
	if v, ok := q["target"]; ok && (v == nil || !validTarget(obj(q, "target"))) {
		return nil, invalid()
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		if account == "" && s.actor == nil {
			return nil, fail("official_account_login_required", 401)
		}
		if account == "" && s.actor != nil {
			a, e := s.resolveIdentityAccount(ctx, tx, "", false)
			if e == nil {
				account = str(a, "id")
			} else if faultCode(e) != "account_verification_required" && faultCode(e) != "account_selection_required" {
				return nil, e
			}
		}
		context := Object{"reporter_id": s.subject(), "reporter_account_id": null(account), "account_governance": true}
		if target := obj(q, "target"); target != nil {
			source, view, e := s.reportTarget(ctx, tx, target, account, true)
			if e != nil {
				return nil, e
			}
			if str(view, "availability") != "available" {
				return nil, fail("forum_report_source_unavailable", 403)
			}
			context["target_author_id"] = source["subject_id"]
			context["target_author_account_id"] = source["account_id"]
		}
		eligible, e := s.eligible(ctx, tx, context)
		if e != nil {
			return nil, e
		}
		out := Object{"moderatorIds": eligible, "configured": len(eligible) > 0 || s.OperationsHandling, "operationsHandling": s.OperationsHandling, "guaranteesResponse": false, "maxAppeals": s.policy()["maxAppeals"], "maxPermissionSeconds": s.policy()["maxPermissionSeconds"], "maxGovernanceHideSeconds": s.policy()["maxGovernanceHideSeconds"], "automaticAccountRestriction": false}
		if s.OperationsHandling {
			out["operationsDisclosure"] = "仅发送给运营处理人员"
		}
		return out, nil
	})
}
func (s *Service) Reports(ctx context.Context, account string, raw []byte, affected bool) (Object, error) {
	q, limit, e := queryInput(raw, "target", "after", "limit")
	if e != nil || limit > 30 {
		return nil, invalid()
	}
	if _, ok := q["limit"]; !ok {
		limit = 10
	}
	if v, ok := q["after"]; ok && !validID(asString(v)) {
		return nil, invalid()
	}
	if v, ok := q["target"]; ok && (v == nil || !validTarget(obj(q, "target"))) {
		return nil, invalid()
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		if account == "" && s.actor == nil {
			return nil, fail("official_account_login_required", 401)
		}
		var target any
		if q["target"] != nil {
			target = encode(q["target"])
		}
		var rr []Object
		var e error
		if affected {
			rr, e = rows(ctx, tx, `SELECT jsonb_build_object('id',id) FROM forum_reports_v1 WHERE (reporter_id=$1 OR target_author_id=$1 OR account_governance AND (reporter_account_id=$5::uuid OR target_author_account_id=$5::uuid)) AND ($2::uuid IS NULL OR id>$2) AND ($3::jsonb IS NULL OR target=$3::jsonb) ORDER BY id LIMIT $4`, s.subject(), q["after"], target, limit+1, null(account))
		} else {
			rr, e = rows(ctx, tx, `SELECT jsonb_build_object('id',r.id) FROM forum_reports_v1 r WHERE ($1::uuid IS NULL OR r.id>$1) AND ($2::jsonb IS NULL OR r.target=$2::jsonb) AND (r.reporter_id=$3 OR r.target_author_id=$3 OR r.account_governance AND (r.reporter_account_id=$4::uuid OR r.target_author_account_id=$4::uuid) OR EXISTS(SELECT 1 FROM forum_governance_events_v1 e JOIN forum_permissions_v1 p ON p.id=e.permission_id WHERE e.report_id=r.id AND p.viewers ? $3)) ORDER BY r.id LIMIT 200`, q["after"], target, s.subject(), null(account))
		}
		if e != nil {
			return nil, e
		}
		items := []Object{}
		var scanned any
		for i, r := range rr {
			if affected && int64(i) >= limit {
				break
			}
			scanned = r["id"]
			view, e := s.readReport(ctx, tx, account, str(r, "id"))
			if e != nil {
				if faultCode(e) == "not_found" {
					continue
				}
				return nil, e
			}
			if affected {
				view = Object{"reportId": view["reportId"], "target": view["target"], "version": view["version"], "state": view["state"], "decisionLocator": view["decisionLocator"], "canAppeal": view["canAppeal"], "checkedAt": view["checkedAt"]}
			}
			items = append(items, view)
			if !affected && int64(len(items)) == limit {
				break
			}
		}
		var next any
		if affected {
			if int64(len(rr)) > limit {
				next = scanned
			}
		} else if int64(len(items)) == limit || len(rr) == 200 {
			next = scanned
		}
		out := Object{"items": items, "nextAfter": next, "checkedAt": s.clock()}
		if !affected {
			out["scanTruncated"] = len(rr) == 200 && int64(len(items)) < limit
		}
		return out, nil
	})
}
