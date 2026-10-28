package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) Quotas(ctx context.Context, account string, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil || !strict(q, "postId", "replyId", "sectionId") || len(q) > 1 {
		return nil, invalid()
	}
	for _, v := range q {
		if !validID(asString(v)) {
			return nil, invalid()
		}
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		if account == "" && s.actor == nil {
			return nil, fail("official_account_login_required", 401)
		}
		if len(q) > 0 {
			var r Object
			var e error
			switch {
			case q["postId"] != nil:
				r, e = s.head(ctx, tx, str(q, "postId"), false)
			case q["replyId"] != nil:
				r, e = s.reply(ctx, tx, str(q, "replyId"))
			case q["sectionId"] != nil:
				r, e = s.section(ctx, tx, str(q, "sectionId"))
			}
			if e != nil {
				return nil, e
			}
			if r == nil {
				return nil, fail("not_found", 404)
			}
			if s.actor != nil {
				account, e = s.viewerForRow(ctx, tx, account, r)
				if e != nil {
					return nil, e
				}
			}
			if !s.owns(r, account) && str(r, "maintainer_account_id") != account {
				return nil, fail("not_found", 404)
			}
		}
		availableRows := []Object{}
		var a Object
		var e error
		if s.actor != nil {
			availableRows, e = s.availableIdentityAccounts(ctx, tx)
			if e != nil {
				return nil, e
			}
			a, e = s.resolveIdentityAccount(ctx, tx, account, false)
		} else {
			a, e = row(ctx, tx, `SELECT to_jsonb(a)||jsonb_build_object('display_name',p.display_name,'avatar_key',p.avatar_key,'subject_type',p.subject_type) FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2`, account, s.Endpoint)
			if a != nil {
				availableRows = append(availableRows, a)
			}
		}
		base := Object{"policy": s.policy(), "policyHash": s.policyHash(), "restriction": nil, "publication": Object{"checkedAt": s.clock(), "minPublishedUntil": s.clock() + 1, "maxPublishedUntil": s.clock() + num(s.policy(), "maxPermissionSeconds"), "maxPermissionSeconds": num(s.policy(), "maxPermissionSeconds")}}
		availableViews := []Object{}
		for _, r := range availableRows {
			view := accountView(r, account)
			view["verificationMethod"] = r["verification_method"]
			availableViews = append(availableViews, view)
		}
		base["availableAccounts"] = availableViews
		if e != nil {
			if faultCode(e) == "account_verification_required" || faultCode(e) == "account_selection_required" {
				base["accountId"] = nil
				base["currentAccount"] = nil
				base["accountVerified"] = faultCode(e) != "account_verification_required"
				if faultCode(e) == "account_selection_required" {
					base["accountSelectionRequired"] = true
				}
				base["quotas"] = []Object{}
				base["reason"] = faultCode(e)
				return base, nil
			}
			return nil, e
		}
		if a == nil {
			return nil, fail("account_verification_required", 403)
		}
		account = str(a, "id")
		current := accountView(a, account)
		for _, view := range availableViews {
			view["current"] = str(view, "id") == account
		}
		quotas := []Object{}
		for _, category := range []string{"post", "version", "reply", "report"} {
			quota, e := s.quota(ctx, tx, a, category)
			if e != nil {
				return nil, e
			}
			quotas = append(quotas, quota)
		}
		usage, e := s.usage(ctx, tx, account)
		if e != nil {
			return nil, e
		}
		var restriction any
		if a["restricted_until"] != nil && seconds(a["restricted_until"]) > s.clock() {
			t, _ := time.Parse(time.RFC3339Nano, str(a, "restricted_until"))
			restriction = Object{"until": stamp(t), "reason": a["restriction_reason"]}
		}
		base["restriction"] = restriction
		base["accountId"] = account
		base["currentAccount"] = current
		base["accountVerified"] = true
		base["accountSelectionRequired"] = false
		base["quotas"] = quotas
		base["storage"] = Object{"usedBytes": usage, "maxBytes": s.policy()["accountForumMaxBytes"]}
		return base, nil
	})
}
func accountView(r Object, current string) Object {
	return Object{"id": r["id"], "accountId": r["id"], "uid": r["uid"], "displayName": r["display_name"], "avatarKey": r["avatar_key"], "subjectType": r["subject_type"], "endpoint": r["endpoint"], "current": str(r, "id") == current}
}
