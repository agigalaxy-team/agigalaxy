package identitygroups

import (
	"context"
	"github.com/jackc/pgx/v5"
	"time"
)

// CleanupWithin is the existing bounded 180-day operation/group retention.
// The retention owner supplies its transaction and existing maintenance role.
func CleanupWithin(ctx context.Context, tx pgx.Tx, now int64) (Object, error) {
	operations, approvals, groups := int64(0), int64(0), int64(0)
	old := time.Unix(now-180*86400, 0)
	rows, e := query(ctx, tx, "SELECT id FROM identity_groups_v2 WHERE (state='revoked' AND updated_at<=$1) OR source_erased_at<=$1 ORDER BY updated_at,id LIMIT 100 FOR UPDATE", old)
	if e != nil {
		return nil, e
	}
	for _, row := range rows {
		if _, e = tx.Exec(ctx, "UPDATE identity_groups_v2 SET current_operation_id=NULL WHERE id=$1", row["id"]); e != nil {
			return nil, e
		}
		tag, e := tx.Exec(ctx, "DELETE FROM identity_group_approvals_v2 WHERE operation_id IN (SELECT id FROM identity_group_operations_v2 WHERE group_id=$1)", row["id"])
		if e != nil {
			return nil, e
		}
		approvals += tag.RowsAffected()
		tag, e = tx.Exec(ctx, "DELETE FROM identity_group_operations_v2 WHERE group_id=$1", row["id"])
		if e != nil {
			return nil, e
		}
		operations += tag.RowsAffected()
		tag, e = tx.Exec(ctx, "DELETE FROM identity_groups_v2 WHERE id=$1", row["id"])
		if e != nil {
			return nil, e
		}
		groups += tag.RowsAffected()
	}
	abandoned, e := query(ctx, tx, "SELECT id FROM identity_group_operations_v2 WHERE state<>'committed' AND expires_at<=$1 ORDER BY expires_at,id LIMIT 100 FOR UPDATE", old)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for _, row := range abandoned {
		ids = append(ids, txt(row, "id"))
	}
	if len(ids) > 0 {
		tag, e := tx.Exec(ctx, "DELETE FROM identity_group_approvals_v2 WHERE operation_id=ANY($1::uuid[])", ids)
		if e != nil {
			return nil, e
		}
		approvals += tag.RowsAffected()
		tag, e = tx.Exec(ctx, "DELETE FROM identity_group_operations_v2 WHERE id=ANY($1::uuid[])", ids)
		if e != nil {
			return nil, e
		}
		operations += tag.RowsAffected()
	}
	tag, e := tx.Exec(ctx, "DELETE FROM identity_groups_v2 g WHERE state='proposed' AND NOT EXISTS(SELECT 1 FROM identity_group_operations_v2 o WHERE o.group_id=g.id) AND created_at<=$1", time.Unix(now-181*86400, 0))
	if e != nil {
		return nil, e
	}
	groups += tag.RowsAffected()
	return Object{"identityGroups": groups, "identityGroupOperations": operations, "identityGroupApprovals": approvals}, nil
}
