package community

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

type DeletionInfo struct {
	SubjectID         string
	At, RetainedUntil int64
	RequestID         *string
}

func eraseForumEvent(ctx context.Context, tx pgx.Tx, table string, r Object, at, retainedUntil int64, reason string, requestID *string) (bool, error) {
	if table != "forum_events_v1" && table != "forum_governance_events_v1" {
		return false, fmt.Errorf("unknown forum event table")
	}
	if str(r, "payload_text") == "" {
		return false, nil
	}
	account := r["account_id"]
	if r["subject_id"] != nil {
		account = nil
	}
	if _, e := tx.Exec(ctx, `INSERT INTO lifecycle_erasure_records(id,table_name,object_key,subject_id,reason,policy_version,original_payload_hash,request_id,erased_at,retained_until,account_id) VALUES($1,$2,$3,$4,$5,'galaxy-retention/v1-product-v2',$6,$7,$8,$9,$10) ON CONFLICT(table_name,object_key) DO NOTHING`, uuid.NewString(), table, r["id"], r["subject_id"], reason, r["payload_hash"], requestID, time.Unix(at, 0), time.Unix(retainedUntil, 0), account); e != nil {
		return false, e
	}
	_, e := tx.Exec(ctx, "UPDATE "+table+" SET payload_text='',erased_at=COALESCE(erased_at,$2) WHERE id=$1", r["id"], time.Unix(at, 0))
	return e == nil, e
}

// PrepareDeletionWithin is called only by the approved owner-deletion
// coordinator's transaction; no public subject locator invokes this method.
func (s *Service) PrepareDeletionWithin(ctx context.Context, tx pgx.Tx, info DeletionInfo) (Object, error) {
	counts := Object{}
	for _, table := range []string{"forum_events_v1", "forum_governance_events_v1"} {
		rr, e := rows(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT id,subject_id,payload_hash,payload_text FROM "+table+" WHERE subject_id=$1 AND payload_text<>'' ORDER BY id FOR UPDATE)q", info.SubjectID)
		if e != nil {
			return nil, e
		}
		for _, r := range rr {
			if _, e = eraseForumEvent(ctx, tx, table, r, info.At, info.RetainedUntil, "subject-deletion", info.RequestID); e != nil {
				return nil, e
			}
		}
		counts[table] = len(rr)
	}
	if _, e := tx.Exec(ctx, "UPDATE forum_posts_v1 SET state='withdrawn',current_version_id=NULL,erased_at=COALESCE(erased_at,$2) WHERE subject_id=$1", info.SubjectID, time.Unix(info.At, 0)); e != nil {
		return nil, e
	}
	for _, table := range []string{"forum_versions_v1", "forum_replies_v1"} {
		if _, e := tx.Exec(ctx, "UPDATE "+table+" SET state='withdrawn',erased_at=COALESCE(erased_at,$2) WHERE subject_id=$1", info.SubjectID, time.Unix(info.At, 0)); e != nil {
			return nil, e
		}
	}
	if _, e := tx.Exec(ctx, "UPDATE forum_permissions_v1 SET revoked_at=COALESCE(revoked_at,$2),erased_at=COALESCE(erased_at,$2) WHERE subject_id=$1", info.SubjectID, time.Unix(info.At, 0)); e != nil {
		return nil, e
	}
	return counts, nil
}
func (s *Service) MinimizeDeletionWithin(ctx context.Context, tx pgx.Tx, info DeletionInfo) (Object, error) {
	if _, e := s.PrepareDeletionWithin(ctx, tx, info); e != nil {
		return nil, e
	}
	for _, sql := range []string{"UPDATE forum_sections_v2 SET creator_subject_id=NULL WHERE creator_subject_id=$1", "UPDATE forum_section_events_v2 SET subject_id=NULL,consent_id=NULL WHERE subject_id=$1"} {
		if _, e := tx.Exec(ctx, sql, info.SubjectID); e != nil {
			return nil, e
		}
	}
	for _, table := range []string{"forum_posts_v1", "forum_versions_v1", "forum_replies_v1", "forum_events_v1", "forum_governance_events_v1", "forum_write_receipts_v1"} {
		extra := ""
		if hasString([]string{"forum_events_v1", "forum_governance_events_v1", "forum_write_receipts_v1"}, table) {
			extra = ",consent_id=NULL"
		}
		if _, e := tx.Exec(ctx, "UPDATE "+table+" SET subject_id=NULL,account_id=NULL"+extra+" WHERE subject_id=$1", info.SubjectID); e != nil {
			return nil, e
		}
	}
	for _, sql := range []string{"UPDATE forum_permissions_v1 SET subject_id=NULL,account_id=NULL,consent_id=NULL,origin_binding_id=NULL,source_device_id=NULL,source_key_id=NULL,signer_public_key='',fields='[]',viewers='[]' WHERE subject_id=$1", "UPDATE forum_reports_v1 SET subject_id=NULL,reporter_id=NULL,account_id=NULL WHERE subject_id=$1", "UPDATE forum_reports_v1 SET target_author_id=NULL WHERE target_author_id=$1"} {
		if _, e := tx.Exec(ctx, sql, info.SubjectID); e != nil {
			return nil, e
		}
	}
	return Object{"forumRetainedSourcesMinimized": true}, nil
}
func (s *Service) CleanupRetentionWithin(ctx context.Context, tx pgx.Tx, at int64) (Object, error) {
	var inputPolicy Object
	if e := protocol.Decode(encode(s.policy()), &inputPolicy); e != nil {
		return nil, e
	}
	policy, e := parseForumPolicy(inputPolicy)
	if e != nil {
		return nil, e
	}
	hash, e := ForumPolicyHash(policy)
	if e != nil {
		return nil, e
	}
	current := *s
	current.Now = func() time.Time { return time.Unix(at, 0) }
	current.actor = nil
	current.Authority = nil
	if current.Endpoint == "" {
		rr, e := rows(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT DISTINCT c.intent->>'endpoint' endpoint FROM forum_permissions_v1 p JOIN consents c ON c.id=p.consent_id LIMIT 2)q")
		if e != nil {
			return nil, e
		}
		if len(rr) > 1 {
			return nil, fmt.Errorf("forum retention endpoint required")
		}
		if len(rr) == 1 {
			current.Endpoint = str(rr[0], "endpoint")
		}
	}
	removed := Object{"forumBodies": int64(0), "forumGovernanceBodies": int64(0)}
	for _, table := range []string{"forum_events_v1", "forum_governance_events_v1"} {
		rr, e := rows(ctx, tx, `SELECT to_jsonb(e)||jsonb_build_object('permission_id',p.id) FROM `+table+` e LEFT JOIN forum_permissions_v1 p ON p.event_id=e.id LEFT JOIN consents c ON c.id=p.consent_id LEFT JOIN bindings b ON b.id=p.origin_binding_id LEFT JOIN subject_control_events ce ON ce.id=b.revocation_control_event_id WHERE e.payload_text<>'' AND (p.id IS NULL OR p.erased_at IS NOT NULL OR p.published_until<=$1 OR p.revoked_at IS NOT NULL OR (p.authorization_kind='official-account' AND p.account_id IS NULL) OR (p.authorization_kind='id-consent' AND (p.subject_id IS NULL OR c.expires_at<=$1 OR c.revoked_at IS NOT NULL OR b.id IS NULL OR b.revoked_at IS NOT NULL AND (b.revocation_kind IS DISTINCT FROM 'recovery' OR ce.kind IS DISTINCT FROM 'recover' OR ce.subject_id IS DISTINCT FROM p.subject_id)))) ORDER BY e.created_at,e.id LIMIT 100 FOR UPDATE OF e`, time.Unix(at, 0))
		if e != nil {
			return nil, e
		}
		for _, r := range rr {
			reasons := []string{"permission-unavailable"}
			if r["permission_id"] != nil {
				p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1", r["permission_id"])
				if e != nil {
					return nil, e
				}
				if p != nil {
					state, e := current.permissionDetailWithin(ctx, tx, p, "", true, false, &permissionSelector{SkipAudience: true})
					if e != nil {
						return nil, e
					}
					reasons = state.Detail["stoppedReasons"].([]string)
				}
			}
			onlyDeletion := true
			for _, reason := range reasons {
				onlyDeletion = onlyDeletion && reason == "deletion-pending"
			}
			if len(reasons) == 0 || onlyDeletion {
				continue
			}
			erased, e := eraseForumEvent(ctx, tx, table, r, at, at+num(policy, "auditDays")*86400, "temporary-content-expired", nil)
			if e != nil {
				return nil, e
			}
			if erased {
				key := "forumBodies"
				if table == "forum_governance_events_v1" {
					key = "forumGovernanceBodies"
				}
				removed[key] = num(removed, key) + 1
			}
		}
	}
	execCount := func(key, sql string, args ...any) error {
		tag, e := tx.Exec(ctx, sql, args...)
		if e == nil {
			removed[key] = tag.RowsAffected()
		}
		return e
	}
	if e = execCount("forumDailyUsage", `DELETE FROM forum_daily_usage_v1 WHERE (account_id,day,category) IN (SELECT account_id,day,category FROM forum_daily_usage_v1 WHERE day<$1::date ORDER BY day,account_id,category LIMIT 100)`, time.Unix(at-num(policy, "dailyUsageDays")*86400, 0)); e != nil {
		return nil, e
	}
	if e = execCount("forumReceipts", "DELETE FROM forum_write_receipts_v1 WHERE operation_id IN (SELECT operation_id FROM forum_write_receipts_v1 WHERE retained_until<=$1 ORDER BY retained_until,operation_id LIMIT 100)", time.Unix(at, 0)); e != nil {
		return nil, e
	}
	reports, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM public.galaxy_worker_lock_closed_forum_reports($1)r", time.Unix(at, 0))
	if e != nil {
		return nil, e
	}
	for _, r := range reports {
		if _, e = tx.Exec(ctx, "DELETE FROM forum_governance_events_v1 WHERE report_id=$1", r["id"]); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "DELETE FROM forum_reports_v1 WHERE id=$1", r["id"]); e != nil {
			return nil, e
		}
	}
	removed["forumClosedReports"] = len(reports)
	cutoff := time.Unix(at-num(policy, "auditDays")*86400, 0)
	for _, entry := range []struct{ key, sql string }{
		{"forumReplies", `DELETE FROM forum_replies_v1 r WHERE id IN (SELECT r.id FROM forum_replies_v1 r WHERE r.published_until<=$1 AND NOT EXISTS(SELECT 1 FROM forum_replies_v1 child WHERE child.reply_to_id=r.id) AND NOT EXISTS(SELECT 1 FROM forum_reports_v1 g WHERE g.target->>'replyId'=r.id::text) ORDER BY r.published_until,r.id LIMIT 100)`},
		{"forumVersions", `DELETE FROM forum_versions_v1 v WHERE id IN (SELECT v.id FROM forum_versions_v1 v WHERE v.published_until<=$1 AND NOT EXISTS(SELECT 1 FROM forum_replies_v1 r WHERE r.post_version_id=v.id) AND NOT EXISTS(SELECT 1 FROM forum_reports_v1 g WHERE g.target->>'versionId'=v.id::text) ORDER BY v.published_until,v.id LIMIT 100)`},
		{"forumHeads", `DELETE FROM forum_posts_v1 WHERE id IN (SELECT p.id FROM forum_posts_v1 p WHERE p.updated_at<=$1 AND NOT EXISTS(SELECT 1 FROM forum_versions_v1 v WHERE v.post_id=p.id) AND NOT EXISTS(SELECT 1 FROM forum_replies_v1 r WHERE r.post_id=p.id) ORDER BY p.updated_at,p.id LIMIT 100)`},
		{"forumEvents", `DELETE FROM forum_events_v1 e WHERE id IN (SELECT e.id FROM forum_events_v1 e WHERE e.payload_text='' AND e.created_at<=$1 AND NOT EXISTS(SELECT 1 FROM forum_versions_v1 v WHERE v.publication_event_id=e.id) AND NOT EXISTS(SELECT 1 FROM forum_replies_v1 r WHERE r.publication_event_id=e.id) ORDER BY e.created_at,e.id LIMIT 100)`},
	} {
		if e = execCount(entry.key, entry.sql, cutoff); e != nil {
			return nil, e
		}
	}
	var compact Object
	if e = tx.QueryRow(ctx, "SELECT public.galaxy_worker_prune_forum_authorizations($1)", time.Unix(at, 0)).Scan(&compact); e != nil {
		return nil, e
	}
	removed["forumPermissions"], removed["forumAuthorizationRecords"], removed["forumAcceptedAudits"], removed["forumPolicyHash"] = compact["permissions"], compact["consents"], compact["audits"], hash
	return removed, nil
}
