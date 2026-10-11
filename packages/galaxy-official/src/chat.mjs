import { randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { digest } from './shared/digest.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { transaction } from './database.mjs';
import { bindingControl } from './infrastructure/identity-control-repository.mjs';
import { targetRestrictionsWithin, assertTargetOperation } from './target-governance-restrictions-v2.mjs';
import { chatCreateSchema,chatDecisionSchema,chatSendSchema,chatEditSchema,chatPageSchema,chatMessageStatusSchema,chatJoinSchema,
 chatDirectorySchema,chatDirectoryCursorSchema,chatContextSchema,chatOperationReceiptSchema } from './shared/chat-schema.mjs';
import {roomRule,roomRuleHash,administrators,assertGovernanceProposal,invitationRule,requireOriginalRule,successionLive} from './chat-room-governance.mjs';
import {lockControllerMappingsWithin} from './controller-mapping-lock.mjs';

const day=86400, stamp=n=>new Date(n*1000).toISOString(), hash=x=>digest(canonicalize(x));
const fail=(code,status=409)=>{throw new ServiceError(code,status);};
function parse(schema,input){const r=schema.safeParse(input);if(!r.success)fail('invalid_chat_request',400);return r.data;}
function uuid(value){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))fail('invalid_chat_request',400);return value;}

// Authentication is always refreshed through AccessService. The component is a
// constrained MUC/MAM projection, never the authority for Galaxy governance.
export class ChatService {
 constructor({db,access,transport,now=()=>Math.floor(Date.now()/1000),resolveControlParty=async(_db,id)=>`subject:${id}`,validateTaskRef=null,
  requireAccountWithin=null,consumeInviteWithin=null,markInviteRespondedWithin=null}){
  Object.assign(this,{db,access,transport,now,resolveControlParty,validateTaskRef,requireAccountWithin,consumeInviteWithin,markInviteRespondedWithin});
 }
 async requireAccount(db,actor){if(!this.requireAccountWithin)fail('chat_account_adapter_unavailable',503);await this.requireAccountWithin(db,actor);}
 run(actor,write,fn){return write?this.access.runResourceWrite(actor,'binding',{},db=>fn(db)):this.access.runAuthorized(actor,'binding',db=>fn(db));}
 async members(db,roomId){return(await db.query('SELECT * FROM chat_memberships WHERE room_id=$1 AND left_at IS NULL ORDER BY subject_id',[roomId])).rows;}
 async requireRoom(db,actor,roomId,{member=true,write=false}={}){
  uuid(roomId);const r=(await db.query(`SELECT * FROM chat_rooms WHERE room_id=$1 ${write?'FOR UPDATE':'FOR SHARE'}`,[roomId])).rows[0];
  if(!r)fail('chat_room_not_found',404);
  const members=await this.members(db,roomId);
  if(member&&!members.some(m=>m.subject_id===actor.subjectId))fail('chat_access_denied',403);
  if(member&&r.parent_room_id)await this.requireRoom(db,actor,r.parent_room_id);
  // Hold the whole current mapping snapshot until transaction completion,
  // including an absent/new joining subject. Link/unlink takes the same key
  // exclusively; a final metadata re-read alone would leave a commit race.
  await lockControllerMappingsWithin(db,this.access.endpoint,[...members.map(m=>m.subject_id),actor.subjectId]);
  const mapped=[];for(const m of members)mapped.push({...m,controller_ref:await this.resolveControlParty(db,m.subject_id)});
  if(mapped.some(m=>typeof m.controller_ref!=='string'||!m.controller_ref.length))fail('chat_control_relationship_unavailable',503);
  if(mapped.some((m,i)=>m.controller_ref!==members[i].controller_ref)){
   if(write){
    for(const m of mapped)await db.query('UPDATE chat_memberships SET controller_ref=$3 WHERE room_id=$1 AND subject_id=$2',[roomId,m.subject_id,m.controller_ref]);
    await db.query('UPDATE chat_rooms SET member_revision=member_revision+1,revision=revision+1 WHERE room_id=$1',[roomId]);
   }
   // A read reflects the same current control-party version that the next
   // locked write will persist. Failed stale writes roll back their refresh.
   r.member_revision++;r.revision++;
  }
  return {room:r,members:mapped,parties:[...new Set(mapped.map(m=>m.controller_ref))].sort((a,b)=>a<b?-1:a>b?1:0),governance:await targetRestrictionsWithin(db,'room',roomId,this.now())};
 }
 view(ctx){const {room:r,members,parties}=ctx;return{roomId:r.room_id,title:r.title,kind:r.kind,parentRoomId:r.parent_room_id,taskRefs:r.task_refs,
  revision:r.revision,memberRevision:r.member_revision,state:r.state,mode:r.mode,ownerSubjectId:r.owner_subject_id,persistent:r.persistent,
  retentionDays:r.retention_days,historyPolicy:'all-authorized-history',independentMemberCount:parties.length,
  joinRule:{...roomRule(r,this.now()),ruleHash:roomRuleHash(roomRule(r,this.now()))},administratorSubjectIds:administrators(ctx),successionExpiresAt:r.succession_expires_at,
  managementAuthority:{basis:'current-room-role-and-explicit-shared-rule',managerLimit:10,privateMaterialsGranted:false,otherAgentControlGranted:false},
  membershipBasis:'explicit-subject-and-verified-control-relationships',connectionCount:null,
  decisionRequired:r.state==='single-member-decision',members:members.map(m=>({subjectId:m.subject_id,joinedAt:m.joined_at,singleMemberPromptDismissed:m.dismissed_revision===r.revision})),
  transportAvailable:this.transport?.available===true,governance:ctx.governance};}
 async project(ctx){if(!this.transport)fail('chat_transport_unavailable',503);return this.transport.project({roomId:ctx.room.room_id,revision:ctx.room.revision,title:ctx.room.title,
  state:ctx.room.state,members:ctx.members.map(m=>m.subject_id)});}
 async create(actor,input){const x=parse(chatCreateSchema,input);return this.run(actor,true,async db=>{
  await lockControllerMappingsWithin(db,this.access.endpoint,[actor.subjectId]);
  await this.requireAccount(db,actor);
  const old=(await db.query('SELECT * FROM chat_rooms WHERE creator_subject_id=$1 AND operation_id=$2',[actor.subjectId,x.operationId])).rows[0];
  if(old){if(old.request_hash!==hash(x))fail('chat_operation_conflict');return this.view(await this.requireRoom(db,actor,old.room_id));}
  if(x.parentRoomId){if(x.kind!=='ai-subzone')fail('invalid_chat_request',400);await this.requireRoom(db,actor,x.parentRoomId);}
  if(x.kind==='ai-subzone'&&!x.parentRoomId)fail('chat_parent_required',400);
  for(const taskId of x.taskRefs){if(!this.validateTaskRef)fail('chat_task_link_unavailable',503);await this.validateTaskRef(db,actor,taskId);}
  const party=await this.resolveControlParty(db,actor.subjectId);
  if(typeof party!=='string'||!party)fail('chat_control_relationship_unavailable',503);
  const created=await db.query(`INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,kind,parent_room_id,task_refs,retention_days,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT DO NOTHING RETURNING room_id`,[x.roomId,actor.subjectId,x.operationId,hash(x),x.title,x.kind,x.parentRoomId??null,JSON.stringify(x.taskRefs),x.retentionDays,stamp(this.now())]);
  if(!created.rows.length){const replay=(await db.query('SELECT * FROM chat_rooms WHERE creator_subject_id=$1 AND operation_id=$2',[actor.subjectId,x.operationId])).rows[0];
   if(!replay||replay.request_hash!==hash(x))fail('chat_operation_conflict');return this.view(await this.requireRoom(db,actor,replay.room_id));}
  await db.query('INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4)',[x.roomId,actor.subjectId,party,stamp(this.now())]);
  return this.view(await this.requireRoom(db,actor,x.roomId));
 });}
 get(actor,roomId){return this.run(actor,false,async db=>this.view(await this.requireRoom(db,actor,roomId)));}
 list(actor,{after='',limit=50}={}){if(after)uuid(after);if(!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_chat_request',400);return this.run(actor,false,async db=>{
  const rows=(await db.query(`SELECT r.room_id FROM chat_rooms r JOIN chat_memberships m USING(room_id) WHERE m.subject_id=$1 AND m.left_at IS NULL
   AND ($2='' OR r.room_id::text>$2) ORDER BY r.room_id LIMIT $3`,[actor.subjectId,after,limit+1])).rows;
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
   if(cursor.subjectId!==actor.subjectId||cursor.endpoint!==this.access.endpoint)fail('invalid_chat_cursor',400);
   if(cursor.expiresAt<=this.now())fail('chat_directory_cursor_expired',409);
  }
  const watermark=cursor?.watermark??String((await db.query('SELECT value FROM chat_directory_clock WHERE singleton=true')).rows[0].value);
  const asOf=cursor?.asOf??this.now(),expiresAt=cursor?.expiresAt??this.now()+900;
  const rows=(await db.query(`WITH candidates AS (
   SELECT r.room_id,COALESCE((SELECT MAX(q.accepted_order) FROM chat_message_refs q WHERE q.room_id=r.room_id AND q.accepted_order<=$2),r.created_order) AS sort_order
   FROM chat_rooms r JOIN chat_memberships m USING(room_id) WHERE m.subject_id=$1 AND m.left_at IS NULL
    AND r.created_order<=$2 AND m.joined_order<=$2
  ) SELECT room_id,sort_order::text FROM candidates WHERE ($3::bigint IS NULL OR sort_order<$3 OR (sort_order=$3 AND room_id::text<$4))
   ORDER BY sort_order DESC,room_id DESC LIMIT $5`,[actor.subjectId,watermark,cursor?.lastOrder??null,cursor?.lastRoomId??'',x.limit+1])).rows;
  const last=rows[Math.min(rows.length,x.limit)-1];
  const nextCursor=rows.length>x.limit?Buffer.from(JSON.stringify({version:1,subjectId:actor.subjectId,endpoint:this.access.endpoint,watermark,asOf,expiresAt,
   lastOrder:last.sort_order,lastRoomId:last.room_id})).toString('base64url'):null;
   return{rows:rows.slice(0,x.limit),watermark,nextCursor,asOf};
  });
  const rooms=[];
  for(const row of page.rows){
   try{rooms.push(await this.run(actor,false,db=>this.directoryRoomWithin(db,actor,row.room_id,page.watermark)));}
   catch(error){if(error instanceof ServiceError&&['chat_access_denied','chat_room_not_found'].includes(error.code))continue;throw error;}
  }
  return{rooms,nextCursor:page.nextCursor,asOf:page.asOf};
 }
 directoryReadableCondition(){return `m.state='accepted' AND m.expires_at>$4 AND NOT COALESCE(p.hidden,false)
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
   const request={roomId,subjectId:actor.subjectId,ids:rows.map(row=>row.archive_id),roomRevision:ctx.room.revision};
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
     AND m.message_id=ANY($5::uuid[])`,[roomId,actor.subjectId,watermark,stamp(this.now()),verified])).rows[0];
   const current=(await db.query("SELECT sequence::text FROM chat_cursors WHERE room_id=$1 AND subject_id=$2 AND cursor_kind='human' AND agent_ref=''",[roomId,actor.subjectId])).rows[0];
   base.humanReadSequence=current?.sequence??'0';
   if(latestMessage){const rows=await this.messageRowsWithin(db,actor,roomId,'m.message_id=$3',[latestMessage.messageId]);
    if(!this.visibleRows(rows).some(row=>row.state==='accepted'&&row.revision===latestMessage.revision))latestMessage=null;}
   if(count.expires_at)base.readExpiresAt=Math.min(base.readExpiresAt,Math.floor(new Date(count.expires_at).getTime()/1000));
   return{...base,latestMessage,unreadHumanCount:count.count};
  }catch(error){if(!(error instanceof ServiceError))throw error;return{...base,latestMessage:null,unreadHumanCount:null,contentUnavailableReason:error.code};}
 }
 async messageRowsWithin(db,actor,roomId,condition='true',values=[],order='m.sequence ASC',limit=null){
  return(await db.query(`SELECT m.*,COALESCE(p.hidden,false) AS personally_hidden,
   (m.subject_id<>$2 AND EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))) AS author_quarantined,
   (SELECT s.share_id FROM room_shared_summaries s WHERE s.room_id=m.room_id AND s.subject_id=m.subject_id AND s.share_id=m.client_message_id AND s.notice_hash=m.payload_hash) AS shared_summary_id
   FROM chat_message_refs m LEFT JOIN chat_message_preferences p ON p.message_id=m.message_id AND p.subject_id=$2
   WHERE m.room_id=$1 AND ${condition} ORDER BY ${order}${limit===null?'':' LIMIT $'+(values.length+3)}`,
   [roomId,actor.subjectId,...values,...(limit===null?[]:[limit])])).rows;
 }
 visibleRows(rows){return rows.filter(row=>!row.personally_hidden&&!row.author_quarantined&&['accepted','retracted'].includes(row.state)&&Date.parse(row.expires_at)>this.now()*1000);}
 async readMessagesWithin(db,actor,ctx,rows,input,{projected=false}={}){
  const visible=this.visibleRows(rows).filter(row=>(!input.author||row.subject_id===input.author)&&(!input.from||Date.parse(row.sent_at)>=Date.parse(input.from))&&(!input.to||Date.parse(row.sent_at)<=Date.parse(input.to)));
  let contents=[];const accepted=visible.filter(row=>row.state==='accepted');
  if(accepted.length){if(!projected)await this.project(ctx);contents=await this.transport.read({roomId:ctx.room.room_id,subjectId:actor.subjectId,ids:accepted.map(row=>row.archive_id),roomRevision:ctx.room.revision});}
  const bodies=new Map(contents.map(body=>[body.archiveId,body]));
  // Personal hiding can change while archive I/O is in flight. Recheck the
  // selected current rows rather than restoring the pre-I/O body projection.
  const current=rows.length?await this.messageRowsWithin(db,actor,ctx.room.room_id,'m.message_id=ANY($3::uuid[])',[rows.map(row=>row.message_id)]):[];
  const byId=new Map(this.visibleRows(current).map(row=>[row.message_id,row])),messages=[];
  for(const row of visible){const r=byId.get(row.message_id);if(!r)continue;const body=bodies.get(r.archive_id);
   if(r.state==='accepted'&&!body)continue;
   if(body&&body.revision!==undefined&&body.revision!==r.revision)fail('chat_message_reconciliation_required');
   if(input.keyword&&!body?.text?.toLocaleLowerCase().includes(input.keyword.toLocaleLowerCase()))continue;
   messages.push({...this.receipt(r),sequence:String(r.sequence),acceptedOrder:r.accepted_order===null?null:String(r.accepted_order),subjectId:r.subject_id,actorKind:r.actor_kind,agentGrantId:r.agent_grant_id,replyTo:r.reply_to,
    text:r.state==='retracted'?null:body.text,sharedSummaryId:r.state==='accepted'?r.shared_summary_id:null,editedAt:r.edited_at,retractedAt:r.retracted_at});
  }
  if(this.attachments){const files=await this.attachments.forMessagesWithin(db,actor,messages.map(message=>message.messageId));for(const message of messages)if(files.has(message.messageId))message.attachments=files.get(message.messageId);}
  return{messages,readExpiresAt:Math.min(this.now()+60,...messages.map(message=>Math.floor(Date.parse(message.expiresAt)/1000)))};
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
  const targetState=currentTarget?.personally_hidden?'hidden':currentTarget?.state==='retracted'?'retracted':
   currentTarget?.state==='expired'||currentTarget&&Date.parse(currentTarget.expires_at)<=this.now()*1000?'expired':selected?.state==='accepted'?'available':'unavailable';
  // A personal hide may complete after the archive read. A hidden/unavailable
  // target is not returned through either the focus field or its window.
  if(!['available','retracted'].includes(targetState))result.messages=result.messages.filter(message=>message.messageId!==messageId);
  return{roomId,messageId,target:['available','retracted'].includes(targetState)?selected:null,targetState,...result,previous:earlier.length>count?String(page[0].sequence):null,
   next:later.length>x.limit-count?String(page.at(-1).sequence):null,after:page.length?String(BigInt(page[0].sequence)-1n):'0',
   scannedThrough:page.length?String(page.at(-1).sequence):'0',complete:earlier.length<=count&&later.length<=x.limit-count};
 });}
 async proposeDecision(actor,roomId,input){const x=parse(chatDecisionSchema,input);return this.run(actor,true,async db=>{
  if(x.action==='join-rule'?x.joinRule===undefined:x.joinRule!==undefined)fail('invalid_chat_request',400);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['chat-decision:'+x.decisionId]);
  const ctx=await this.requireRoom(db,actor,roomId,{write:true}),r=ctx.room;
  const prior=(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1',[x.decisionId])).rows[0];
  if(prior){if(prior.room_id!==roomId||prior.proposer_subject_id!==actor.subjectId||prior.request_hash!==hash(x))fail('chat_operation_conflict');return this.decisionView(prior,ctx,actor,db);}
  if(x.action==='invite')assertTargetOperation(ctx.governance,'invitations-paused');
  if(r.state==='archived'||r.revision!==x.expectedRevision)fail('chat_revision_conflict');
  let parties=ctx.parties;
  if(['invite','remove','become-owner','transfer-owner','appoint-admin','revoke-admin','successor-owner'].includes(x.action)&&!x.targetSubjectId)fail('chat_target_required',400);
  if(x.action==='invite'&&ctx.members.some(m=>m.subject_id===x.targetSubjectId))fail('chat_already_member');
  if(['become-owner','transfer-owner','appoint-admin','revoke-admin','successor-owner'].includes(x.action)&&!ctx.members.some(m=>m.subject_id===x.targetSubjectId))fail('chat_target_not_member');
  if(x.action==='become-owner'&&r.mode!=='ownerless')fail('chat_owner_already_exists');
  if(x.action==='transfer-owner'&&r.mode!=='owned')fail('chat_owner_missing');
  assertGovernanceProposal(ctx,actor,x,this.now());
  const ruleAuthority=x.action==='invite'?invitationRule(ctx,actor.subjectId,this.now()):null;
  if(x.action==='remove'){
   const target=ctx.members.find(m=>m.subject_id===x.targetSubjectId);if(!target)fail('chat_target_not_member');
   parties=parties.filter(p=>p!==target.controller_ref);if(parties.length<2)fail('chat_two_party_removal_forbidden');
   if(target.controller_ref===ctx.members.find(m=>m.subject_id===actor.subjectId).controller_ref)fail('chat_use_leave');
  }
  if(x.action==='retention'&&!x.retentionDays)fail('invalid_chat_request',400);
  if(x.action==='persistent'&&typeof x.persistent!=='boolean')fail('invalid_chat_request',400);
  if(x.action==='invite'){if(!this.consumeInviteWithin)fail('chat_invitation_adapter_unavailable',503);
   await this.consumeInviteWithin(db,actor,{roomId,eventId:x.decisionId,payloadHash:hash(x),recipientId:x.targetSubjectId});}
  const party=ctx.members.find(m=>m.subject_id===actor.subjectId).controller_ref;
  if(ruleAuthority)parties=[party];
  const votes={[party]:{subjectId:actor.subjectId,choice:'approve'}},approved=parties.every(p=>votes[p]?.choice==='approve');
  let row=(await db.query(`INSERT INTO chat_decisions(decision_id,room_id,proposer_subject_id,member_revision,required_parties,votes,action,payload,request_hash,state,created_at,expires_at,authority_rule_version,authority_rule_hash)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[x.decisionId,roomId,actor.subjectId,r.member_revision,JSON.stringify(parties),JSON.stringify(votes),x.action,JSON.stringify(x),hash(x),approved?'approved':'pending',stamp(this.now()),stamp(this.now()+7*day),ruleAuthority?.version??null,ruleAuthority?.hash??null])).rows[0];
  if(approved)row=await this.applyDecision(db,ctx,row);return this.decisionView(row,ctx,actor,db);
 });}
 async decisionView(d,ctx,actor,db){
  const member=ctx.members.find(m=>m.subject_id===actor.subjectId),party=member?.controller_ref;
  // Current controller mapping and time affect what may proceed, never the
  // saved request, votes or historical state. The write paths still verify
  // these conditions under their original locks before applying a decision.
  const effectiveState=['pending','approved'].includes(d.state)
   ?d.member_revision!==ctx.room.member_revision?'stale':Date.parse(d.expires_at)<=this.now()*1000?'expired':d.state:d.state;
  const closed=effectiveState==='stale'?'chat_membership_changed':effectiveState==='expired'?'chat_decision_expired':null;
  const pending=closed??(effectiveState!=='pending'?'chat_decision_unavailable':!member?'chat_access_denied':null);
  const reasons={approve:pending,reject:pending,cancel:pending,accept:closed,decline:closed};
  if(!pending){
   if(!d.required_parties.includes(party))reasons.approve=reasons.reject='chat_vote_not_required';
   if(actor.subjectId!==d.proposer_subject_id)reasons.cancel='chat_cancel_proposer_required';
  }
  const blocked=async(fn)=>{try{await fn();return null;}catch(error){if(error instanceof ServiceError)return error.code;throw error;}};
  if(!reasons.approve)reasons.approve=await blocked(()=>{
   if(ctx.room.state==='archived')fail('chat_room_read_only');
   assertGovernanceProposal(ctx,{subjectId:d.proposer_subject_id},d.payload,this.now());
   if(d.action==='invite')assertTargetOperation(ctx.governance,'invitations-paused');
  });
  if(!closed){
   const accepting=['invite','become-owner','transfer-owner','appoint-admin','successor-owner'].includes(d.action);
   const unavailable=effectiveState!=='approved'||!accepting?'chat_decision_unavailable':d.payload.targetSubjectId!==actor.subjectId?'chat_invitation_target_required'
    :ctx.room.state==='archived'?'chat_decision_unavailable':ctx.room.state==='owner-succession'&&d.action!=='successor-owner'?'chat_room_read_only'
    :d.action==='successor-owner'&&!successionLive(ctx.room,this.now())?'chat_succession_unavailable':d.action!=='invite'&&!member?'chat_access_denied':null;
   reasons.accept=reasons.decline=unavailable;
  }
  if(!reasons.accept)reasons.accept=await blocked(async()=>{
   await this.requireAccount(db,actor);
   assertGovernanceProposal(ctx,{subjectId:d.proposer_subject_id},d.payload,this.now());requireOriginalRule(ctx,d,this.now());
   if(d.action==='invite'){
    assertTargetOperation(ctx.governance,'invitations-paused');
    if(ctx.room.parent_room_id)await this.requireRoom(db,actor,ctx.room.parent_room_id);
   }
  });
  return{decisionId:d.decision_id,roomId:d.room_id,action:d.action,payload:d.payload,state:d.state,effectiveState,memberRevision:d.member_revision,
   proposerSubjectId:d.proposer_subject_id,votes:Object.values(d.votes),myVote:party&&d.votes[party]?{...d.votes[party]}:null,
   requiredPartyCount:d.required_parties.length,expiresAt:d.expires_at,
   canApprove:!reasons.approve,canReject:!reasons.reject,canCancel:!reasons.cancel,canAccept:!reasons.accept,canDecline:!reasons.decline,actionReasons:reasons,
   ...(d.authority_rule_version?{joinRuleAuthorization:{version:d.authority_rule_version,hash:d.authority_rule_hash}}:{})};
 }
 async decisions(actor,roomId){return this.run(actor,false,async db=>{const ctx=await this.requireRoom(db,actor,roomId),rows=(await db.query('SELECT * FROM chat_decisions WHERE room_id=$1 ORDER BY created_at DESC LIMIT 100',[roomId])).rows,decisions=[];
  for(const row of rows)decisions.push(await this.decisionView(row,ctx,actor,db));return{decisions};});}
 invitations(actor){return this.run(actor,false,async db=>{const rows=(await db.query(`SELECT d.*,r.title FROM chat_decisions d JOIN chat_rooms r USING(room_id)
  WHERE d.payload->>'targetSubjectId'=$1 AND d.state='approved' AND d.expires_at>$2 AND d.member_revision=r.member_revision AND r.state<>'archived'
  ORDER BY d.created_at DESC LIMIT 100`,[actor.subjectId,stamp(this.now())])).rows,invitations=[];
  for(const d of rows){if(d.action==='invite'&&(await targetRestrictionsWithin(db,'room',d.room_id,this.now())).scopes.includes('invitations-paused'))continue;
   const ctx=await this.requireRoom(db,actor,d.room_id,{member:false});
   if(d.member_revision!==ctx.room.member_revision)continue;
   try{requireOriginalRule(ctx,d,this.now());if(d.action==='successor-owner'&&!successionLive(ctx.room,this.now()))continue;
    if(ctx.room.state==='owner-succession'&&d.action!=='successor-owner')continue;
   }catch(error){if(error instanceof ServiceError&&error.status===409)continue;throw error;}
   invitations.push({...await this.decisionView(d,ctx,actor,db),title:d.title});}return{invitations};});}
 async voteDecision(actor,roomId,{decisionId,choice}){uuid(decisionId);if(!['approve','reject','cancel'].includes(choice))fail('invalid_chat_request',400);return this.run(actor,true,async db=>{
  const ctx=await this.requireRoom(db,actor,roomId,{write:true});let d=(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1 AND room_id=$2 FOR UPDATE',[decisionId,roomId])).rows[0];
  if(!d)fail('chat_decision_not_found',404);if(d.state!=='pending')return this.decisionView(d,ctx,actor,db);
  if(d.member_revision!==ctx.room.member_revision)d.state='stale';else if(Date.parse(d.expires_at)<=this.now()*1000)d.state='expired';
  else if(choice==='cancel'){if(actor.subjectId!==d.proposer_subject_id)fail('chat_access_denied',403);d.state='cancelled';}
  else{const party=ctx.members.find(m=>m.subject_id===actor.subjectId).controller_ref;if(!d.required_parties.includes(party))fail('chat_access_denied',403);
   d.votes[party]={subjectId:actor.subjectId,choice};d.state=choice==='reject'?'rejected':d.required_parties.every(p=>d.votes[p]?.choice==='approve')?'approved':'pending';}
  await db.query('UPDATE chat_decisions SET votes=$2,state=$3 WHERE decision_id=$1',[d.decision_id,JSON.stringify(d.votes),d.state]);
  if(d.state==='approved'){assertGovernanceProposal(ctx,{subjectId:d.proposer_subject_id},d.payload,this.now());if(d.action==='invite')assertTargetOperation(ctx.governance,'invitations-paused');d=await this.applyDecision(db,ctx,d);}return this.decisionView(d,ctx,actor,db);
 });}
 async applyDecision(db,ctx,d){const x=d.payload,r=ctx.room;
  // Invitations and ownership transfers require the target's own acceptance.
  if(['invite','become-owner','transfer-owner','appoint-admin','successor-owner'].includes(d.action))return d;
  if(d.action==='remove')await db.query('UPDATE chat_memberships SET left_at=$3 WHERE room_id=$1 AND subject_id=$2',[r.room_id,x.targetSubjectId,stamp(this.now())]);
  if(d.action==='remove')await db.query('UPDATE chat_agent_grants SET revoked_at=$3 WHERE room_id=$1 AND subject_id=$2 AND revoked_at IS NULL',[r.room_id,x.targetSubjectId,stamp(this.now())]);
  if(d.action==='remove'&&r.owner_subject_id===x.targetSubjectId)await db.query("UPDATE chat_rooms SET state='owner-succession',succession_expires_at=$2 WHERE room_id=$1",[r.room_id,stamp(this.now()+7*day)]);
  if(d.action==='retention')await db.query('UPDATE chat_rooms SET retention_days=$2 WHERE room_id=$1',[r.room_id,x.retentionDays]);
  if(d.action==='persistent')await db.query('UPDATE chat_rooms SET persistent=$2 WHERE room_id=$1',[r.room_id,x.persistent]);
  if(['remove','revoke-admin'].includes(d.action))await db.query('UPDATE chat_rooms SET administrator_ids=$2 WHERE room_id=$1',[r.room_id,JSON.stringify(administrators(ctx).filter(id=>id!==x.targetSubjectId))]);
  if(d.action==='join-rule'){
   const current=roomRule(r,this.now()),rule={mode:x.joinRule.mode,version:current.version+1,decisionId:d.decision_id,requestHash:d.request_hash,expiresAt:x.joinRule.expiresAt??null};
   await db.query('UPDATE chat_rooms SET join_rule=$2 WHERE room_id=$1',[r.room_id,JSON.stringify(rule)]);
  }
  if(d.action==='dissolve')await db.query("UPDATE chat_rooms SET state='archived' WHERE room_id=$1",[r.room_id]);
  await db.query(`UPDATE chat_rooms SET revision=revision+1,member_revision=member_revision+$2,updated_at=$3 WHERE room_id=$1`,[r.room_id,['remove','revoke-admin','join-rule'].includes(d.action)?1:0,stamp(this.now())]);
  await db.query("UPDATE chat_decisions SET state='accepted' WHERE decision_id=$1",[d.decision_id]);d.state='accepted';return d;
 }
 async acceptInvite(actor,roomId,{decisionId,accept=true}){uuid(decisionId);if(typeof accept!=='boolean')fail('invalid_chat_request',400);return this.run(actor,true,async db=>{
  if(accept)await this.requireAccount(db,actor);
  const ctx=await this.requireRoom(db,actor,roomId,{member:false,write:true}),r=ctx.room;
  const d=(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1 AND room_id=$2 FOR UPDATE',[decisionId,roomId])).rows[0];
  if(!d||!['invite','become-owner','transfer-owner','appoint-admin','successor-owner'].includes(d.action)||d.payload.targetSubjectId!==actor.subjectId)fail('chat_access_denied',403);
  if(d.state==='accepted'){const active=ctx.members.some(m=>m.subject_id===actor.subjectId);
   return{state:'accepted',membershipActive:active,...(active?{room:this.view(ctx)}:{})};}
  if(d.state!=='approved'||r.state==='archived')fail('chat_decision_unavailable');
  if(d.member_revision!==r.member_revision)fail('chat_membership_changed');if(Date.parse(d.expires_at)<=this.now()*1000)fail('chat_invitation_expired');
  if(r.state==='owner-succession'&&d.action!=='successor-owner')fail('chat_room_read_only');
  if(d.action==='successor-owner'&&!successionLive(r,this.now()))fail('chat_succession_unavailable');
  if(accept){assertGovernanceProposal(ctx,{subjectId:d.proposer_subject_id},d.payload,this.now());requireOriginalRule(ctx,d,this.now());}
  if(d.action==='invite'){if(!this.markInviteRespondedWithin)fail('chat_invitation_adapter_unavailable',503);await this.markInviteRespondedWithin(db,{roomId,recipientId:actor.subjectId});}
  if(!accept){await db.query("UPDATE chat_decisions SET state='rejected' WHERE decision_id=$1",[decisionId]);return{state:'rejected'};}
  if(d.action==='invite'){
   assertTargetOperation(ctx.governance,'invitations-paused');
   if(r.parent_room_id)await this.requireRoom(db,actor,r.parent_room_id);
   const party=await this.resolveControlParty(db,actor.subjectId);
   await db.query(`INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4)
    ON CONFLICT(room_id,subject_id) DO UPDATE SET controller_ref=$3,joined_at=$4,left_at=NULL,dismissed_revision=NULL`,[roomId,actor.subjectId,party,stamp(this.now())]);
   const multi=new Set([...ctx.parties,party]).size>1;
   await db.query(`UPDATE chat_rooms SET revision=revision+1,member_revision=member_revision+1,had_multiple=had_multiple OR $2,
    state=CASE WHEN $2 THEN 'active' ELSE state END,updated_at=$3 WHERE room_id=$1`,[roomId,multi,stamp(this.now())]);
  }else if(d.action==='appoint-admin'){
   await db.query('UPDATE chat_rooms SET administrator_ids=$2,revision=revision+1,member_revision=member_revision+1,updated_at=$3 WHERE room_id=$1',[roomId,JSON.stringify([...administrators(ctx),actor.subjectId]),stamp(this.now())]);
  }else{
   if(!ctx.members.some(m=>m.subject_id===actor.subjectId))fail('chat_access_denied',403);
   await db.query("UPDATE chat_rooms SET mode='owned',owner_subject_id=$2,administrator_ids=$4,persistent=COALESCE($5,persistent),state='active',succession_expires_at=NULL,revision=revision+1,member_revision=member_revision+1,updated_at=$3 WHERE room_id=$1",[roomId,actor.subjectId,stamp(this.now()),JSON.stringify(administrators(ctx).filter(id=>id!==actor.subjectId)),d.payload.persistent??null]);
  }
  await db.query("UPDATE chat_decisions SET state='accepted' WHERE decision_id=$1",[decisionId]);
  return {state:'accepted',room:this.view(await this.requireRoom(db,actor,roomId))};
 });}
 async leave(actor,roomId){return this.run(actor,true,async db=>{
  const ctx=await this.requireRoom(db,actor,roomId,{member:false,write:true}),r=ctx.room;
  if(!ctx.members.some(m=>m.subject_id===actor.subjectId))return{left:true,taskParticipationChanged:false};
  await db.query('UPDATE chat_memberships SET left_at=$3 WHERE room_id=$1 AND subject_id=$2',[roomId,actor.subjectId,stamp(this.now())]);
  await db.query('UPDATE chat_agent_grants SET revoked_at=$3 WHERE room_id=$1 AND subject_id=$2 AND revoked_at IS NULL',[roomId,actor.subjectId,stamp(this.now())]);
  const parties=new Set(ctx.members.filter(m=>m.subject_id!==actor.subjectId).map(m=>m.controller_ref));
  const state=!parties.size?'archived':r.owner_subject_id===actor.subjectId?'owner-succession':parties.size===1&&r.mode==='ownerless'&&r.had_multiple?'single-member-decision':r.state;
  await db.query(`UPDATE chat_rooms SET state=$2,revision=revision+1,member_revision=member_revision+1,updated_at=$3,
   administrator_ids=$5,succession_expires_at=CASE WHEN $2='owner-succession' AND state<>'owner-succession' THEN $4 ELSE succession_expires_at END WHERE room_id=$1`,[roomId,state,stamp(this.now()),stamp(this.now()+7*day),JSON.stringify(administrators(ctx).filter(id=>id!==actor.subjectId))]);
  return {left:true,taskParticipationChanged:false};
 });}
 async dismissDecision(actor,roomId){return this.run(actor,true,async db=>{const ctx=await this.requireRoom(db,actor,roomId,{write:true});await db.query('UPDATE chat_memberships SET dismissed_revision=$3 WHERE room_id=$1 AND subject_id=$2',[roomId,actor.subjectId,ctx.room.revision]);return{dismissed:true};});}
 async joinPreview(actor,roomId){return this.run(actor,false,async db=>{
  const ctx=await this.requireRoom(db,actor,roomId,{member:false}),rule=roomRule(ctx.room,this.now());
  if(rule.effectiveMode!=='open'||['archived','owner-succession'].includes(ctx.room.state))fail('chat_access_denied',403);
  if(ctx.room.parent_room_id)await this.requireRoom(db,actor,ctx.room.parent_room_id);
  assertTargetOperation(ctx.governance,'invitations-paused');
  return{roomId,title:ctx.room.title,ruleVersion:rule.version,ruleHash:roomRuleHash(rule),joinRule:rule,
   retentionDays:ctx.room.retention_days,historyPolicy:'all-authorized-history',requiresVerifiedAccount:true,joiningGrantsOtherMaterials:false,joiningStartsAgent:false};
 });}
 async join(actor,roomId,input){const x=parse(chatJoinSchema,input);return this.run(actor,true,async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['chat-decision:'+x.operationId]);
  const ctx=await this.requireRoom(db,actor,roomId,{member:false,write:true}),r=ctx.room;
  const previous=(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1',[x.operationId])).rows[0];
  if(previous){if(previous.action!=='open-join'||previous.room_id!==roomId||previous.proposer_subject_id!==actor.subjectId||previous.request_hash!==hash(x))fail('chat_operation_conflict');
   const active=ctx.members.some(m=>m.subject_id===actor.subjectId);return{state:'accepted',membershipActive:active,...(active?{room:this.view(ctx)}:{})};}
  const rule=roomRule(r,this.now());
  if(rule.effectiveMode!=='open'||['archived','owner-succession'].includes(r.state))fail('chat_access_denied',403);
  if(rule.version!==x.ruleVersion||roomRuleHash(rule)!==x.ruleHash)fail('chat_join_rule_changed');
  assertTargetOperation(ctx.governance,'invitations-paused');await this.requireAccount(db,actor);
  if(r.parent_room_id)await this.requireRoom(db,actor,r.parent_room_id);
  if(ctx.members.some(m=>m.subject_id===actor.subjectId))fail('chat_already_member');
  const party=await this.resolveControlParty(db,actor.subjectId);if(typeof party!=='string'||!party)fail('chat_control_relationship_unavailable',503);
  await db.query(`INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4)
   ON CONFLICT(room_id,subject_id) DO UPDATE SET controller_ref=$3,joined_at=$4,left_at=NULL,dismissed_revision=NULL`,[roomId,actor.subjectId,party,stamp(this.now())]);
  const multi=new Set([...ctx.parties,party]).size>1;
  await db.query(`UPDATE chat_rooms SET revision=revision+1,member_revision=member_revision+1,had_multiple=had_multiple OR $2,
   state=CASE WHEN $2 THEN 'active' ELSE state END,updated_at=$3 WHERE room_id=$1`,[roomId,multi,stamp(this.now())]);
  await db.query(`INSERT INTO chat_decisions(decision_id,room_id,proposer_subject_id,member_revision,required_parties,votes,action,payload,request_hash,state,created_at,expires_at,authority_rule_version,authority_rule_hash)
   VALUES($1,$2,$3,$4,'[]','{}','open-join',$5,$6,'accepted',$7,$8,$9,$10)`,[x.operationId,roomId,actor.subjectId,r.member_revision,JSON.stringify(x),hash(x),stamp(this.now()),stamp(this.now()+7*day),rule.version,roomRuleHash(rule)]);
  return{state:'accepted',membershipActive:true,room:this.view(await this.requireRoom(db,actor,roomId))};
 });}
 async agent(db,actor,roomId,grantId,{send=false}={}){
  if(!grantId)return null;const g=(await db.query('SELECT * FROM chat_agent_grants WHERE grant_id=$1 AND room_id=$2 AND subject_id=$3',[grantId,roomId,actor.subjectId])).rows[0];
  if(!g||g.binding_id!==actor.bindingId||g.revoked_at||Date.parse(g.expires_at)<=this.now()*1000||(send&&g.mode!=='respond'))fail('chat_agent_not_authorized',403);return g;
 }
 async grantAgent(actor,roomId,{grantId,bindingId,mode='read',primaryResponder=false,expiresAt}){
  uuid(grantId);uuid(bindingId);if(!['read','draft','respond'].includes(mode)||typeof primaryResponder!=='boolean'||primaryResponder&&mode!=='respond'||!Number.isInteger(expiresAt)||expiresAt<=this.now()||expiresAt>this.now()+30*day)fail('invalid_chat_request',400);
  return this.run(actor,true,async db=>{const ctx=await this.requireRoom(db,actor,roomId,{write:true});
   if(['archived','owner-succession'].includes(ctx.room.state))fail('chat_room_read_only');
   const b=await bindingControl(db,(await db.query('SELECT * FROM bindings WHERE id=$1 AND subject_id=$2',[bindingId,actor.subjectId])).rows[0],{scope:'binding'});
   if(!b||!b.scopes.includes('binding')||b.revoked_at||Date.parse(b.expires_at)<=this.now()*1000)fail('chat_agent_not_authorized',403);
   if(primaryResponder){const p=ctx.members.find(m=>m.subject_id===actor.subjectId).controller_ref;const ids=ctx.members.filter(m=>m.controller_ref===p).map(m=>m.subject_id);
    await db.query('UPDATE chat_agent_grants SET primary_responder=false WHERE room_id=$1 AND subject_id=ANY($2::text[]) AND revoked_at IS NULL',[roomId,ids]);}
   const old=(await db.query('SELECT * FROM chat_agent_grants WHERE grant_id=$1',[grantId])).rows[0];if(old)fail('chat_grant_exists');
   await db.query('INSERT INTO chat_agent_grants(grant_id,room_id,subject_id,binding_id,mode,primary_responder,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[grantId,roomId,actor.subjectId,bindingId,mode,primaryResponder,stamp(expiresAt),stamp(this.now())]);
   return{grantId,mode,primaryResponder,expiresAt,hostRuntimeStarted:false};});
 }
 queryAgentGrants(actor,roomId,{after='',limit=50,grantId}={}){
  if(after)uuid(after);if(grantId)uuid(grantId);if(!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_chat_request',400);
  return this.run(actor,false,async db=>{
   const ctx=await this.requireRoom(db,actor,roomId);
   const rows=(await db.query(`SELECT * FROM chat_agent_grants WHERE room_id=$1 AND subject_id=$2
    AND ($3='' OR grant_id::text>$3) AND ($4::uuid IS NULL OR grant_id=$4) ORDER BY grant_id LIMIT $5`,[roomId,actor.subjectId,after,grantId??null,limit+1])).rows;
   const items=[];
   for(const row of rows.slice(0,limit)){
    const binding=await bindingControl(db,(await db.query('SELECT * FROM bindings WHERE id=$1 AND subject_id=$2',[row.binding_id,actor.subjectId])).rows[0],{scope:'binding'});
    const state=row.revoked_at?'revoked':Date.parse(row.expires_at)<=this.now()*1000?'expired':!binding||binding.revoked_at||!binding.scopes.includes('binding')||Date.parse(binding.expires_at)<=this.now()*1000?'binding-unavailable':['archived','owner-succession'].includes(ctx.room.state)?'room-inactive':'active';
    items.push({grantId:row.grant_id,roomId,subjectId:row.subject_id,bindingId:row.binding_id,mode:row.mode,primaryResponder:row.primary_responder,
     expiresAt:Math.floor(Date.parse(row.expires_at)/1000),createdAt:row.created_at,revokedAt:row.revoked_at,state,hostRuntimeState:'unverified'});
   }
   return {items,next:rows.length>limit?items.at(-1).grantId:null,...(grantId?{grantId,state:items.length?'recorded':'absent'}:{})};
  });
 }
 queryAgentParticipants(actor,roomId,input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['after','limit'].includes(k)))fail('invalid_chat_request',400);
  const {after='',limit=50}=input;if(after)uuid(after);if(typeof after!=='string'||!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_chat_request',400);
  return this.run(actor,false,async db=>{
   const ctx=await this.requireRoom(db,actor,roomId);
   const rows=(await db.query(`SELECT g.* FROM chat_agent_grants g JOIN chat_memberships m ON m.room_id=g.room_id AND m.subject_id=g.subject_id
    WHERE g.room_id=$1 AND m.left_at IS NULL AND ($2='' OR g.grant_id::text>$2)
    AND NOT EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=g.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))
    ORDER BY g.grant_id LIMIT $3`,[roomId,after,limit+1])).rows;
   const items=[];
   for(const row of rows.slice(0,limit)){
    const binding=await bindingControl(db,(await db.query('SELECT * FROM bindings WHERE id=$1 AND subject_id=$2',[row.binding_id,row.subject_id])).rows[0],{scope:'binding'});
    const state=row.revoked_at?'revoked':Date.parse(row.expires_at)<=this.now()*1000?'expired':!binding||binding.revoked_at||!binding.scopes.includes('binding')||Date.parse(binding.expires_at)<=this.now()*1000?'binding-unavailable':['archived','owner-succession'].includes(ctx.room.state)?'room-inactive':'active';
    items.push({grantId:row.grant_id,subjectId:row.subject_id,mode:row.mode,primaryResponder:row.primary_responder,
     expiresAt:Math.floor(Date.parse(row.expires_at)/1000),state,hostRuntimeState:'unverified',readScope:'current-room-authorized-history',
     allowedActions:state!=='active'?[]:row.mode==='respond'?['read','draft','respond']:row.mode==='draft'?['read','draft']:['read']});
   }
   return{items,next:rows.length>limit?items.at(-1).grantId:null};
  });
 }
 revokeAgent(actor,roomId,{grantId}){uuid(grantId);return this.run(actor,true,async db=>{await this.requireRoom(db,actor,roomId,{write:true});const r=await db.query('UPDATE chat_agent_grants SET revoked_at=COALESCE(revoked_at,$4) WHERE grant_id=$1 AND room_id=$2 AND subject_id=$3 RETURNING grant_id',[grantId,roomId,actor.subjectId,stamp(this.now())]);if(!r.rows.length)fail('chat_access_denied',403);return{revoked:true,hostRuntimeStopped:false};});}
 receipt(r){const state=['pending','accepted'].includes(r.state)&&Date.parse(r.expires_at)<=this.now()*1000?'expired':r.state;
  return{messageId:r.message_id,archiveId:r.archive_id,clientMessageId:r.client_message_id,state,revision:r.revision,acceptedByRoom:state==='accepted',readByOthers:false,sentAt:r.sent_at,expiresAt:r.expires_at};}
 async send(actor,roomId,input,{beforeSendWithin=null}={}){const x=parse(chatSendSchema,input);
  // Persist an ID before external I/O. A lost reply is retried with the same ID,
  // not converted into a new send or falsely reported as read by another person.
  const id=await this.run(actor,true,async db=>{
   const ctx=await this.requireRoom(db,actor,roomId,{write:true});if(['archived','owner-succession'].includes(ctx.room.state))fail('chat_room_read_only');
   await this.agent(db,actor,roomId,x.agentGrantId,{send:true});
   const old=(await db.query('SELECT * FROM chat_message_refs WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3',[roomId,actor.subjectId,x.clientMessageId])).rows[0];
   if(old){if(old.payload_hash!==hash(x))fail('chat_message_conflict');return old.message_id;}
   assertTargetOperation(ctx.governance,'sending-paused');
   if(x.attachments&&!this.attachments)fail('attachment_service_unavailable',503);
   if(beforeSendWithin)await beforeSendWithin(db);
   if(x.replyTo){const reply=(await db.query("SELECT message_id FROM chat_message_refs WHERE message_id=$1 AND room_id=$2 AND state='accepted' AND expires_at>$3",[x.replyTo,roomId,stamp(this.now())])).rows[0];if(!reply)fail('chat_reply_unavailable');}
   const id=randomUUID();await db.query(`INSERT INTO chat_message_refs(message_id,room_id,subject_id,client_message_id,payload_hash,actor_kind,agent_grant_id,reply_to,sent_at,expires_at,content_bytes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,roomId,actor.subjectId,x.clientMessageId,hash(x),x.agentGrantId?'agent':'human',x.agentGrantId??null,x.replyTo,stamp(this.now()),stamp(this.now()+ctx.room.retention_days*day),Buffer.byteLength(x.text,'utf8')]);
   if(x.attachments)await this.attachments.validateForMessageWithin(db,actor,{roomId,references:x.attachments,messageId:id});return id;
  });
  return this.run(actor,true,async db=>{
   const ctx=await this.requireRoom(db,actor,roomId,{write:true}),r=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 FOR UPDATE',[id])).rows[0];
   await this.agent(db,actor,roomId,x.agentGrantId,{send:true});if(r.state!=='pending')return this.receipt(r);
   assertTargetOperation(ctx.governance,'sending-paused');
   if(['archived','owner-succession'].includes(ctx.room.state)||Date.parse(r.expires_at)<=this.now()*1000)fail('chat_send_no_longer_allowed');
   if(x.attachments){if(!this.attachments)fail('attachment_service_unavailable',503);await this.attachments.validateForMessageWithin(db,actor,{roomId,references:x.attachments,messageId:id});}
   if(beforeSendWithin)await beforeSendWithin(db);
   await this.project(ctx);
   const receipt=await this.transport.send({roomId,subjectId:actor.subjectId,messageId:id,text:x.text,payloadHash:r.payload_hash,replyTo:x.replyTo,
    actorKind:r.actor_kind,agentGrantId:r.agent_grant_id,sentAt:r.sent_at,expiresAt:r.expires_at,roomRevision:ctx.room.revision});
   if(receipt.archiveId!==id)fail('chat_archive_receipt_invalid',502);
    // This short global lock is acquired only after external I/O. It survives
    // through SQL commit, so a larger delivery order cannot commit first.
    const acceptedOrder=String((await db.query('SELECT public.galaxy_chat_next_directory_order() AS ordinal')).rows[0].ordinal),acceptedAt=stamp(this.now());
    await db.query("UPDATE chat_message_refs SET archive_id=$2,state='accepted',accepted_order=$3,accepted_at=$4 WHERE message_id=$1",[id,receipt.archiveId,acceptedOrder,acceptedAt]);
    return this.receipt({...r,archive_id:receipt.archiveId,state:'accepted',accepted_order:acceptedOrder,accepted_at:acceptedAt});
  });
 }
 messageStatus(actor,roomId,input){uuid(roomId);const x=parse(chatMessageStatusSchema,input);return this.run(actor,false,async db=>{
  if(!x.requestHash){await this.requireRoom(db,actor,roomId);const r=(await db.query('SELECT * FROM chat_message_refs WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3',[roomId,actor.subjectId,x.clientMessageId])).rows[0];return r?this.receipt(r):{state:'not-found',acceptedByRoom:false};}
  // Read only the original owned request metadata. A former room member can
  // confirm an operation without retrieving its text, sources or archive body.
  const base={roomId,...x,checkedAt:stamp(this.now()),currentAccessGranted:false,contentReturned:false,othersReadStatus:'not-asserted',acceptedByRoom:false};
  const r=(await db.query('SELECT message_id,client_message_id,payload_hash,state,revision,sent_at,expires_at,archive_id,purge_pending FROM chat_message_refs WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3',[roomId,actor.subjectId,x.clientMessageId])).rows[0];
  if(!r)return{...base,state:'absent'};if(r.payload_hash!==x.requestHash)return{...base,state:'conflict'};
  const state=['pending','accepted'].includes(r.state)&&Date.parse(r.expires_at)<=this.now()*1000?'expired':r.state;
  return{...base,state,messageId:r.message_id,revision:r.revision,sentAt:new Date(r.sent_at).toISOString(),expiresAt:new Date(r.expires_at).toISOString(),
   acceptedByRoom:state==='accepted',historicalAcceptanceRecorded:!!r.archive_id,archiveCleanupState:r.purge_pending?'pending':['retracted','expired'].includes(r.state)?'recorded-complete':'not-requested'};
 });}
 operationStatus(actor,roomId,input){uuid(roomId);const x=parse(chatOperationReceiptSchema,input);return this.run(actor,false,async db=>{
  const base={roomId,...x,currentAccessGranted:false,contentReturned:false};
  const row=(await db.query('SELECT message_id,request_hash,state,result FROM chat_message_operations WHERE room_id=$1 AND operation_id=$2 AND subject_id=$3 AND kind=\'edit\'',[roomId,x.operationId,actor.subjectId])).rows[0];
  if(!row)return{...base,state:'absent'};
  if(row.request_hash!==x.requestHash)return{...base,state:'conflict'};
  return{...base,state:row.state==='complete'?'acknowledged':row.state,messageId:row.message_id,
   ...(row.state==='complete'?{revision:row.result.revision,editedAt:new Date(row.result.editedAt).toISOString()}:{})};
 });}
 async history(actor,roomId,input={}){const x=parse(chatPageSchema,input);return this.run(actor,false,async db=>{
  const ctx=await this.requireRoom(db,actor,roomId);await this.agent(db,actor,roomId,x.agentGrantId);
  const rows=(await db.query(`SELECT m.*,COALESCE(p.hidden,false) AS personally_hidden,
   (m.subject_id<>$2 AND EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))) AS author_quarantined,
   (SELECT s.share_id FROM room_shared_summaries s WHERE s.room_id=m.room_id AND s.subject_id=m.subject_id AND s.share_id=m.client_message_id AND s.notice_hash=m.payload_hash) AS shared_summary_id FROM chat_message_refs m
   LEFT JOIN chat_message_preferences p ON p.message_id=m.message_id AND p.subject_id=$2 WHERE m.room_id=$1 AND ${x.latest?"($3::bigint=0 OR m.sequence<$3::bigint)":"m.sequence>$3"}
   ORDER BY m.sequence ${x.latest?'DESC':'ASC'} LIMIT $4`,[roomId,actor.subjectId,x.latest?(x.before??'0'):x.after,x.limit+1])).rows;
  // The newest window uses the same current membership, archive and content
  // checks as forward history. Only its scan direction differs; display order
  // stays chronological, and reading never advances either user's cursor.
   const page=rows.slice(0,x.limit);if(x.latest)page.reverse();const result=await this.readMessagesWithin(db,actor,ctx,page,x);
   if(x.latest)return{...result,next:null,previous:rows.length>x.limit?String(page[0].sequence):null,
   after:page.length?String(BigInt(page[0].sequence)-1n):'0',scannedThrough:page.length?String(page.at(-1).sequence):'0',complete:rows.length<=x.limit};
   return{...result,next:rows.length>x.limit?String(page.at(-1).sequence):null,scannedThrough:page.length?String(page.at(-1).sequence):x.after,complete:rows.length<=x.limit};
 });}
 async edit(actor,roomId,messageId,input){uuid(messageId);const x=parse(chatEditSchema,input);
  const reservation=await this.run(actor,true,async db=>{
  const ctx=await this.requireRoom(db,actor,roomId,{write:true});const r=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 AND room_id=$2 FOR UPDATE',[messageId,roomId])).rows[0];
  if(!r||r.subject_id!==actor.subjectId)fail('chat_access_denied',403);
  if((await db.query('SELECT share_id FROM room_shared_summaries WHERE room_id=$1 AND subject_id=$2 AND share_id=$3 AND notice_hash=$4',[roomId,actor.subjectId,r.client_message_id,r.payload_hash])).rows.length)fail('chat_shared_summary_use_new_version');
  const old=(await db.query('SELECT * FROM chat_message_operations WHERE operation_id=$1',[x.operationId])).rows[0];
  if(old){if(old.message_id!==messageId||old.subject_id!==actor.subjectId||old.kind!=='edit'||old.request_hash!==hash(x))fail('chat_operation_conflict');
   if(old.state==='cancelled')fail('chat_message_unavailable');return old;}
  assertTargetOperation(ctx.governance,'sending-paused');
  if(r.state!=='accepted'||Date.parse(r.expires_at)<=this.now()*1000)fail('chat_message_unavailable');
  if(['archived','owner-succession'].includes(ctx.room.state))fail('chat_room_read_only');
  if(this.now()*1000-Date.parse(r.sent_at)>day*1000)fail('chat_edit_window_closed_use_correction');if(r.revision!==x.expectedRevision)fail('chat_revision_conflict');
  if((await db.query("SELECT operation_id FROM chat_message_operations WHERE message_id=$1 AND state='pending'",[messageId])).rows.length)fail('chat_edit_pending_reconcile_first');
  const result={messageId,revision:r.revision+1,editedAt:stamp(this.now())};
  const bytes=Buffer.byteLength(x.text,'utf8');
  await db.query('UPDATE chat_message_refs SET content_bytes=GREATEST(content_bytes,$2) WHERE message_id=$1',[messageId,bytes]);
  return(await db.query(`INSERT INTO chat_message_operations(operation_id,room_id,message_id,subject_id,kind,request_hash,result,created_at,state,previous_content_bytes,target_content_bytes,base_revision)
   VALUES($1,$2,$3,$4,'edit',$5,$6,$7,'pending',$8,$9,$10) RETURNING *`,[x.operationId,roomId,messageId,actor.subjectId,hash(x),JSON.stringify(result),stamp(this.now()),r.content_bytes,bytes,r.revision])).rows[0];
  });
  if(reservation.state==='complete')return reservation.result;
  // The increased byte reservation and operation receipt have already passed
  // the resource budget and committed before external MAM content can change.
  return this.run(actor,true,async db=>{
   const ctx=await this.requireRoom(db,actor,roomId,{write:true});const r=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 FOR UPDATE',[messageId])).rows[0];
   const op=(await db.query('SELECT * FROM chat_message_operations WHERE operation_id=$1 FOR UPDATE',[x.operationId])).rows[0];
   if(op.state==='complete')return op.result;
   assertTargetOperation(ctx.governance,'sending-paused');
   if(op.state!=='pending'||r.state!=='accepted'||Date.parse(r.expires_at)<=this.now()*1000)fail('chat_message_unavailable');
   if(['archived','owner-succession'].includes(ctx.room.state))fail('chat_room_read_only');
   if(r.revision!==op.base_revision)fail('chat_revision_conflict');
   await this.project(ctx);const receipt=await this.transport.edit({roomId,messageId,subjectId:actor.subjectId,operationId:x.operationId,text:x.text,expectedRevision:r.revision,roomRevision:ctx.room.revision});
   if(receipt?.revision!==undefined&&receipt.revision!==r.revision+1)fail('chat_archive_receipt_invalid',502);
   await db.query('UPDATE chat_message_refs SET revision=revision+1,edited_at=$2,content_bytes=$3 WHERE message_id=$1',[messageId,op.result.editedAt,op.target_content_bytes]);
   await db.query("UPDATE chat_message_operations SET state='complete' WHERE operation_id=$1",[x.operationId]);return op.result;
  });
 }
 async retract(actor,roomId,messageId){uuid(messageId);await this.run(actor,true,async db=>{
  await this.requireRoom(db,actor,roomId,{write:true});const r=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 AND room_id=$2 FOR UPDATE',[messageId,roomId])).rows[0];
  if(!r||r.subject_id!==actor.subjectId)fail('chat_access_denied',403);if(r.state==='expired')fail('chat_message_unavailable');
  await db.query("UPDATE chat_message_refs SET state='retracted',purge_pending=true,retracted_at=COALESCE(retracted_at,$2) WHERE message_id=$1",[messageId,stamp(this.now())]);
 });
  // Tombstone commits before physical deletion. Failure cannot re-expose text.
  try{await this.purgeOne(messageId);return{messageId,retracted:true,archiveDeleted:true};}catch(e){if(!(e instanceof ServiceError))throw e;return{messageId,retracted:true,archiveDeleted:false,purgePending:true};}
 }
 hide(actor,roomId,messageId,{hidden=true}={}){uuid(messageId);if(typeof hidden!=='boolean')fail('invalid_chat_request',400);return this.run(actor,true,async db=>{await this.requireRoom(db,actor,roomId);const m=(await db.query('SELECT message_id FROM chat_message_refs WHERE message_id=$1 AND room_id=$2',[messageId,roomId])).rows[0];if(!m)fail('chat_message_unavailable');await db.query(`INSERT INTO chat_message_preferences(room_id,subject_id,message_id,hidden,updated_at) VALUES($1,$2,$3,$4,$5)
  ON CONFLICT(room_id,subject_id,message_id) DO UPDATE SET hidden=$4,updated_at=$5`,[roomId,actor.subjectId,messageId,hidden,stamp(this.now())]);return{hidden};});}
 cursor(actor,roomId,{kind='human',sequence,agentGrantId,visibleMessageIds}){if(!['human','agent'].includes(kind)||typeof sequence!=='string'||!/^\d+$/.test(sequence)||(kind==='agent'&&!agentGrantId)||(kind==='human'&&agentGrantId))fail('invalid_chat_request',400);
  if(visibleMessageIds!==undefined){if(kind!=='human'||!Array.isArray(visibleMessageIds)||!visibleMessageIds.length||visibleMessageIds.length>100)fail('invalid_chat_request',400);visibleMessageIds.forEach(uuid);}
  return this.run(actor,true,async db=>{
  await this.requireRoom(db,actor,roomId);await this.agent(db,actor,roomId,agentGrantId);const max=(await db.query('SELECT COALESCE(MAX(sequence),0)::text AS seq FROM chat_message_refs WHERE room_id=$1',[roomId])).rows[0].seq;
  if(BigInt(sequence)>BigInt(max))fail('chat_cursor_out_of_range');const agentRef=agentGrantId??'';
   let acceptedOrder='0';
   if(kind==='human'&&visibleMessageIds!==undefined){
    const ids=[...new Set(visibleMessageIds)],rows=await this.messageRowsWithin(db,actor,roomId,'m.message_id=ANY($3::uuid[])',[ids]);
    const readable=this.visibleRows(rows).filter(row=>row.state==='accepted'&&BigInt(row.sequence)<=BigInt(sequence));
    if(readable.length!==ids.length)fail('chat_message_unavailable');
    for(const row of readable)await db.query(`INSERT INTO chat_human_message_reads(room_id,subject_id,message_id,read_at) VALUES($1,$2,$3,$4)
     ON CONFLICT(room_id,subject_id,message_id) DO NOTHING`,[roomId,actor.subjectId,row.message_id,stamp(this.now())]);
   }else if(kind==='human'){
    acceptedOrder=String((await db.query('SELECT COALESCE(MAX(accepted_order),0)::text AS ordinal FROM chat_message_refs WHERE room_id=$1 AND sequence<=$2',[roomId,sequence])).rows[0].ordinal);
   }
   const r=(await db.query(`INSERT INTO chat_cursors(room_id,subject_id,cursor_kind,agent_ref,sequence,accepted_order,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(room_id,subject_id,cursor_kind,agent_ref) DO UPDATE SET sequence=GREATEST(chat_cursors.sequence,$5),accepted_order=GREATEST(chat_cursors.accepted_order,$6),updated_at=$7 RETURNING sequence`,
    [roomId,actor.subjectId,kind,agentRef,sequence,acceptedOrder,stamp(this.now())])).rows[0];return{kind,sequence:String(r.sequence),agentGrantId:agentGrantId??null};
 });}
 async purgeOne(messageId){const r=(await this.db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 AND purge_pending=true',[messageId])).rows[0];if(!r)return;
  if(!this.transport)fail('chat_transport_unavailable',503);const acknowledgement=await this.transport.erase({roomId:r.room_id,messageId:r.message_id});
  // The actual Prosody erase contract returns this exact positive flag. A
  // resolved promise or a negative/missing flag cannot clear the retry target.
  if(acknowledgement?.archiveDeleted!==true)fail('chat_archive_receipt_invalid',502);
  await transaction(this.db,async db=>{
   await db.query('UPDATE chat_message_refs SET purge_pending=false,content_bytes=0 WHERE message_id=$1 AND state IN (\'retracted\',\'expired\')',[messageId]);
   await db.query("UPDATE chat_message_operations SET state='cancelled' WHERE message_id=$1 AND state='pending'",[messageId]);
  });
 }
 // Worker-only: never expose maintenance methods through a user HTTP route.
 async purgeExpired({limit=100}={}){if(!Number.isInteger(limit)||limit<1||limit>1000)fail('invalid_chat_request',400);
  await this.db.query("UPDATE chat_message_refs SET state='expired',purge_pending=true WHERE expires_at<=$1 AND state IN ('pending','accepted')",[stamp(this.now())]);
  await this.db.query("UPDATE chat_rooms SET state='archived',revision=revision+1 WHERE state='owner-succession' AND succession_expires_at<=$1",[stamp(this.now())]);
  const rows=(await this.db.query('SELECT message_id FROM chat_message_refs WHERE purge_pending=true ORDER BY expires_at LIMIT $1',[limit])).rows;
  let deleted=0;for(const r of rows){await this.purgeOne(r.message_id);deleted++;}return{archiveDeleted:deleted};
 }
 async eraseSubject(subjectId,{limit=100}={}){
  if(!/^GUID[A-Z0-9]{28}$/.test(subjectId)||!Number.isInteger(limit)||limit<1||limit>1000)fail('invalid_chat_request',400);
  await transaction(this.db,async db=>{
   const rooms=(await db.query(`SELECT r.* FROM chat_rooms r JOIN chat_memberships m USING(room_id)
    WHERE m.subject_id=$1 AND m.left_at IS NULL ORDER BY r.room_id FOR UPDATE OF r`,[subjectId])).rows;
   for(const r of rooms){await db.query('UPDATE chat_memberships SET left_at=$3 WHERE room_id=$1 AND subject_id=$2',[r.room_id,subjectId,stamp(this.now())]);
    const members=await this.members(db,r.room_id),parties=new Set(members.map(m=>m.controller_ref));
    const state=!parties.size?'archived':r.owner_subject_id===subjectId?'owner-succession':parties.size===1&&r.mode==='ownerless'&&r.had_multiple?'single-member-decision':r.state;
    await db.query(`UPDATE chat_rooms SET state=$2,revision=revision+1,member_revision=member_revision+1,updated_at=$3,
     administrator_ids=$5,succession_expires_at=CASE WHEN $2='owner-succession' AND state<>'owner-succession' THEN $4 ELSE succession_expires_at END WHERE room_id=$1`,[r.room_id,state,stamp(this.now()),stamp(this.now()+7*day),JSON.stringify((r.administrator_ids??[]).filter(id=>id!==subjectId))]);
   }
   await db.query('UPDATE chat_agent_grants SET revoked_at=$2 WHERE subject_id=$1 AND revoked_at IS NULL',[subjectId,stamp(this.now())]);
   await db.query("UPDATE chat_message_refs SET state='retracted',purge_pending=true,retracted_at=COALESCE(retracted_at,$2) WHERE subject_id=$1 AND state IN ('pending','accepted')",[subjectId,stamp(this.now())]);
  });
  const rows=(await this.db.query('SELECT message_id FROM chat_message_refs WHERE subject_id=$1 AND purge_pending=true ORDER BY sequence LIMIT $2',[subjectId,limit])).rows;
  let deleted=0;for(const r of rows){try{await this.purgeOne(r.message_id);deleted++;}catch(e){if(!(e instanceof ServiceError))throw e;break;}}
  const pending=Number((await this.db.query('SELECT count(*) AS n FROM chat_message_refs WHERE subject_id=$1 AND purge_pending=true',[subjectId])).rows[0].n);
  return{subjectId,archiveDeleted:deleted,pendingArchiveDeletes:pending,complete:pending===0,agentGrantsRevoked:true,membershipsLeft:true,othersMessagesDeleted:false};
 }
 exportOwned(actor,{after='0',limit=100}={}){if(!/^\d+$/.test(after)||!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_chat_request',400);
  return this.run(actor,false,async db=>{const rows=(await db.query(`SELECT * FROM chat_message_refs WHERE subject_id=$1 AND sequence>$2
   AND state='accepted' AND expires_at>$3 ORDER BY sequence LIMIT $4`,[actor.subjectId,after,stamp(this.now()),limit+1])).rows;
   const messages=[];for(const r of rows.slice(0,limit)){if(!this.transport)fail('chat_transport_unavailable',503);
    const contents=await this.transport.exportOwn({roomId:r.room_id,subjectId:actor.subjectId,ids:[r.archive_id]});
    if(contents[0])messages.push({...this.receipt(r),roomId:r.room_id,sequence:String(r.sequence),text:contents[0].text});}
   return{messages,next:rows.length>limit?String(rows[limit-1].sequence):null,scope:'own-authored-retained-messages'};
  });
 }
 // For an already authenticated application transaction (e.g. Capsule source
 // selection). Reading a room never grants republication or evidence licensing.
 async readSelectedWithin(db,actor,{messageId,revision}){
  uuid(messageId);if(!Number.isInteger(revision)||revision<1)fail('invalid_chat_request',400);
  const located=(await db.query('SELECT room_id FROM chat_message_refs WHERE message_id=$1',[messageId])).rows[0];if(!located)fail('chat_message_unavailable',404);
  const ctx=await this.requireRoom(db,actor,located.room_id);
  const r=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 FOR SHARE',[messageId])).rows[0];
  if(r.state!=='accepted'||Date.parse(r.expires_at)<=this.now()*1000||r.revision!==revision)fail('chat_message_version_unavailable');
  if(r.subject_id!==actor.subjectId&&(await db.query("SELECT id FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased') LIMIT 1",[r.subject_id])).rows.length)fail('chat_message_version_unavailable');
  await this.project(ctx);const [body]=await this.transport.read({roomId:r.room_id,subjectId:actor.subjectId,ids:[r.archive_id],roomRevision:ctx.room.revision});
  if(!body||body.revision!==revision)fail('chat_message_version_unavailable');
  return{sourceType:'chat-message',messageId,roomId:r.room_id,revision,sequence:String(r.sequence),authorId:r.subject_id,text:body.text,contentHash:digest(body.text),expiresAt:r.expires_at,
   permission:'current-room-read-only',publicationPermission:false};
 }
}
