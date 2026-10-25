import {chatActorRef} from "../chat-actors.mjs";
import {randomUUID} from "node:crypto";
import {ServiceError} from "../shared/service-error.mjs";
import {assertTargetOperation} from "../target-governance-restrictions-v2.mjs";
import {chatSendSchema,chatEditSchema,chatMessageStatusSchema,chatOperationReceiptSchema} from "../shared/chat-schema.mjs";
import {chatMessageOperationsBlockedSql} from "../chat-message-operations-gate.mjs";
import {day,stamp,hash,fail,parse,uuid} from './helpers.mjs';
import {ChatGovernance} from './governance.mjs';

// Original message intents, stable send/edit receipts, cursor distinctions and personal hide. Unknown transport results never create a fresh send.
export class ChatMessages extends ChatGovernance{
 receipt(r){const state=['pending','accepted'].includes(r.state)&&Date.parse(r.expires_at)<=this.now()*1000?'expired':r.state;
  return{messageId:r.message_id,archiveId:r.archive_id,clientMessageId:r.client_message_id,state,revision:r.revision,acceptedByRoom:state==='accepted',readByOthers:false,sentAt:r.sent_at,expiresAt:r.expires_at};}
 async send(actor,roomId,input,{beforeSendWithin=null}={}){const x=parse(chatSendSchema,input);
  // Persist an ID before external I/O. A lost reply is retried with the same ID,
  // not converted into a new send or falsely reported as read by another person.
  const id=await this.run(actor,true,async db=>{
   const ctx=await this.requireRoom(db,actor,roomId,{write:true});await this.requireAccount(db,actor);if(['archived','owner-succession'].includes(ctx.room.state))fail('chat_room_read_only');
   await this.agent(db,actor,roomId,x.agentGrantId,{send:true});
   const old=(await db.query('SELECT * FROM chat_message_refs WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3',[roomId,chatActorRef(actor),x.clientMessageId])).rows[0];
   if(old){if(old.payload_hash!==hash(x))fail('chat_message_conflict');return old.message_id;}
   assertTargetOperation(ctx.governance,'sending-paused');
   if(x.attachments&&!this.attachments)fail('attachment_service_unavailable',503);
   if(beforeSendWithin)await beforeSendWithin(db);
   if(x.replyTo){const reply=(await db.query(`SELECT m.message_id FROM chat_message_refs m WHERE m.message_id=$1 AND m.room_id=$2 AND m.state='accepted' AND m.expires_at>$3 AND NOT ${chatMessageOperationsBlockedSql('m')}`,[x.replyTo,roomId,stamp(this.now())])).rows[0];if(!reply)fail('chat_reply_unavailable');}
   if(this.businessRules)await this.businessRules.enforceWithin(db,{actor,target:'chat-message',operationRef:x.clientMessageId,stage:'prepare',text:x.text,attachmentCount:x.attachments?.length??0});
   const id=randomUUID();await db.query(`INSERT INTO chat_message_refs(message_id,room_id,subject_id,client_message_id,payload_hash,actor_kind,agent_grant_id,reply_to,sent_at,expires_at,content_bytes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,roomId,chatActorRef(actor),x.clientMessageId,hash(x),x.agentGrantId?'agent':'human',x.agentGrantId??null,x.replyTo,stamp(this.now()),stamp(this.now()+ctx.room.retention_days*day),Buffer.byteLength(x.text,'utf8')]);
   if(x.attachments)await this.attachments.validateForMessageWithin(db,actor,{roomId,references:x.attachments,messageId:id});return id;
  });
  return this.run(actor,true,async db=>{
   const ctx=await this.requireRoom(db,actor,roomId,{write:true}),r=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 FOR UPDATE',[id])).rows[0];
    await this.requireAccount(db,actor);
   await this.agent(db,actor,roomId,x.agentGrantId,{send:true});if(r.state!=='pending')return this.receipt(r);
   assertTargetOperation(ctx.governance,'sending-paused');
   if(['archived','owner-succession'].includes(ctx.room.state)||Date.parse(r.expires_at)<=this.now()*1000)fail('chat_send_no_longer_allowed');
   if(x.attachments){if(!this.attachments)fail('attachment_service_unavailable',503);await this.attachments.validateForMessageWithin(db,actor,{roomId,references:x.attachments,messageId:id});}
   if(beforeSendWithin)await beforeSendWithin(db);
   await this.project(ctx);
   if(this.businessRules)await this.businessRules.enforceWithin(db,{actor,target:'chat-message',operationRef:x.clientMessageId,text:x.text,attachmentCount:x.attachments?.length??0});
   const receipt=await this.transport.send({roomId,subjectId:chatActorRef(actor),messageId:id,text:x.text,payloadHash:r.payload_hash,replyTo:x.replyTo,
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
  if(!x.requestHash){await this.requireRoom(db,actor,roomId);const r=(await db.query('SELECT * FROM chat_message_refs WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3',[roomId,chatActorRef(actor),x.clientMessageId])).rows[0];return r?this.receipt(r):{state:'not-found',acceptedByRoom:false};}
  // Read only the original owned request metadata. A former room member can
  // confirm an operation without retrieving its text, sources or archive body.
  const base={roomId,...x,checkedAt:stamp(this.now()),currentAccessGranted:false,contentReturned:false,othersReadStatus:'not-asserted',acceptedByRoom:false};
  const r=(await db.query('SELECT message_id,client_message_id,payload_hash,state,revision,sent_at,expires_at,archive_id,purge_pending FROM chat_message_refs WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3',[roomId,chatActorRef(actor),x.clientMessageId])).rows[0];
  if(!r)return{...base,state:'absent'};if(r.payload_hash!==x.requestHash)return{...base,state:'conflict'};
  const state=['pending','accepted'].includes(r.state)&&Date.parse(r.expires_at)<=this.now()*1000?'expired':r.state;
  return{...base,state,messageId:r.message_id,revision:r.revision,sentAt:new Date(r.sent_at).toISOString(),expiresAt:new Date(r.expires_at).toISOString(),
   acceptedByRoom:state==='accepted',historicalAcceptanceRecorded:!!r.archive_id,archiveCleanupState:r.purge_pending?'pending':['retracted','expired'].includes(r.state)?'recorded-complete':'not-requested'};
 });}
 operationStatus(actor,roomId,input){uuid(roomId);const x=parse(chatOperationReceiptSchema,input);return this.run(actor,false,async db=>{
  const base={roomId,...x,currentAccessGranted:false,contentReturned:false};
  const row=(await db.query('SELECT message_id,request_hash,state,result FROM chat_message_operations WHERE room_id=$1 AND operation_id=$2 AND subject_id=$3 AND kind=\'edit\'',[roomId,x.operationId,chatActorRef(actor)])).rows[0];
  if(!row)return{...base,state:'absent'};
  if(row.request_hash!==x.requestHash)return{...base,state:'conflict'};
  return{...base,state:row.state==='complete'?'acknowledged':row.state,messageId:row.message_id,
   ...(row.state==='complete'?{revision:row.result.revision,editedAt:new Date(row.result.editedAt).toISOString()}:{})};
 });}
 async edit(actor,roomId,messageId,input){uuid(messageId);const x=parse(chatEditSchema,input);
  const reservation=await this.run(actor,true,async db=>{
  const ctx=await this.requireRoom(db,actor,roomId,{write:true});await this.requireAccount(db,actor);const r=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 AND room_id=$2 FOR UPDATE',[messageId,roomId])).rows[0];
  if(!r||r.subject_id!==chatActorRef(actor))fail('chat_access_denied',403);
  if((await db.query('SELECT share_id FROM room_shared_summaries WHERE room_id=$1 AND subject_id=$2 AND share_id=$3 AND notice_hash=$4',[roomId,chatActorRef(actor),r.client_message_id,r.payload_hash])).rows.length)fail('chat_shared_summary_use_new_version');
  const old=(await db.query('SELECT * FROM chat_message_operations WHERE operation_id=$1',[x.operationId])).rows[0];
  if(old){if(old.message_id!==messageId||old.subject_id!==chatActorRef(actor)||old.kind!=='edit'||old.request_hash!==hash(x))fail('chat_operation_conflict');
   if(old.state==='cancelled')fail('chat_message_unavailable');return old;}
  assertTargetOperation(ctx.governance,'sending-paused');
  if(r.state!=='accepted'||Date.parse(r.expires_at)<=this.now()*1000)fail('chat_message_unavailable');
  if(['archived','owner-succession'].includes(ctx.room.state))fail('chat_room_read_only');
  if(this.now()*1000-Date.parse(r.sent_at)>day*1000)fail('chat_edit_window_closed_use_correction');if(r.revision!==x.expectedRevision)fail('chat_revision_conflict');
  if((await db.query("SELECT operation_id FROM chat_message_operations WHERE message_id=$1 AND state='pending'",[messageId])).rows.length)fail('chat_edit_pending_reconcile_first');
  if(this.businessRules)await this.businessRules.enforceWithin(db,{actor,target:'chat-message',operationRef:x.operationId,stage:'prepare',text:x.text,
   attachmentCount:Number((await db.query('SELECT count(*) AS count FROM chat_attachments WHERE message_id=$1',[messageId])).rows[0].count)});
  const result={messageId,revision:r.revision+1,editedAt:stamp(this.now())};
  const bytes=Buffer.byteLength(x.text,'utf8');
  await db.query('UPDATE chat_message_refs SET content_bytes=GREATEST(content_bytes,$2) WHERE message_id=$1',[messageId,bytes]);
  return(await db.query(`INSERT INTO chat_message_operations(operation_id,room_id,message_id,subject_id,kind,request_hash,result,created_at,state,previous_content_bytes,target_content_bytes,base_revision)
   VALUES($1,$2,$3,$4,'edit',$5,$6,$7,'pending',$8,$9,$10) RETURNING *`,[x.operationId,roomId,messageId,chatActorRef(actor),hash(x),JSON.stringify(result),stamp(this.now()),r.content_bytes,bytes,r.revision])).rows[0];
  });
  if(reservation.state==='complete')return reservation.result;
  // The increased byte reservation and operation receipt have already passed
  // the resource budget and committed before external MAM content can change.
  return this.run(actor,true,async db=>{
   const ctx=await this.requireRoom(db,actor,roomId,{write:true});await this.requireAccount(db,actor);const r=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 FOR UPDATE',[messageId])).rows[0];
   const op=(await db.query('SELECT * FROM chat_message_operations WHERE operation_id=$1 FOR UPDATE',[x.operationId])).rows[0];
   if(op.state==='complete')return op.result;
   assertTargetOperation(ctx.governance,'sending-paused');
   if(op.state!=='pending'||r.state!=='accepted'||Date.parse(r.expires_at)<=this.now()*1000)fail('chat_message_unavailable');
   if(['archived','owner-succession'].includes(ctx.room.state))fail('chat_room_read_only');
   if(r.revision!==op.base_revision)fail('chat_revision_conflict');
   await this.project(ctx);
   if(this.businessRules)await this.businessRules.enforceWithin(db,{actor,target:'chat-message',operationRef:x.operationId,text:x.text,
    attachmentCount:Number((await db.query('SELECT count(*) AS count FROM chat_attachments WHERE message_id=$1',[messageId])).rows[0].count)});
   const receipt=await this.transport.edit({roomId,messageId,subjectId:chatActorRef(actor),operationId:x.operationId,text:x.text,expectedRevision:r.revision,roomRevision:ctx.room.revision});
   if(receipt?.revision!==undefined&&receipt.revision!==r.revision+1)fail('chat_archive_receipt_invalid',502);
   await db.query('UPDATE chat_message_refs SET revision=revision+1,edited_at=$2,content_bytes=$3 WHERE message_id=$1',[messageId,op.result.editedAt,op.target_content_bytes]);
   await db.query("UPDATE chat_message_operations SET state='complete' WHERE operation_id=$1",[x.operationId]);return op.result;
  });
 }
 async retract(actor,roomId,messageId){uuid(messageId);await this.run(actor,true,async db=>{
  await this.requireRoom(db,actor,roomId,{write:true});const r=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 AND room_id=$2 FOR UPDATE',[messageId,roomId])).rows[0];
  if(!r||r.subject_id!==chatActorRef(actor))fail('chat_access_denied',403);if(r.state==='expired')fail('chat_message_unavailable');
  await db.query("UPDATE chat_message_refs SET state='retracted',purge_pending=true,retracted_at=COALESCE(retracted_at,$2) WHERE message_id=$1",[messageId,stamp(this.now())]);
 });
  // Tombstone commits before physical deletion. Failure cannot re-expose text.
  try{await this.purgeOne(messageId);return{messageId,retracted:true,archiveDeleted:true};}catch(e){if(!(e instanceof ServiceError))throw e;return{messageId,retracted:true,archiveDeleted:false,purgePending:true};}
 }
 hide(actor,roomId,messageId,{hidden=true}={}){uuid(messageId);if(typeof hidden!=='boolean')fail('invalid_chat_request',400);return this.run(actor,true,async db=>{await this.requireRoom(db,actor,roomId);const m=(await db.query('SELECT message_id FROM chat_message_refs WHERE message_id=$1 AND room_id=$2',[messageId,roomId])).rows[0];if(!m)fail('chat_message_unavailable');await db.query(`INSERT INTO chat_message_preferences(room_id,subject_id,message_id,hidden,updated_at) VALUES($1,$2,$3,$4,$5)
  ON CONFLICT(room_id,subject_id,message_id) DO UPDATE SET hidden=$4,updated_at=$5`,[roomId,chatActorRef(actor),messageId,hidden,stamp(this.now())]);return{hidden};});}
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
     ON CONFLICT(room_id,subject_id,message_id) DO NOTHING`,[roomId,chatActorRef(actor),row.message_id,stamp(this.now())]);
   }else if(kind==='human'){
    acceptedOrder=String((await db.query('SELECT COALESCE(MAX(accepted_order),0)::text AS ordinal FROM chat_message_refs WHERE room_id=$1 AND sequence<=$2',[roomId,sequence])).rows[0].ordinal);
   }
   const r=(await db.query(`INSERT INTO chat_cursors(room_id,subject_id,cursor_kind,agent_ref,sequence,accepted_order,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(room_id,subject_id,cursor_kind,agent_ref) DO UPDATE SET sequence=GREATEST(chat_cursors.sequence,$5),accepted_order=GREATEST(chat_cursors.accepted_order,$6),updated_at=$7 RETURNING sequence`,
    [roomId,chatActorRef(actor),kind,agentRef,sequence,acceptedOrder,stamp(this.now())])).rows[0];return{kind,sequence:String(r.sequence),agentGrantId:agentGrantId??null};
 });}
}
