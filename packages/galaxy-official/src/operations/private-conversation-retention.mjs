// Expire only the owner's explicitly configured archive copies. This category
// has no default TTL and does not inherit personal-summary/chat retention.
export async function expirePrivateConversationsWithin(db,at,{limit=100,accountId=null,originSubjectId=null}={}){
  const result=await db.query(`WITH expired AS (
    DELETE FROM private_conversation_archives_v1 WHERE id IN
      (SELECT id FROM private_conversation_archives_v1 WHERE expires_at<=$1 AND ($3::uuid IS NULL OR account_id=$3) AND ($4::text IS NULL OR origin_subject_id=$4)
       ORDER BY expires_at,id LIMIT $2) RETURNING id,account_id,selection,origin_subject_id
  ) INSERT INTO private_conversation_deletions_v1(archive_id,account_id,scope_id,origin_subject_id,reason,deleted_at)
    SELECT id,account_id,(selection->>'scopeId')::uuid,origin_subject_id,'expired',$1 FROM expired ON CONFLICT(archive_id) DO NOTHING RETURNING archive_id`,[new Date(at*1000).toISOString(),limit,accountId,originSubjectId]);
  return result.rows.map(row=>row.archive_id);
}
export async function cleanupPrivateConversationsWithin(db,at,options){
  return {privateConversationArchives:(await expirePrivateConversationsWithin(db,at,options)).length};
}
