// The old attachment lifetime is read as a fact. This module does not set a
// relay lifetime, treat moderation as author deletion, or read source text.
const invalidUploadCodes=['attachment_too_large','attachment_digest_mismatch','attachment_file_format_invalid','attachment_media_type_mismatch','attachment_media_type_unrecognized'];
const iso=value=>value?new Date(value).toISOString():null;
const due=(value,now)=>value!=null&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now*1000;
export const fileCleanupTable=kind=>{if(kind==='chat')return'chat_attachments';if(kind==='forum')return'forum_attachments_v1';throw new TypeError('Unknown file kind');};

export function automaticFileCleanupSql(kind,alias='a'){
 fileCleanupTable(kind);if(alias!=='a')throw new TypeError('Unknown cleanup alias');
 const invalid=invalidUploadCodes.map(value=>"'"+value+"'").join(',');
 const unbound=kind==='chat'?'a.message_id IS NULL':"a.published_at IS NULL AND NOT EXISTS(SELECT 1 FROM forum_attachment_links_v1 l WHERE l.attachment_id=a.id)";
 const withdrawn=kind==='chat'?"EXISTS(SELECT 1 FROM chat_message_refs m WHERE m.message_id=a.message_id AND m.state='retracted')":
  `EXISTS(SELECT 1 FROM forum_attachment_links_v1 l WHERE l.attachment_id=a.id) AND NOT EXISTS(
   SELECT 1 FROM forum_attachment_links_v1 l LEFT JOIN forum_posts_v1 p ON p.id=l.post_id LEFT JOIN forum_versions_v1 v ON v.id=l.version_id LEFT JOIN forum_replies_v1 r ON r.id=l.reply_id
   WHERE l.attachment_id=a.id AND NOT COALESCE(CASE WHEN l.reply_id IS NOT NULL THEN r.state='withdrawn' ELSE p.state='withdrawn' OR v.state='withdrawn' END,false))`;
 return `(a.revoked_at IS NOT NULL OR a.scan_result->>'state'='blocked' OR a.last_error IN(${invalid}) OR (${withdrawn}) OR
  ((${unbound}) AND COALESCE(a.expires_at,a.prepare_expires_at)<=$1 AND a.state IN('prepared','uploading','scan-pending','scanning') AND COALESCE(a.scan_result->>'state','')<>'clean'))`;
}

export async function fileCleanupSourceWithin(db,{kind,row,now,lock=false}){
 fileCleanupTable(kind);
 if(kind==='chat'){
  const message=row.message_id?(await db.query(`SELECT message_id,state,revision,expires_at FROM chat_message_refs WHERE message_id=$1${lock?' FOR SHARE NOWAIT':''}`,[row.message_id])).rows[0]:null;
  const references=message?[{id:message.message_id,state:message.state,revision:message.revision,until:iso(message.expires_at)}]:[];
  return{kind,references,truncated:false,linked:!!row.message_id,activeReferences:message?.state==='accepted'&&!due(message.expires_at,now)?1:0,explicitWithdrawal:message?.state==='retracted'};
 }
 const links=(await db.query(`SELECT source_key,post_id,version_id,reply_id,published_until FROM forum_attachment_links_v1 WHERE attachment_id=$1 ORDER BY source_key LIMIT 201${lock?' FOR SHARE NOWAIT':''}`,[row.id])).rows;
 if(links.length>200)return{kind,references:[],truncated:true,linked:true,activeReferences:null,explicitWithdrawal:false};
 const ids=key=>[...new Set(links.map(link=>link[key]).filter(Boolean))].sort((a,b)=>a<b?-1:a>b?1:0);
 const select=async(table,key)=>{const values=ids(key);return new Map((values.length?(await db.query(`SELECT id,state FROM ${table} WHERE id=ANY($1::uuid[]) ORDER BY id${lock?' FOR SHARE NOWAIT':''}`,[values])).rows:[]).map(value=>[value.id,value.state]));};
 // Upload/bind already locks the attachment. Source locks also prevent an
 // author transition while a concrete deletion is being checked and issued.
 const posts=await select('forum_posts_v1','post_id'),versions=await select('forum_versions_v1','version_id'),replies=await select('forum_replies_v1','reply_id');
 const references=links.map(link=>({id:link.source_key,postId:link.post_id,versionId:link.version_id,replyId:link.reply_id,
  postState:posts.get(link.post_id)??null,versionState:versions.get(link.version_id)??null,replyState:link.reply_id?replies.get(link.reply_id)??null:null,until:iso(link.published_until)}));
 return{kind,references,truncated:false,linked:!!row.published_at||links.length>0,
  activeReferences:references.filter(ref=>ref.postState==='published'&&ref.versionState==='published'&&(!ref.replyId||ref.replyState==='published')&&!due(ref.until,now)).length,
  explicitWithdrawal:references.length>0&&references.every(ref=>ref.replyId?ref.replyState==='withdrawn':ref.postState==='withdrawn'||ref.versionState==='withdrawn')};
}

export function fileCleanupEligibility(row,source,now){
 const expired=due(row.expires_at??row.prepare_expires_at,now),activeLease=!!row.lease_id&&!!row.lease_until&&!due(row.lease_until,now);
 let category='none',reason=null;
 if(row.purged_at||row.state==='erased')return{category:'removed',reason:'already-removed',eligible:false,blockedReason:null};
 if(row.revoked_at){category='automatic';reason='owner-revoked';}
 else if(row.scan_result?.state==='blocked'||invalidUploadCodes.includes(row.last_error)){category='automatic';reason='security-rejected';}
 else if(source.explicitWithdrawal){category='automatic';reason='source-withdrawn';}
 else if(!source.linked&&expired&&['prepared','uploading','scan-pending','scanning'].includes(row.state)&&row.scan_result?.state!=='clean'){category='automatic';reason='unfinished-upload';}
 else if(expired&&!(source.kind==='forum'&&source.activeReferences>0)){category='operational';reason='expired';}
 // A chat owner's retained export has its own attachment lifetime even after
 // the message expires. Losing that message is not early file eligibility.
 else if(source.kind==='forum'&&source.linked&&source.activeReferences===0){category='operational';reason='unreferenced';}
 const blockedReason=activeLease?'processing-active':category==='operational'&&source.truncated?'reference-check-incomplete':null;
 return{category,reason,eligible:category==='operational'&&!blockedReason,blockedReason};
}
