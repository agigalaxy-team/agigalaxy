package community

import (
	"context"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

func accountBytesSQL() string {
	queries := []string{}
	for _, table := range []string{"forum_posts_v1", "forum_versions_v1", "forum_replies_v1", "forum_events_v1", "forum_permissions_v1", "forum_reports_v1", "forum_governance_events_v1", "forum_write_receipts_v1"} {
		extra := ""
		switch table {
		case "forum_events_v1", "forum_governance_events_v1":
			extra = "+octet_length(payload_text)+octet_length(result::text)"
		case "forum_write_receipts_v1":
			extra = "+octet_length(locator::text)+octet_length(result::text)"
		case "forum_permissions_v1":
			extra = "+coalesce(octet_length(signer_public_key),0)+octet_length(fields::text)+octet_length(viewers::text)+octet_length(account_viewers::text)"
		case "forum_reports_v1":
			extra = "+octet_length(target::text)"
		}
		queries = append(queries, "SELECT coalesce(sum(1024"+extra+"),0)::bigint bytes FROM "+table+" WHERE account_id=$1")
	}
	queries = append(queries, "SELECT count(*)*512::bigint bytes FROM forum_daily_usage_v1 WHERE account_id=$1", "SELECT coalesce(sum(1024+octet_length(title)+octet_length(theme)+octet_length(description)+octet_length(audience::text)),0)::bigint bytes FROM forum_sections_v2 WHERE maintainer_account_id=$1", "SELECT coalesce(sum(1024+octet_length(payload_text)+octet_length(result::text)),0)::bigint bytes FROM forum_section_events_v2 WHERE account_id=$1", "SELECT count(*)*512::bigint bytes FROM forum_notification_reads_v2 WHERE account_id=$1", `SELECT coalesce(sum(coalesce(octet_length(c.signature_envelope),0)+coalesce(octet_length(c.signed_payload_text),0)+octet_length(c.intent::text)+512),0)::bigint bytes FROM consents c WHERE c.id IN (SELECT consent_id FROM forum_permissions_v1 WHERE account_id=$1 UNION SELECT consent_id FROM forum_write_receipts_v1 WHERE account_id=$1)`, `SELECT coalesce(sum(octet_length(to_jsonb(a)::text)+512),0)::bigint bytes FROM audit_events a WHERE a.consent_id IN (SELECT consent_id FROM forum_permissions_v1 WHERE account_id=$1 UNION SELECT consent_id FROM forum_write_receipts_v1 WHERE account_id=$1)`)
	return "SELECT coalesce(sum(bytes),0)::bigint FROM (" + strings.Join(queries, " UNION ALL ") + ") owned_forum_bytes"
}
func (s *Service) usage(ctx context.Context, tx pgx.Tx, account string) (int64, error) {
	var n int64
	e := tx.QueryRow(ctx, accountBytesSQL(), account).Scan(&n)
	return n, e
}
func (s *Service) writeAccount(ctx context.Context, tx pgx.Tx, id string, control bool) (Object, error) {
	r, e := row(ctx, tx, "SELECT to_jsonb(a) FROM community_accounts a WHERE id=$1 AND endpoint=$2 FOR UPDATE", id, s.Endpoint)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("account_target_unavailable", 403)
	}
	if !control && r["restricted_until"] != nil && seconds(r["restricted_until"]) > s.clock() {
		return nil, fail("community_restricted", 403)
	}
	return r, nil
}
func (s *Service) quota(ctx context.Context, tx pgx.Tx, account Object, category string) (Object, error) {
	tier := str(account, "tier_override")
	if tier == "" {
		tier = "new"
		days := s.PromotionDays
		if days == 0 {
			days = 7
		}
		if seconds(account["created_at"])+int64(days)*86400 <= s.clock() {
			var interaction bool
			if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_interactions WHERE account_id=$1 AND invalidated_at IS NULL)", account["id"]).Scan(&interaction); e != nil {
				return nil, e
			}
			if interaction {
				tier = "normal"
			}
		}
	}
	var used int64
	e := tx.QueryRow(ctx, "SELECT coalesce((SELECT used FROM forum_daily_usage_v1 WHERE account_id=$1 AND day=$2 AND category=$3),0)", account["id"], s.now().Format("2006-01-02"), category).Scan(&used)
	if e != nil {
		return nil, e
	}
	limit := num(obj(s.policy(), tier), category)
	remaining := limit - used
	if remaining < 0 {
		remaining = 0
	}
	return Object{"category": category, "limit": limit, "used": used, "remaining": remaining, "tier": tier, "resetAt": stamp(time.Unix((s.clock()/86400+1)*86400, 0)), "policyVersion": s.policy()["version"]}, nil
}
func (s *Service) finishBudget(ctx context.Context, tx pgx.Tx, account string, before int64, quota Object) (Object, error) {
	check := func() error {
		after, e := s.usage(ctx, tx, account)
		if e != nil {
			return e
		}
		if after > num(s.policy(), "accountForumMaxBytes") && after > before {
			return fail("forum_storage_quota_exceeded", 409)
		}
		return nil
	}
	if e := check(); e != nil {
		return nil, e
	}
	_, e := tx.Exec(ctx, `INSERT INTO forum_daily_usage_v1(account_id,day,category,used) VALUES($1,$2,$3,1) ON CONFLICT(account_id,day,category) DO UPDATE SET used=forum_daily_usage_v1.used+1`, account, s.now().Format("2006-01-02"), quota["category"])
	if e != nil {
		return nil, e
	}
	if e = check(); e != nil {
		return nil, e
	}
	out := clone(quota)
	out["used"] = num(quota, "used") + 1
	out["remaining"] = num(quota, "remaining") - 1
	return out, nil
}
