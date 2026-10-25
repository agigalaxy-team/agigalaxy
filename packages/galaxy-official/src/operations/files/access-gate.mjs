import {ServiceError} from '../../shared/service-error.mjs';

const seconds=value=>value==null?null:Math.floor(new Date(value).getTime()/1000);
const expired=(value,now)=>value==null||!Number.isFinite(seconds(value))||seconds(value)<=now;

// The caller's existing transaction and source authority stay in charge.
// All writers first lock the same attachment row as its byte readers/binders.
export async function fileAccessWithin(db,{endpoint,kind,id,now,detail=false}){
 const columns=detail?'revision,stopped_until,operation_id,operator_id,reason,updated_at':'revision,stopped_until';
 const row=(await db.query(`SELECT ${columns} FROM operations_file_access_heads_v1 WHERE endpoint=$1 AND kind=$2 AND file_id=$3`,[endpoint,kind,id])).rows[0];
 const until=seconds(row?.stopped_until);
 return{revision:row?.revision??0,stopped:until!==null&&until>now,until,operationId:row?.operation_id??null,
  operatorId:row?.operator_id??null,reason:row?.reason??null,changedAt:row?.updated_at?new Date(row.updated_at).toISOString():null};
}
export async function assertFileAccessWithin(db,input){
 const access=await fileAccessWithin(db,input);if(access.stopped)throw new ServiceError('attachment_content_unavailable',404);return access;
}
export async function fileAccessReceiptWithin(db,input,receipt){
 const access=await fileAccessWithin(db,input);
 return{...receipt,processingState:receipt.state,state:access.stopped&&!['erased','revoked','expired','blocked'].includes(receipt.state)?'unavailable':receipt.state,
  ...(access.stopped?{contentAvailable:false}:{}),access:{stopped:access.stopped,until:access.until}};
}

// Restoration checks current source permission without selecting payload_text
// or pretending the operator is the file author, room member or viewer. Each
// actual download still checks its own caller and exact source before/after I/O.
export async function fileAccessRestorationWithin(db,{kind,row,service,now}){
 if(!row||row.purged_at||row.revoked_at||row.purge_pending||row.state!=='available'||expired(row.expires_at??row.prepare_expires_at,now)
  ||await service?.authorPending(db,row))return'file-unavailable';
 if(kind==='chat'){
  if(!row.message_id)return null;
  const message=(await db.query('SELECT state,expires_at FROM chat_message_refs WHERE message_id=$1 AND room_id=$2',[row.message_id,row.room_id])).rows[0];
  return message?.state==='accepted'&&!expired(message.expires_at,now)?null:'source-unavailable';
 }
 if(kind!=='forum'||!service?.forum?.permissions)return'source-unavailable';
 const links=(await db.query('SELECT post_id,version_id,reply_id,published_until FROM forum_attachment_links_v1 WHERE attachment_id=$1 ORDER BY source_key LIMIT 201',[row.id])).rows;
 if(!links.length)return row.published_at?'source-unavailable':null;
 if(links.length>200)return'source-unavailable';
 const allowed=async(source,action,objectId)=>{
  if(!source||source.state!=='published'||source.erased_at||source.event_erased||expired(source.published_until,now))return false;
  const status=await service.forum.permissions.statusWithin(db,source.permission_id,{payloadHash:source.payload_hash,action,objectId,checkAudience:false,ignoreOperationsVisibility:true});
  return status.allowed;
 };
 for(const link of links){
  if(expired(link.published_until,now))continue;
  const parent=(await db.query(`SELECT v.id,v.state,v.permission_id,v.payload_hash,v.published_until,v.erased_at,p.state AS post_state,
   p.erased_at AS post_erased,e.erased_at AS event_erased FROM forum_versions_v1 v JOIN forum_posts_v1 p ON p.id=v.post_id
   LEFT JOIN forum_events_v1 e ON e.id=v.publication_event_id WHERE v.id=$1 AND v.post_id=$2`,[link.version_id,link.post_id])).rows[0];
  if(parent?.post_state!=='published'||parent.post_erased||!await allowed(parent,'forum.post.publish',link.version_id))continue;
  if(!link.reply_id)return null;
  const reply=(await db.query(`SELECT r.id,r.state,r.permission_id,r.payload_hash,r.published_until,r.erased_at,e.erased_at AS event_erased
   FROM forum_replies_v1 r LEFT JOIN forum_events_v1 e ON e.id=r.publication_event_id WHERE r.id=$1 AND r.post_id=$2 AND r.post_version_id=$3`,[link.reply_id,link.post_id,link.version_id])).rows[0];
  if(await allowed(reply,'forum.reply.publish',link.reply_id))return null;
 }
 return'source-unavailable';
}
