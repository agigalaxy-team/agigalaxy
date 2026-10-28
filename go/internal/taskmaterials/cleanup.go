package taskmaterials

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) CleanupWithin(ctx context.Context, tx pgx.Tx, at int64) (Object, error) {
	if at < 0 || s.Endpoint == "" {
		return nil, fail("task_material_retention_endpoint_required", 503)
	}
	current := *s
	current.Now = func() time.Time { return time.Unix(at, 0) }
	materials, e := rows(ctx, tx, "SELECT to_jsonb(m) FROM task_materials_v1 m WHERE erased_at IS NULL ORDER BY check_sequence,expires_at,material_id LIMIT 100 FOR UPDATE")
	if e != nil {
		return nil, e
	}
	erased := 0
	for _, m := range materials {
		state, e := current.StatusWithin(ctx, tx, m, false)
		if e != nil {
			return nil, e
		}
		if !state.Available && state.Permanent && m["erased_at"] == nil && str(m, "body_text") != "" {
			reason := "derived-content-erased"
			if contains(state.Reasons, "material-expired") {
				reason = "temporary-content-expired"
			}
			if _, e = tx.Exec(ctx, `INSERT INTO lifecycle_erasure_records(id,table_name,object_key,subject_id,reason,policy_version,original_payload_hash,request_id,erased_at,retained_until,account_id) VALUES($1,'task_materials_v1',$2,$3,$4,'galaxy-retention/v1-product-v2',$5,NULL,$6,$7,NULL) ON CONFLICT(table_name,object_key) DO NOTHING`, uuid.NewString(), m["material_id"], m["subject_id"], reason, m["text_hash"], stamp(at), stamp(at+180*86400)); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE task_materials_v1 SET body_text='',erased_at=$2 WHERE material_id=$1", m["material_id"], stamp(at)); e != nil {
				return nil, e
			}
			erased++
		} else {
			if _, e = tx.Exec(ctx, "UPDATE task_materials_v1 SET check_sequence=check_sequence+1 WHERE material_id=$1", m["material_id"]); e != nil {
				return nil, e
			}
		}
	}
	tag, e := tx.Exec(ctx, `DELETE FROM task_materials_v1 WHERE material_id IN(SELECT material_id FROM task_materials_v1 WHERE erased_at IS NOT NULL AND erased_at<=$1 ORDER BY erased_at,material_id LIMIT 100)`, stamp(at-180*86400))
	if e != nil {
		return nil, e
	}
	return Object{"taskMaterialBodiesErased": erased, "taskMaterialReceiptsRemoved": tag.RowsAffected()}, nil
}
