// Message IDs are globally unique in chat_message_refs. Each independently
// authorized case contributes its own block; releasing one case never releases
// another. A later author edit does not remove an existing message-level block.
export function chatMessageOperationsBlockedSql(alias='m'){
 if(!/^[a-z][a-z0-9_]*$/i.test(alias))throw Error('Internal message SQL alias required.');
 return `EXISTS(SELECT 1 FROM operations_chat_message_visibility_v1 ov WHERE ov.message_id=${alias}.message_id AND ov.hidden)`;
}
export async function chatMessageOperationsBlockedWithin(db,{messageId}){
 return !!(await db.query('SELECT 1 FROM operations_chat_message_visibility_v1 WHERE message_id=$1 AND hidden LIMIT 1',[messageId])).rows.length;
}
