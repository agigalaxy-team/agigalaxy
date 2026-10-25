import {chatActorRef,chatActorView} from "../chat-actors.mjs";
import {chatPeopleSchema} from "../shared/chat-schema.mjs";
import {digest} from "../shared/digest.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {chatPageSchema,chatDirectorySchema,chatDirectoryCursorSchema,chatContextSchema} from "../shared/chat-schema.mjs";
import {roomRule,roomRuleHash,administrators} from "../chat-room-governance.mjs";
import {chatMessageOperationsBlockedWithin,chatMessageOperationsBlockedSql} from "../chat-message-operations-gate.mjs";
import {stamp,fail,parse,uuid} from './helpers.mjs';
import {ChatAuthority} from './base.mjs';

// Current room/message directories, selected-source reads and history. Existing source expiry, personal/operational hide and post-I/O checks remain authoritative.
export class ChatReadModel extends ChatAuthority{
 async people(actor,input={}){const x=parse(chatPeopleSchema,input);return this.run(actor,false,async db=>{
   if(!this.accounts)fail('chat_account_adapter_unavailable',503);
   if(x.accountId||x.accountIds){const rows=(await db.query(`SELECT a.id,a.uid,p.display_name,p.avatar_key,p.subject_type FROM community_accounts a
     LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=ANY($1::uuid[]) AND a.endpoint=$2`,[x.accountIds??[x.accountId],this.access.endpoint])).rows;
     return{items:rows.map(row=>({actorRef:'account:'+row.id,accountId:row.id,uid:row.uid,displayName:row.display_name??null,avatarKey:row.avatar_key??null,subjectType:row.subject_type??null})),nextAfter:null};}
   const page=await this.accounts.publicChoicesWithin(db,x);
   return{items:page.items.map(row=>({...row,actorRef:'account:'+row.id})),nextAfter:page.nextAfter};
 });}
 async readBookmarkWithin(db,actor,reference){
   if(reference?.kind!=='chat-message')fail('invalid_chat_request',400);
   uuid(reference.roomId);uuid(reference.messageId);
   try{
     const ctx=await this.requireRoom(db,actor,reference.roomId),rows=await this.messageRowsWithin(db,actor,reference.roomId,'m.message_id=$3',[reference.messageId]),row=rows[0];
     if(row?.operationally_hidden)return{state:'temporarily-unavailable',reason:'source-check-failed'};
     if(!row||row.personally_hidden||row.author_quarantined)return{state:'unavailable',reason:'source-not-readable'};
     if(row.state==='retracted')return{state:'unavailable',reason:'source-withdrawn'};
     if(row.state==='expired'||Date.parse(row.expires_at)<=this.now()*1000)return{state:'unavailable',reason:'source-expired'};
     const reading=await this.readMessagesWithin(db,actor,ctx,rows,{}),message=reading.messages[0];
     if(!message)return{state:'unavailable',reason:'source-not-readable'};
     const text=message.text?.trim()||message.attachments?.filter(file=>file.state==='available').map(file=>file.name).filter(Boolean).join('、');
     if(!text)return{state:'unavailable',reason:'source-not-readable'};
     const author=chatActorView(message.subjectId);
     return{state:'available',title:ctx.room.title,summary:text.slice(0,360),availableUntil:Math.min(reading.readExpiresAt,this.now()+15),revision:message.revision,authorAccountId:author.accountId,authorId:author.galaxySubjectId};
   }catch(error){
     if(['chat_access_denied','chat_room_not_found'].includes(error.code))return{state:'unavailable',reason:'source-not-readable'};
     if(error instanceof ServiceError)return{state:'temporarily-unavailable',reason:'source-check-failed'};
     throw error;
   }
 }
 view(ctx){const {room:r,members,parties}=ctx;return{roomId:r.room_id,title:r.title,kind:r.kind,parentRoomId:r.parent_room_id,taskRefs:r.task_refs,
  revision:r.revision,memberRevision:r.member_revision,state:r.state,mode:r.mode,ownerSubjectId:r.owner_subject_id,persistent:r.persistent,
  retentionDays:r.retention_days,historyPolicy:'all-authorized-history',independentMemberCount:parties.length,
  joinRule:{...roomRule(r,this.now()),ruleHash:roomRuleHash(roomRule(r,this.now()))},administratorSubjectIds:administrators(ctx),successionExpiresAt:r.succession_expires_at,
  managementAuthority:{basis:'current-room-role-and-explicit-shared-rule',managerLimit:10,privateMaterialsGranted:false,otherAgentControlGranted:false},
  membershipBasis:'explicit-subject-and-verified-control-relationships',connectionCount:null,
  decisionRequired:r.state==='single-member-decision',members:members.map(m=>({subjectId:m.subject_id,actor:chatActorView(m.subject_id),uid:m.uid??null,displayName:m.display_name??null,joinedAt:m.joined_at,singleMemberPromptDismissed:m.dismissed_revision===r.revision})),
  transportAvailable:this.transport?.available===true,governance:ctx.governance};}
 async project(ctx){if(!this.transport)fail('chat_transport_unavailable',503);return this.transport.project({roomId:ctx.room.room_id,revision:ctx.room.revision,title:ctx.room.title,
  state:ctx.room.state,members:ctx.members.map(m=>m.subject_id)});}
 get(actor,roomId){return this.run(actor,false,async db=>this.view(await this.requireRoom(db,actor,roomId)));}
 list(actor,{after='',limit=50}={}){if(after)uuid(after);if(!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_chat_request',400);return this.run(actor,false,async db=>{
  const rows=(await db.query(`SELECT r.room_id FROM chat_rooms r JOIN chat_memberships m USING(room_id) WHERE m.subject_id=$1 AND m.left_at IS NULL
   AND ($2='' OR r.room_id::text>$2) ORDER BY r.room_id LIMIT $3`,[chatActorRef(actor),after,limit+1])).rows;
  const rooms=[];for(const row of rows.slice(0,limit))rooms.push(this.view(await this.requireRoom(db,actor,row.room_id)));
  return {rooms,next:rows.length>limit?rooms.at(-1).roomId:null};
 });}
 async directory(actor,input={}){const x=parse(chatDirectorySchema,input);
  // Only the candidate order is fixed for pagination. Current room/content
  // permission is checked in one transaction per room, so reading later rooms
  // does not keep earlier room SHARE locks across more archive I/O.
  const page=await this.run(actor,false,async db=>{
  let cursor=null;
  if(x.cursor){try{cursor=chatDirectoryCursorSchema.parse(JSON.parse(Buffer.from(x.cursor,'base64url').toString('utf8')));}
   catch{fail('invalid_chat_cursor',400);}
   if(cursor.subjectId!==chatActorRef(actor)||cursor.endpoint!==this.access.endpoint||(cursor.query??'')!==(x.query??''))fail('invalid_chat_cursor',400);
   if(cursor.expiresAt<=this.now())fail('chat_directory_cursor_expired',409);
  }
  const watermark=cursor?.watermark??String((await db.query('SELECT value FROM chat_directory_clock WHERE singleton=true')).rows[0].value);
  const asOf=cursor?.asOf??this.now(),expiresAt=cursor?.expiresAt??this.now()+900;
  const rows=(await db.query(`WITH candidates AS (
   SELECT r.room_id,COALESCE((SELECT MAX(q.accepted_order) FROM chat_message_refs q WHERE q.room_id=r.room_id AND q.accepted_order<=$2),r.created_order) AS sort_order
   FROM chat_rooms r JOIN chat_memberships m USING(room_id) WHERE m.subject_id=$1 AND m.left_at IS NULL
    AND r.created_order<=$2 AND m.joined_order<=$2
    AND ($6::text='' OR position(lower($6) in lower(r.title))>0 OR EXISTS(
      SELECT 1 FROM chat_memberships other JOIN chat_participants_v3 participant ON participant.actor_ref=other.subject_id
      JOIN community_accounts account ON account.id=participant.account_id
      JOIN official_account_profiles_v1 profile ON profile.account_id=participant.account_id
      WHERE other.room_id=r.room_id AND other.left_at IS NULL AND (position(lower($6) in lower(COALESCE(profile.display_name,'')))>0 OR account.uid=upper($6))))
  ) SELECT room_id,sort_order::text FROM candidates WHERE ($3::bigint IS NULL OR sort_order<$3 OR (sort_order=$3 AND room_id::text<$4))
   ORDER BY sort_order DESC,room_id DESC LIMIT $5`,[chatActorRef(actor),watermark,cursor?.lastOrder??null,cursor?.lastRoomId??'',x.limit+1,x.query??''])).rows;
  const last=rows[Math.min(rows.length,x.limit)-1];
  const nextCursor=rows.length>x.limit?Buffer.from(JSON.stringify({version:1,subjectId:chatActorRef(actor),endpoint:this.access.endpoint,watermark,asOf,expiresAt,
   lastOrder:last.sort_order,lastRoomId:last.room_id,...(x.query?{query:x.query}:{})})).toString('base64url'):null;
   return{rows:rows.slice(0,x.limit),watermark,nextCursor,asOf};
  });
  const rooms=[];
  for(const row of page.rows){
   try{rooms.push(await this.run(actor,false,db=>this.directoryRoomWithin(db,actor,row.room_id,page.watermark)));}
   catch(error){if(error instanceof ServiceError&&['chat_access_denied','chat_room_not_found'].includes(error.code))continue;throw error;}
  }
  return{rooms,nextCursor:page.nextCursor,asOf:page.asOf};
 }
 directoryReadableCondition(){return `m.state='accepted' AND m.expires_at>$4 AND NOT COALESCE(p.hidden,false) AND NOT ${chatMessageOperationsBlockedSql('m')}
  AND NOT (m.subject_id<>$2 AND EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id
   AND d.state IN ('requested','review-needed','approved','partial','primary-erased')))`;}
 directoryUnreadCondition(){return `m.actor_kind='human' AND m.subject_id<>$2
  AND NOT EXISTS(SELECT 1 FROM chat_human_message_reads h WHERE h.room_id=m.room_id AND h.subject_id=$2 AND h.message_id=m.message_id)
  AND NOT EXISTS(SELECT 1 FROM chat_cursors c WHERE c.room_id=m.room_id AND c.subject_id=$2 AND c.cursor_kind='human' AND c.agent_ref=''
   AND m.sequence<=c.sequence AND m.accepted_order<=c.accepted_order)`;}
 async directoryRoomWithin(db,actor,roomId,watermark){
  const ctx=await this.requireRoom(db,actor,roomId),base={...this.view(ctx),humanReadSequence:'0',readExpiresAt:this.now()+60};
  const activity=(await db.query('SELECT sent_at,accepted_at FROM chat_message_refs WHERE room_id=$1 AND accepted_order<=$2 ORDER BY accepted_order DESC LIMIT 1',[roomId,watermark])).rows[0];
  base.lastActivityAt=new Date(activity?.accepted_at??activity?.sent_at??ctx.room.created_at).toISOString();
  base.activityTimeBasis=activity?.accepted_at?'accepted-time':activity?'legacy-sent-time':'room-created';
  let projected=false;
  const metadata=async rows=>{
   if(!projected){await this.project(ctx);projected=true;}
   const request={roomId,subjectId:chatActorRef(actor),ids:rows.map(row=>row.archive_id),roomRevision:ctx.room.revision};
   const result=await (this.transport.readMetadata?.(request)??this.transport.read(request)),found=new Map(result.map(item=>[item.archiveId,item]));
   return rows.filter(row=>found.get(row.archive_id)?.revision===row.revision);
  };
  const candidates=(before,limit,unread)=>this.messageRowsWithin(db,actor,roomId,
   `m.accepted_order<=$3 AND ${this.directoryReadableCondition()} AND ($5::bigint IS NULL OR m.accepted_order<$5)${unread?' AND '+this.directoryUnreadCondition():''}`,
   [watermark,stamp(this.now()),before],'m.accepted_order DESC',limit);
  try{
   // Usually only one small batch is needed for the latest visible excerpt.
   // Missing archive records are skipped without inventing readable content.
   let latestMessage=null,before=null;
   while(!latestMessage){
    const rows=await candidates(before,20,false);if(!rows.length)break;
    const available=await metadata(rows);
    for(const latest of available){const reading=await this.readMessagesWithin(db,actor,ctx,[latest],{},{projected:true});
     latestMessage=reading.messages[0]??null;if(latestMessage){base.readExpiresAt=reading.readExpiresAt;break;}}
    before=String(rows.at(-1).accepted_order);
   }
   if(latestMessage?.text){const text=Array.from(latestMessage.text);latestMessage={...latestMessage,text:text.slice(0,300).join(''),excerptTruncated:text.length>300};}
   // Count all current unread humans, but never transport already-read history,
   // own messages or Agent cursors. The batches are not a count-limiting cap.
   const verified=[];before=null;
   while(true){
    const rows=await candidates(before,100,true);if(!rows.length)break;
    verified.push(...(await metadata(rows)).map(row=>row.message_id));
    before=String(rows.at(-1).accepted_order);
   }
   // Human reading/hiding can change during archive I/O. Recount the verified
   // IDs against the final current SQL state rather than a pre-I/O cursor.
   const count=(await db.query(`SELECT count(*)::int AS count,MIN(m.expires_at) AS expires_at FROM chat_message_refs m
    LEFT JOIN chat_message_preferences p ON p.message_id=m.message_id AND p.subject_id=$2
    WHERE m.room_id=$1 AND m.accepted_order<=$3 AND ${this.directoryReadableCondition()} AND ${this.directoryUnreadCondition()}
     AND m.message_id=ANY($5::uuid[])`,[roomId,chatActorRef(actor),watermark,stamp(this.now()),verified])).rows[0];
   const current=(await db.query("SELECT sequence::text FROM chat_cursors WHERE room_id=$1 AND subject_id=$2 AND cursor_kind='human' AND agent_ref=''",[roomId,chatActorRef(actor)])).rows[0];
   base.humanReadSequence=current?.sequence??'0';
   if(latestMessage){const rows=await this.messageRowsWithin(db,actor,roomId,'m.message_id=$3',[latestMessage.messageId]);
    if(!this.visibleRows(rows).some(row=>row.state==='accepted'&&row.revision===latestMessage.revision))latestMessage=null;}
   if(count.expires_at)base.readExpiresAt=Math.min(base.readExpiresAt,Math.floor(new Date(count.expires_at).getTime()/1000));
   return{...base,latestMessage,unreadHumanCount:count.count};
  }catch(error){if(!(error instanceof ServiceError))throw error;return{...base,latestMessage:null,unreadHumanCount:null,contentUnavailableReason:error.code};}
 }
 async messageRowsWithin(db,actor,roomId,condition='true',values=[],order='m.sequence ASC',limit=null){
  return(await db.query(`SELECT m.*,COALESCE(p.hidden,false) AS personally_hidden,
   ${chatMessageOperationsBlockedSql('m')} AS operationally_hidden,
   (m.subject_id<>$2 AND EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))) AS author_quarantined,
   (SELECT s.share_id FROM room_shared_summaries s WHERE s.room_id=m.room_id AND s.subject_id=m.subject_id AND s.share_id=m.client_message_id AND s.notice_hash=m.payload_hash) AS shared_summary_id
   FROM chat_message_refs m LEFT JOIN chat_message_preferences p ON p.message_id=m.message_id AND p.subject_id=$2
   WHERE m.room_id=$1 AND ${condition} ORDER BY ${order}${limit===null?'':' LIMIT $'+(values.length+3)}`,
   [roomId,chatActorRef(actor),...values,...(limit===null?[]:[limit])])).rows;
 }
 visibleRows(rows){return rows.filter(row=>!row.personally_hidden&&!row.operationally_hidden&&!row.author_quarantined&&['accepted','retracted'].includes(row.state)&&Date.parse(row.expires_at)>this.now()*1000);}
 async readMessagesWithin(db,actor,ctx,rows,input,{projected=false}={}){
  const visible=this.visibleRows(rows).filter(row=>(!input.author||row.subject_id===input.author)&&(!input.from||Date.parse(row.sent_at)>=Date.parse(input.from))&&(!input.to||Date.parse(row.sent_at)<=Date.parse(input.to)));
  let contents=[];const accepted=visible.filter(row=>row.state==='accepted');
  if(accepted.length){if(!projected)await this.project(ctx);contents=await this.transport.read({roomId:ctx.room.room_id,subjectId:chatActorRef(actor),ids:accepted.map(row=>row.archive_id),roomRevision:ctx.room.revision});}
  const bodies=new Map(contents.map(body=>[body.archiveId,body]));
  // Personal hiding can change while archive I/O is in flight. Recheck the
  // selected current rows rather than restoring the pre-I/O body projection.
  const current=rows.length?await this.messageRowsWithin(db,actor,ctx.room.room_id,'m.message_id=ANY($3::uuid[])',[rows.map(row=>row.message_id)]):[];
  const byId=new Map(this.visibleRows(current).map(row=>[row.message_id,row])),messages=[];
  for(const row of visible){const r=byId.get(row.message_id);if(!r)continue;const body=bodies.get(r.archive_id);
   if(r.state==='accepted'&&!body)continue;
   if(body&&body.revision!==undefined&&body.revision!==r.revision)fail('chat_message_reconciliation_required');
   if(input.keyword&&!body?.text?.toLocaleLowerCase().includes(input.keyword.toLocaleLowerCase()))continue;
   messages.push({...this.receipt(r),sequence:String(r.sequence),acceptedOrder:r.accepted_order===null?null:String(r.accepted_order),subjectId:r.subject_id,actor:chatActorView(r.subject_id),actorKind:r.actor_kind,agentGrantId:r.agent_grant_id,replyTo:r.reply_to,
    text:r.state==='retracted'?null:body.text,sharedSummaryId:r.state==='accepted'?r.shared_summary_id:null,editedAt:r.edited_at,retractedAt:r.retracted_at});
  }
  if(this.attachments){const files=await this.attachments.forMessagesWithin(db,actor,messages.map(message=>message.messageId));for(const message of messages)if(files.has(message.messageId))message.attachments=files.get(message.messageId);}
  const blocked=messages.length?new Set((await db.query(`SELECT m.message_id FROM chat_message_refs m WHERE m.message_id=ANY($1::uuid[]) AND ${chatMessageOperationsBlockedSql('m')}`,[messages.map(message=>message.messageId)])).rows.map(row=>row.message_id)):new Set();
  const permitted=messages.filter(message=>!blocked.has(message.messageId));
  return{messages:permitted,readExpiresAt:Math.min(this.now()+60,...permitted.map(message=>Math.floor(Date.parse(message.expiresAt)/1000)))};
 }
 async messageContext(actor,roomId,messageId,input={}){uuid(messageId);const x=parse(chatContextSchema,input);return this.run(actor,false,async db=>{
  const ctx=await this.requireRoom(db,actor,roomId),target=(await this.messageRowsWithin(db,actor,roomId,'m.message_id=$3',[messageId]))[0];
  if(!target)return{roomId,messageId,target:null,targetState:'unavailable',messages:[],previous:null,next:null,after:'0',scannedThrough:'0',complete:true,readExpiresAt:this.now()+60};
  const count=Math.floor(x.limit/2);
  const earlier=await this.messageRowsWithin(db,actor,roomId,'m.sequence<$3',[String(target.sequence)],'m.sequence DESC',count+1);
  const later=await this.messageRowsWithin(db,actor,roomId,'m.sequence>=$3',[String(target.sequence)],'m.sequence ASC',x.limit-count+1);
  const page=[...earlier.slice(0,count).reverse(),...later.slice(0,x.limit-count)],result=await this.readMessagesWithin(db,actor,ctx,page,{});
  const currentTarget=(await this.messageRowsWithin(db,actor,roomId,'m.message_id=$3',[messageId]))[0];
  const selected=result.messages.find(message=>message.messageId===messageId)??null;
  const targetState=currentTarget?.operationally_hidden?'unavailable':currentTarget?.personally_hidden?'hidden':currentTarget?.state==='retracted'?'retracted':
   currentTarget?.state==='expired'||currentTarget&&Date.parse(currentTarget.expires_at)<=this.now()*1000?'expired':selected?.state==='accepted'?'available':'unavailable';
  // A personal hide may complete after the archive read. A hidden/unavailable
  // target is not returned through either the focus field or its window.
  if(!['available','retracted'].includes(targetState))result.messages=result.messages.filter(message=>message.messageId!==messageId);
  return{roomId,messageId,target:['available','retracted'].includes(targetState)?selected:null,targetState,...result,previous:earlier.length>count?String(page[0].sequence):null,
   next:later.length>x.limit-count?String(page.at(-1).sequence):null,after:page.length?String(BigInt(page[0].sequence)-1n):'0',
   scannedThrough:page.length?String(page.at(-1).sequence):'0',complete:earlier.length<=count&&later.length<=x.limit-count};
 });}
 async history(actor,roomId,input={}){const x=parse(chatPageSchema,input);return this.run(actor,false,async db=>{
  const ctx=await this.requireRoom(db,actor,roomId);await this.agent(db,actor,roomId,x.agentGrantId);
  const rows=(await db.query(`SELECT m.*,COALESCE(p.hidden,false) AS personally_hidden,
   ${chatMessageOperationsBlockedSql('m')} AS operationally_hidden,
   (m.subject_id<>$2 AND EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))) AS author_quarantined,
   (SELECT s.share_id FROM room_shared_summaries s WHERE s.room_id=m.room_id AND s.subject_id=m.subject_id AND s.share_id=m.client_message_id AND s.notice_hash=m.payload_hash) AS shared_summary_id FROM chat_message_refs m
   LEFT JOIN chat_message_preferences p ON p.message_id=m.message_id AND p.subject_id=$2 WHERE m.room_id=$1 AND ${x.latest?"($3::bigint=0 OR m.sequence<$3::bigint)":"m.sequence>$3"}
   ORDER BY m.sequence ${x.latest?'DESC':'ASC'} LIMIT $4`,[roomId,chatActorRef(actor),x.latest?(x.before??'0'):x.after,x.limit+1])).rows;
  // The newest window uses the same current membership, archive and content
  // checks as forward history. Only its scan direction differs; display order
  // stays chronological, and reading never advances either user's cursor.
   const page=rows.slice(0,x.limit);if(x.latest)page.reverse();const result=await this.readMessagesWithin(db,actor,ctx,page,x);
   if(x.latest)return{...result,next:null,previous:rows.length>x.limit?String(page[0].sequence):null,
   after:page.length?String(BigInt(page[0].sequence)-1n):'0',scannedThrough:page.length?String(page.at(-1).sequence):'0',complete:rows.length<=x.limit};
   return{...result,next:rows.length>x.limit?String(page.at(-1).sequence):null,scannedThrough:page.length?String(page.at(-1).sequence):x.after,complete:rows.length<=x.limit};
 });}
 // For an already authenticated application transaction (e.g. Capsule source
 // selection). Reading a room never grants republication or evidence licensing.
 async readSelectedWithin(db,actor,{messageId,revision}){
  uuid(messageId);if(!Number.isInteger(revision)||revision<1)fail('invalid_chat_request',400);
  const located=(await db.query('SELECT room_id FROM chat_message_refs WHERE message_id=$1',[messageId])).rows[0];if(!located)fail('chat_message_unavailable',404);
  const ctx=await this.requireRoom(db,actor,located.room_id);
  const r=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 FOR SHARE',[messageId])).rows[0];
  if(r.state!=='accepted'||Date.parse(r.expires_at)<=this.now()*1000||r.revision!==revision)fail('chat_message_version_unavailable');
  if(await chatMessageOperationsBlockedWithin(db,{messageId}))fail('chat_message_version_unavailable');
  if(r.subject_id!==chatActorRef(actor)&&(await db.query("SELECT id FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased') LIMIT 1",[r.subject_id])).rows.length)fail('chat_message_version_unavailable');
  await this.project(ctx);const [body]=await this.transport.read({roomId:r.room_id,subjectId:chatActorRef(actor),ids:[r.archive_id],roomRevision:ctx.room.revision});
  if(!body||body.revision!==revision)fail('chat_message_version_unavailable');
  if(await chatMessageOperationsBlockedWithin(db,{messageId}))fail('chat_message_version_unavailable');
  return{sourceType:'chat-message',messageId,roomId:r.room_id,revision,sequence:String(r.sequence),authorId:r.subject_id,text:body.text,contentHash:digest(body.text),expiresAt:r.expires_at,
   permission:'current-room-read-only',publicationPermission:false};
 }
}
