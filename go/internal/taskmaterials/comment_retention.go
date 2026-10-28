package taskmaterials

import (
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CleanupCommentsWithin is the original retained temporary comment/governance
// cleanup, invoked only in the maintenance caller's already-authorized tx.
func (s *Service) CleanupCommentsWithin(ctx context.Context, tx pgx.Tx, at int64) (Object, error) {
	expired, e := rows(ctx, tx, `SELECT jsonb_build_object('id',e.id,'subject_id',e.subject_id,'payload_hash',e.payload_hash) FROM task_comment_events_v2 e JOIN task_comments_v2 c ON c.id=e.comment_id WHERE c.expires_at<=$1 AND e.payload_text<>'' ORDER BY c.expires_at,e.id LIMIT 100 FOR UPDATE OF e`, stamp(at))
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for _, r := range expired {
		if _, e = tx.Exec(ctx, `INSERT INTO lifecycle_erasure_records(id,table_name,object_key,subject_id,reason,policy_version,original_payload_hash,request_id,erased_at,retained_until,account_id) VALUES($1,'task_comment_events_v2',$2,$3,'temporary-content-expired','galaxy-retention/v1-product-v2',$4,NULL,$5,$6,NULL) ON CONFLICT(table_name,object_key) DO NOTHING`, uuid.NewString(), r["id"], r["subject_id"], r["payload_hash"], stamp(at), stamp(at+180*86400)); e != nil {
			return nil, e
		}
		ids = append(ids, str(r, "id"))
	}
	if len(ids) > 0 {
		if _, e = tx.Exec(ctx, "UPDATE task_comment_events_v2 SET payload_text='',text_fingerprint=NULL,link_fingerprints='[]',erased_at=$2 WHERE id=ANY($1::uuid[])", ids, stamp(at)); e != nil {
			return nil, e
		}
	}
	if _, e = tx.Exec(ctx, "UPDATE task_comments_v2 SET review_event_id=NULL WHERE expires_at<=$1 AND review_event_id IS NOT NULL", stamp(at)); e != nil {
		return nil, e
	}
	reports, e := rows(ctx, tx, "SELECT jsonb_build_object('id',id) FROM comment_reports_v2 WHERE closed_at<=$1 ORDER BY closed_at,id LIMIT 100 FOR UPDATE", stamp(at-180*86400))
	if e != nil {
		return nil, e
	}
	if len(reports) > 0 {
		ids := []string{}
		for _, r := range reports {
			ids = append(ids, str(r, "id"))
		}
		for _, sql := range []string{"UPDATE task_comments_v2 SET review_event_id=NULL WHERE review_event_id IN (SELECT id FROM comment_governance_events_v2 WHERE report_id=ANY($1::uuid[]))", "UPDATE comment_reports_v2 SET pause_event_id=NULL,decision_event_id=NULL WHERE id=ANY($1::uuid[])", "DELETE FROM comment_governance_events_v2 WHERE report_id=ANY($1::uuid[])", "DELETE FROM comment_reports_v2 WHERE id=ANY($1::uuid[])"} {
			if _, e = tx.Exec(ctx, sql, ids); e != nil {
				return nil, e
			}
		}
	}
	return Object{"expiredCommentBodies": len(expired), "closedGovernanceCases": len(reports)}, nil
}
