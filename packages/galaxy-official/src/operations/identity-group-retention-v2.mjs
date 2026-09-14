const iso=n=>new Date(n*1000).toISOString();
export async function cleanupIdentityGroupsWithin(db,now){
 let operations=0,approvals=0,groups=0;
 const oldGroups=(await db.query("SELECT id FROM identity_groups_v2 WHERE (state='revoked' AND updated_at<=$1) OR source_erased_at<=$1 ORDER BY updated_at,id LIMIT 100 FOR UPDATE",[iso(now-180*86400)])).rows;
 for(const {id}of oldGroups){await db.query('UPDATE identity_groups_v2 SET current_operation_id=NULL WHERE id=$1',[id]);
  approvals+=(await db.query('DELETE FROM identity_group_approvals_v2 WHERE operation_id IN (SELECT id FROM identity_group_operations_v2 WHERE group_id=$1)',[id])).rowCount;
  operations+=(await db.query('DELETE FROM identity_group_operations_v2 WHERE group_id=$1',[id])).rowCount;
  groups+=(await db.query('DELETE FROM identity_groups_v2 WHERE id=$1',[id])).rowCount;}
 const abandoned=(await db.query("SELECT id FROM identity_group_operations_v2 WHERE state<>'committed' AND expires_at<=$1 ORDER BY expires_at,id LIMIT 100 FOR UPDATE",[iso(now-180*86400)])).rows.map(x=>x.id);
 if(abandoned.length){approvals+=(await db.query('DELETE FROM identity_group_approvals_v2 WHERE operation_id=ANY($1::uuid[])',[abandoned])).rowCount;
  operations+=(await db.query('DELETE FROM identity_group_operations_v2 WHERE id=ANY($1::uuid[])',[abandoned])).rowCount;}
 groups+=(await db.query("DELETE FROM identity_groups_v2 g WHERE state='proposed' AND NOT EXISTS(SELECT 1 FROM identity_group_operations_v2 o WHERE o.group_id=g.id) AND created_at<=$1",[iso(now-181*86400)])).rowCount;
 return{identityGroups:groups,identityGroupOperations:operations,identityGroupApprovals:approvals};
}
