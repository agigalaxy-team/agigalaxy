import canonicalize from 'canonicalize';
import {digest} from './shared/digest.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {transaction} from './database.mjs';
import {PersonalSummaryService,createSummarySourceReader} from './personal-summaries.mjs';
import {sharedSummaryPublishSchema,sharedSummaryGetSchema,sharedSummaryPageSchema,sharedSummaryReceiptSchema} from './shared/chat-shared-summary-schema.mjs';
import {chatMessageOperationsBlockedWithin} from './chat-message-operations-gate.mjs';
const stamp=n=>new Date(n*1000).toISOString(),hash=x=>digest(canonicalize(x));
const fail=(c,s=409)=>{throw new ServiceError(c,s);};
function parse(schema,x){const p=schema.safeParse(x);if(!p.success)fail('invalid_shared_summary_request',400);return p.data;}
const notice=(shareId,agentGrantId)=>({clientMessageId:shareId,text:`银河共享摘要与关键消息：${shareId}`,replyTo:null,...(agentGrantId?{agentGrantId}:{})});

// A selected room version, separate from private replicas. The MAM message is a
// reference only: removing a source never leaves an equivalent summary body there.
export class ChatSharedSummaryService {
 constructor({db,access,chat,now=()=>access.now()}){Object.assign(this,{db,access,chat,now});
  this.filter=new PersonalSummaryService({db,access,sourceReader:createSummarySourceReader(chat),now});
  // Maintenance-only metadata reader: it clears invalid source copies even when
  // a room has no members. It never returns room contents to a caller.
  this.maintenanceFilter=new PersonalSummaryService({db,access,now,sourceReader:async(db,_actor,{roomId,messageId,revision})=>{
   const r=(await db.query(`SELECT m.*,EXISTS(SELECT 1 FROM chat_message_operations o WHERE o.message_id=m.message_id AND o.state='pending') AS edit_pending,
    EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased')) AS author_pending
    FROM chat_message_refs m WHERE m.message_id=$1 AND m.room_id=$2 FOR SHARE OF m`,[messageId,roomId])).rows[0];
   if(!r||r.state!=='accepted'||r.revision!==revision||Date.parse(r.expires_at)<=now()*1000)return{available:false};
    if(await chatMessageOperationsBlockedWithin(db,{messageId}))return{available:false,temporarilyUnavailable:true};
   return r.edit_pending||r.author_pending?{available:false,temporarilyUnavailable:true}:{available:true};
  }});
 }
 run(actor,write,fn){return write?this.access.runResourceWrite(actor,'binding',{},fn):this.access.runAuthorized(actor,'binding',fn);}
 async rowWithin(db,roomId,shareId){const row=(await db.query('SELECT * FROM room_shared_summaries WHERE room_id=$1 AND share_id=$2 FOR UPDATE',[roomId,shareId])).rows[0];
  if(!row)fail('shared_summary_unavailable',404);return row;}
 async authoredSourcesWithin(db,actor,roomId,content){const unique=new Map();
  for(const ref of [...content.fragments.flatMap(f=>f.sourceRefs),...content.keyMessageRefs])unique.set(ref.messageId+':'+ref.revision,ref);
  const facts=[];for(const ref of [...unique.values()].sort((a,b)=>a.messageId.localeCompare(b.messageId))){
   // Reject pending edits before the actual MAM exact-version read.
   const status=await this.filter.sourceReader(db,actor,{roomId,...ref});if(!status.available)fail('shared_summary_sources_unavailable');
   const source=await this.chat.readSelectedWithin(db,actor,ref);if(source.roomId!==roomId)fail('shared_summary_source_room_mismatch',403);
   facts.push({...ref,sequence:source.sequence,authorId:source.authorId,contentHash:source.contentHash,expiresAt:new Date(source.expiresAt).toISOString()});
  }return facts;
 }
 async reconcileWithin(db,row){if(!['pending','published'].includes(row.state))return row;
  const m=(await db.query('SELECT * FROM chat_message_refs WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3 FOR SHARE',[row.room_id,row.subject_id,row.share_id])).rows[0];
  if(m&&m.payload_hash!==row.notice_hash)fail('shared_summary_message_conflict');
  if(m&&Date.parse(m.expires_at)<Date.parse(row.expires_at)){await db.query('UPDATE room_shared_summaries SET expires_at=$2 WHERE share_id=$1',[row.share_id,m.expires_at]);row={...row,expires_at:m.expires_at};}
  const expired=Date.parse(row.expires_at)<=this.now()*1000||m&&Date.parse(m.expires_at)<=this.now()*1000;
  const removed=m&&['retracted','expired'].includes(m.state);
  if(expired||removed){const state=expired||m?.state==='expired'?'expired':'retracted';await db.query("UPDATE room_shared_summaries SET state=$2,content='{}'::jsonb,source_facts='[]'::jsonb,message_id=COALESCE(message_id,$3) WHERE share_id=$1",[row.share_id,state,m?.message_id??null]);
   return {...row,state,content:{},source_facts:[],message_id:m?.message_id??row.message_id};}
  if(m?.state==='accepted'&&(row.state!=='published'||!row.message_id)){await db.query("UPDATE room_shared_summaries SET state='published',message_id=$2 WHERE share_id=$1",[row.share_id,m.message_id]);return{...row,state:'published',message_id:m.message_id};}
  return row;
 }
 async requireVisibleWithin(db,actor,row){await this.chat.requireRoom(db,actor,row.room_id);
  if(row.state==='pending'&&row.subject_id!==actor.subjectId)fail('shared_summary_unavailable',404);
  if(row.subject_id!==actor.subjectId&&(await db.query("SELECT id FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased') LIMIT 1",[row.subject_id])).rows.length)fail('shared_summary_temporarily_unavailable',404);
 }
 async viewWithin(db,actor,row){row=await this.reconcileWithin(db,row);await this.requireVisibleWithin(db,actor,row);
   const noticeBlocked=row.message_id&&await chatMessageOperationsBlockedWithin(db,{messageId:row.message_id});
   let filtered=noticeBlocked?{content:{},storageChanged:false,invalidated:true,temporarilyUnavailable:true}:await this.filter.filterContentWithin(db,actor,row.room_id,row.content);
  // Per-viewer temporary restrictions cannot permanently erase the shared copy.
  // Permanent message expiry/version changes affect every allowed room reader.
  if(filtered.storageChanged){const retained=new Set([...(filtered.persistedContent.fragments??[]).flatMap(f=>f.sourceRefs??[]),...(filtered.persistedContent.keyMessageRefs??[])].map(r=>r.messageId+':'+r.revision));
   const facts=row.source_facts.filter(r=>retained.has(r.messageId+':'+r.revision));
   await db.query('UPDATE room_shared_summaries SET content=$2,source_facts=$3 WHERE share_id=$1',[row.share_id,JSON.stringify(filtered.persistedContent),JSON.stringify(facts)]);row.source_facts=facts;}
  // Source reads may await transport/permissions. A notice blocked during that
  // interval must not expose its body; the retained copy remains reversible.
  if(row.message_id&&await chatMessageOperationsBlockedWithin(db,{messageId:row.message_id}))filtered={content:{},storageChanged:false,invalidated:true,temporarilyUnavailable:true};
  const visible=new Set([...(filtered.content.fragments??[]).flatMap(f=>f.sourceRefs??[]),...(filtered.content.keyMessageRefs??[])].map(r=>r.messageId+':'+r.revision));
  return {shareId:row.share_id,roomId:row.room_id,authorId:row.subject_id,state:row.state,messageId:row.message_id,
   supersedesShareId:row.supersedes_share_id,createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString(),
   content:filtered.content,sourceFacts:row.source_facts.filter(r=>visible.has(r.messageId+':'+r.revision)),sourceInvalidated:filtered.invalidated===true,
   sourcesTemporarilyUnavailable:filtered.temporarilyUnavailable===true,audience:'room-authorized-members',publicationPermission:false,
   personalVersionChanged:false,acceptedByRoom:row.state==='published'};
 }
 async beforeSendWithin(db,actor,roomId,shareId,expectedContentHash){const ctx=await this.chat.requireRoom(db,actor,roomId,{write:true}),row=await this.rowWithin(db,roomId,shareId);
  if(row.subject_id!==actor.subjectId||!['pending','published'].includes(row.state)||Date.parse(row.expires_at)<=this.now()*1000)fail('shared_summary_send_unavailable');
  if(row.state==='pending'&&ctx.room.member_revision!==row.member_revision)fail('shared_summary_audience_changed');
  if(hash(row.content)!==expectedContentHash)fail('shared_summary_sources_changed_select_again');
  if(!row.content.fragments?.length&&!row.content.keyMessageRefs?.length)fail('shared_summary_sources_unavailable');
  const filtered=await this.filter.filterContentWithin(db,actor,roomId,row.content);if(filtered.invalidated)fail('shared_summary_sources_unavailable');
 }
 async publish(actor,input){const x=parse(sharedSummaryPublishSchema,input),requestHash=hash(x);
  const prepared=await this.run(actor,true,async db=>{const ctx=await this.chat.requireRoom(db,actor,x.roomId,{write:true});
   const prior=(await db.query('SELECT * FROM room_shared_summaries WHERE share_id=$1 FOR UPDATE',[x.shareId])).rows[0];
   if(prior){if(prior.subject_id!==actor.subjectId||prior.room_id!==x.roomId||prior.request_hash!==requestHash)fail('shared_summary_operation_conflict');return this.reconcileWithin(db,prior);}
   if(['archived','owner-succession'].includes(ctx.room.state))fail('chat_room_read_only');
   if(ctx.room.member_revision!==x.expectedMemberRevision)fail('shared_summary_audience_changed');
   await this.chat.agent(db,actor,x.roomId,x.agentGrantId,{send:true});
   if(x.supersedesShareId){const previous=await this.rowWithin(db,x.roomId,x.supersedesShareId);if(previous.subject_id!==actor.subjectId||previous.state==='pending')fail('shared_summary_correction_unavailable');}
   const facts=await this.authoredSourcesWithin(db,actor,x.roomId,x.content),n=this.now();
   await db.query(`INSERT INTO room_shared_summaries(share_id,subject_id,room_id,member_revision,request_hash,notice_hash,supersedes_share_id,content,source_facts,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[x.shareId,actor.subjectId,x.roomId,x.expectedMemberRevision,requestHash,hash(notice(x.shareId,x.agentGrantId)),x.supersedesShareId??null,JSON.stringify(x.content),JSON.stringify(facts),stamp(n),stamp(n+ctx.room.retention_days*86400)]);
   return this.rowWithin(db,x.roomId,x.shareId);
  });
  if(prepared.state==='pending')await this.chat.send(actor,x.roomId,notice(x.shareId,x.agentGrantId),{beforeSendWithin:db=>this.beforeSendWithin(db,actor,x.roomId,x.shareId,hash(x.content))});
  return this.get(actor,{roomId:x.roomId,shareId:x.shareId});
 }
 get(actor,input){const x=parse(sharedSummaryGetSchema,input);return this.run(actor,false,async db=>{await this.chat.requireRoom(db,actor,x.roomId);return this.viewWithin(db,actor,await this.rowWithin(db,x.roomId,x.shareId));});}
 receipt(actor,input){const x=parse(sharedSummaryReceiptSchema,input);return this.run(actor,false,async db=>{
  const base={...x,checkedAt:stamp(this.now()),currentAccessGranted:false,contentReturned:false,acceptedByRoom:false,othersReadStatus:'not-asserted'};
  // A historical operation receipt is independent of present room readership.
  // Never select its old content, source facts, members or archive body here.
  const row=(await db.query(`SELECT s.share_id,s.room_id,s.request_hash,s.notice_hash,s.state,s.message_id,s.expires_at,s.retracted_at,
   m.message_id AS notice_message_id,m.payload_hash AS notice_payload_hash,m.state AS notice_state,m.archive_id,m.expires_at AS notice_expires_at,m.purge_pending
   FROM room_shared_summaries s LEFT JOIN chat_message_refs m ON m.room_id=s.room_id AND m.subject_id=s.subject_id AND m.client_message_id=s.share_id
   WHERE s.share_id=$1 AND s.subject_id=$2`,[x.shareId,actor.subjectId])).rows[0];
  if(!row)return{...base,state:'absent'};
  if(row.room_id!==x.roomId||row.request_hash!==x.requestHash)return{...base,state:'conflict'};
  const message=row.notice_message_id?{message_id:row.notice_message_id,payload_hash:row.notice_payload_hash,state:row.notice_state,archive_id:row.archive_id,expires_at:row.notice_expires_at,purge_pending:row.purge_pending}:null;
  if(message&&message.payload_hash!==row.notice_hash)return{...base,state:'conflict'};
  const expired=Date.parse(row.expires_at)<=this.now()*1000||message&&Date.parse(message.expires_at)<=this.now()*1000;
  const state=expired||row.state==='expired'?'expired':row.state==='retracted'||message?.state==='retracted'?'retracted':message?.state==='accepted'?'published':'pending';
  const messageState=!message?'not-found':Date.parse(message.expires_at)<=this.now()*1000?'expired':message.state;
  return{...base,state,messageId:message?.message_id??row.message_id??null,messageState,acceptedByRoom:state==='published',
   historicalAcceptanceRecorded:!!message?.archive_id,summaryContentHidden:['retracted','expired'].includes(state),noticeRetractionRecorded:message?.state==='retracted',
   noticeCleanupState:!message?'not-recorded':message.purge_pending?'pending':['retracted','expired'].includes(message.state)?'recorded-complete':'not-requested',archiveScope:'shared-summary-notice-only'};
 });}
 list(actor,input){const x=parse(sharedSummaryPageSchema,input);return this.run(actor,false,async db=>{await this.chat.requireRoom(db,actor,x.roomId);
  const rows=(await db.query('SELECT * FROM room_shared_summaries WHERE room_id=$1 AND ($2::uuid IS NULL OR share_id>$2) ORDER BY share_id LIMIT $3 FOR UPDATE',[x.roomId,x.after??null,x.limit+1])).rows;
  const items=[];for(const r of rows.slice(0,x.limit)){try{items.push(await this.viewWithin(db,actor,r));}catch(e){if(!(e instanceof ServiceError)||![403,404].includes(e.status))throw e;}}
  return{items,nextAfter:rows.length>x.limit?rows[x.limit-1].share_id:null,historyRemainsAvailable:true};});}
 async retract(actor,input){const x=parse(sharedSummaryGetSchema,input);const r=await this.run(actor,false,async db=>{
  const prior=(await db.query('SELECT state FROM room_shared_summaries WHERE room_id=$1 AND share_id=$2 AND subject_id=$3',[x.roomId,x.shareId,actor.subjectId])).rows[0];
  if(!prior)fail('shared_summary_author_required',403);
  // A first withdrawal needs current room permission. Once its exact owned
  // stop is recorded, leaving cannot prevent completion of that original stop.
  if(prior.state!=='retracted')await this.chat.requireRoom(db,actor,x.roomId,{write:true});
  const row=await this.rowWithin(db,x.roomId,x.shareId);if(row.subject_id!==actor.subjectId)fail('shared_summary_author_required',403);
  await db.query("UPDATE room_shared_summaries SET state='retracted',content='{}'::jsonb,source_facts='[]'::jsonb,retracted_at=COALESCE(retracted_at,$2) WHERE share_id=$1",[x.shareId,stamp(this.now())]);
  return row;});
  const message=await this.run(actor,false,async db=>{
   const owned=(await db.query('SELECT message_id,payload_hash,state,purge_pending FROM chat_message_refs WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3 FOR UPDATE',[x.roomId,actor.subjectId,x.shareId])).rows[0];
   if(!owned)return null;if(owned.payload_hash!==r.notice_hash)fail('shared_summary_message_conflict');
   if(['accepted','pending'].includes(owned.state)){await db.query("UPDATE chat_message_refs SET state='retracted',purge_pending=true,retracted_at=COALESCE(retracted_at,$2) WHERE message_id=$1",[owned.message_id,stamp(this.now())]);return{...owned,state:'retracted',purge_pending:true};}
   return owned;
  });
  let noticeArchiveDeleted=false,noticeCleanupPending=!!message?.purge_pending;
  if(message&&['retracted','expired'].includes(message.state)){
   if(!message.purge_pending)noticeArchiveDeleted=true;
   else try{await this.chat.purgeOne(message.message_id);noticeArchiveDeleted=true;noticeCleanupPending=false;}catch(error){if(!(error instanceof ServiceError))throw error;}
  }
  return{shareId:x.shareId,retracted:true,personalVersionDeleted:false,messageId:message?.message_id??r.message_id??null,
   noticeRetractionRecorded:message?.state==='retracted',noticeArchiveDeleted,noticeCleanupPending,archiveScope:'shared-summary-notice-only'};
 }
 async eraseSubjectWithin(db,subjectId){const r=await db.query("UPDATE room_shared_summaries SET state='retracted',content='{}'::jsonb,source_facts='[]'::jsonb,retracted_at=COALESCE(retracted_at,$2) WHERE subject_id=$1 AND state IN ('pending','published') RETURNING share_id",[subjectId,stamp(this.now())]);
  return{erasedShares:r.rows.length,remainingMetadata:true,noticeDeletionDelegatedToChat:true};}
 async exportOwnedWithin(db,actor,{after=null,limit=20}={}){if(after)parse(sharedSummaryGetSchema,{roomId:after,shareId:after});if(!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_shared_summary_request',400);
  const rows=(await db.query('SELECT share_id,room_id FROM room_shared_summaries WHERE subject_id=$1 AND ($2::uuid IS NULL OR share_id>$2) ORDER BY share_id LIMIT $3',[actor.subjectId,after,limit+1])).rows;
  const items=[];for(const r of rows.slice(0,limit)){try{await this.chat.requireRoom(db,actor,r.room_id);items.push(await this.viewWithin(db,actor,await this.rowWithin(db,r.room_id,r.share_id)));}
   catch(e){if(!(e instanceof ServiceError)||![403,404].includes(e.status))throw e;items.push({shareId:r.share_id,roomId:r.room_id,content:null,reason:'current_room_permission_required'});}}
  return{items,nextAfter:rows.length>limit?rows[limit-1].share_id:null,scope:'own-shares-with-current-source-permission'};
 }
 async purgeExpired({limit=100}={}){if(!Number.isInteger(limit)||limit<1||limit>1000)fail('invalid_shared_summary_request',400);return transaction(this.db,async db=>{const rows=(await db.query("SELECT * FROM room_shared_summaries WHERE state IN ('pending','published') AND expires_at<=$1 ORDER BY share_id LIMIT $2 FOR UPDATE",[stamp(this.now()),limit])).rows;
  for(const row of rows)await this.reconcileWithin(db,row);return{expiredShares:rows.length};});}
 async purgeInvalidSources({after=null,limit=20}={}){if(after)parse(sharedSummaryGetSchema,{roomId:after,shareId:after});if(!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_shared_summary_request',400);
  return transaction(this.db,async db=>{const rows=(await db.query("SELECT * FROM room_shared_summaries WHERE state IN ('pending','published') AND ($1::uuid IS NULL OR share_id>$1) ORDER BY share_id LIMIT $2 FOR UPDATE",[after,limit+1])).rows;let changed=0;
   for(const row of rows.slice(0,limit)){const reconciled=await this.reconcileWithin(db,row);if(reconciled.state!==row.state){changed++;continue;}
    const filtered=await this.maintenanceFilter.filterContentWithin(db,null,row.room_id,row.content);
    if(filtered.storageChanged){const refs=new Set([...(filtered.persistedContent.fragments??[]).flatMap(f=>f.sourceRefs),...(filtered.persistedContent.keyMessageRefs??[])].map(r=>r.messageId+':'+r.revision));
     await db.query('UPDATE room_shared_summaries SET content=$2,source_facts=$3 WHERE share_id=$1',[row.share_id,JSON.stringify(filtered.persistedContent),JSON.stringify(row.source_facts.filter(r=>refs.has(r.messageId+':'+r.revision)))]);changed++;}
   }return{checked:Math.min(rows.length,limit),changed,nextAfter:rows.length>limit?rows[limit-1].share_id:null};});}
}
