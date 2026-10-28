package qualification

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CleanupRequestsWithin retains the existing maintenance role/transaction seam.
// It does not start a queue or grant an HTTP caller maintenance privileges.
func (s *Service) CleanupRequestsWithin(ctx context.Context, tx pgx.Tx, at int64) (Object, error) {
	rows, e := readRows(ctx, tx, `SELECT to_jsonb(x) FROM (SELECT e.id,e.subject_id,e.payload_hash,r.expires_at FROM qualification_permission_request_events e JOIN qualification_permission_requests r ON r.id=e.request_id WHERE r.expires_at<=$1 AND e.payload_text<>'' ORDER BY r.expires_at,e.id LIMIT 100 FOR UPDATE OF e)x`, time.Unix(at, 0))
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for _, r := range rows {
		expiry, e := timestamp(r["expires_at"])
		if e != nil {
			return nil, e
		}
		retained := max(at*1000, expiry.UnixMilli()+180*86400000)
		if _, e = tx.Exec(ctx, "INSERT INTO lifecycle_erasure_records(id,table_name,object_key,subject_id,reason,policy_version,original_payload_hash,request_id,erased_at,retained_until,account_id) VALUES($1,'qualification_permission_request_events',$2,$3,'temporary-content-expired','galaxy-retention/v1-product-v2',$4,NULL,$5,$6,NULL) ON CONFLICT(table_name,object_key) DO NOTHING", uuid.NewString(), r["id"], r["subject_id"], r["payload_hash"], time.Unix(at, 0), time.UnixMilli(retained)); e != nil {
			return nil, e
		}
		ids = append(ids, str(r, "id"))
	}
	if len(ids) > 0 {
		if _, e = tx.Exec(ctx, "UPDATE qualification_permission_request_events SET payload_text='' WHERE id=ANY($1::uuid[])", ids); e != nil {
			return nil, e
		}
	}
	parents, e := readRows(ctx, tx, "SELECT jsonb_build_object('id',id) FROM qualification_permission_requests WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 50 FOR UPDATE", time.Unix(at-180*86400, 0))
	if e != nil {
		return nil, e
	}
	parentIDs := []string{}
	for _, p := range parents {
		parentIDs = append(parentIDs, str(p, "id"))
	}
	removed := int64(0)
	if len(parentIDs) > 0 {
		tag, e := tx.Exec(ctx, "DELETE FROM qualification_permission_request_events WHERE request_id=ANY($1::uuid[])", parentIDs)
		if e != nil {
			return nil, e
		}
		removed = tag.RowsAffected()
		if _, e = tx.Exec(ctx, "DELETE FROM qualification_permission_requests WHERE id=ANY($1::uuid[])", parentIDs); e != nil {
			return nil, e
		}
	}
	return Object{"qualificationRequestBodies": len(rows), "qualificationRequestEvents": removed, "qualificationRequestReceipts": len(parents)}, nil
}
