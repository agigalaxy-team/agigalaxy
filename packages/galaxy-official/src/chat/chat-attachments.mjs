import {randomUUID,createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import {readAttachmentPayload} from "../infrastructure/attachment-payload.mjs";
import {chatActorRef,isAccountChatRef} from './chat-actors.mjs';
import {ServiceError} from "../shared/service-error.mjs";
import {transaction} from "../infrastructure/database.mjs";
import {attachmentPrepareSchema,attachmentReadSchema,attachmentQuerySchema,attachmentPolicySchema,defaultAttachmentPolicy} from "../shared/chat-attachments-schema.mjs";
import {retryFileProcessingWithin} from "../operations/files/processing.mjs";
import {chatMessageOperationsBlockedWithin} from './chat-message-operations-gate.mjs';
import {automaticFileCleanupSql,fileCleanupEligibility,fileCleanupSourceWithin} from "../operations/files/cleanup-eligibility.mjs";
import {assertFileAccessWithin,fileAccessReceiptWithin} from "../operations/files/access-gate.mjs";
const stamp=n=>new Date(n*1000).toISOString(),hash=x=>createHash('sha256').update(x).digest('hex');
const failure=(code,status=409)=>{throw new ServiceError(code,status);};
const parse=(schema,input)=>{const r=schema.safeParse(input);if(!r.success)failure('invalid_attachment_request',400);return r.data;};
const deleted="('requested','review-needed','approved','partial','primary-erased')";
export class ChatAttachmentsService {
 constructor({chat,store,scanner,policy=defaultAttachmentPolicy,logger=()=>{}}){Object.assign(this,{chat,store,scanner,logger});this.access=chat.access;this.db=chat.db;this.now=chat.now;this.policy=attachmentPolicySchema.parse(policy);}
 diagnostic(input){try{this.logger(input);}catch{}}
 specification(){return {supported:!!this.store&&!!this.scanner,storageRuntimeVerified:false,retentionDays:30,startsAt:'first-upload-start',
  maxFileBytes:this.policy.maxFileBytes,maxSubjectBytes:this.policy.maxSubjectBytes,maxFilesPerMessage:this.policy.maxFilesPerMessage,
  purpose:'temporary-room-attachment',publicStorageUrls:false,automaticEvidence:false,scanGuaranteesSafety:false};}
 configured(){if(!this.store||!this.scanner)failure('attachment_service_unavailable',503);}
 expired(row){return Date.parse(row.expires_at??row.prepare_expires_at)<=this.now()*1000;}
 status(row){return row.purged_at?'erased':row.revoked_at?'revoked':this.expired(row)?'expired':row.state;}
 receipt(row,{name=true}={}){return {attachmentId:row.id,roomId:row.room_id,messageId:row.message_id,state:this.status(row),
  ...(name?{name:row.name,mediaType:row.media_type}:{}),size:Number(row.byte_size),sha256:row.sha256,
  createdAt:row.created_at,uploadedAt:row.uploaded_at,expiresAt:row.expires_at??row.prepare_expires_at,
  expiryMeaning:row.expires_at?'uploaded-file-30d':'upload-preparation-deadline',scan:row.scan_result,
  retryAfter:row.lease_until,cleanupPending:row.purge_pending,objectRemoved:!!row.purged_at,automaticEvidence:false};}
 receiptWithin(db,row){return fileAccessReceiptWithin(db,{endpoint:this.access.endpoint,kind:'chat',id:row.id,now:this.now()},this.receipt(row));}
 async row(db,id,lock='SHARE'){return(await db.query(`SELECT * FROM chat_attachments WHERE id=$1 FOR ${lock}`,[id])).rows[0];}
 async retryProcessingWithin(db,row,input){this.configured();return retryFileProcessingWithin(db,{table:'chat_attachments',row,input,now:this.now(),authorUnavailable:await this.authorPending(db,row)});}
 async authorPending(db,row){if(isAccountChatRef(row.subject_id))return false;return !!(await db.query(`SELECT id FROM deletion_requests WHERE subject_id=$1 AND state IN ${deleted} LIMIT 1`,[row.subject_id])).rows.length;}
 async roomRow(db,actor,id,{write=false,agentGrantId,own=false}={}){
  const located=(await db.query('SELECT room_id FROM chat_attachments WHERE id=$1',[id])).rows[0];if(!located)failure('attachment_unavailable',404);
  const ctx=await this.chat.requireRoom(db,actor,located.room_id,{write});if(write)await this.chat.requireAccount(db,actor);await this.chat.agent(db,actor,located.room_id,agentGrantId,{send:write});
  const row=await this.row(db,id,write?'UPDATE':'SHARE');if(!row||own&&row.subject_id!==chatActorRef(actor))failure('attachment_unavailable',404);
  if(row.subject_id!==chatActorRef(actor)&&await this.authorPending(db,row))failure('attachment_unavailable',404);
  if(row.subject_id!==chatActorRef(actor)&&!row.message_id)failure('attachment_unavailable',404);
  if(write&&['archived','owner-succession'].includes(ctx.room.state))failure('chat_room_read_only');
  return {row,ctx};
 }
 async readableWithin(db,actor,row,{ownExport=false}={}){
  const available=()=>{if(this.status(row)!=='available')failure('attachment_content_unavailable',404);};available();
   await assertFileAccessWithin(db,{endpoint:this.access.endpoint,kind:'chat',id:row.id,now:this.now()});
  if(row.subject_id!==chatActorRef(actor)&&await this.authorPending(db,row))failure('attachment_content_unavailable',404);
   if(row.message_id&&await chatMessageOperationsBlockedWithin(db,{messageId:row.message_id}))failure('attachment_message_unavailable',404);
  if(ownExport){if(row.subject_id!==chatActorRef(actor))failure('attachment_unavailable',404);available();return;}
  if(!row.message_id){if(row.subject_id!==chatActorRef(actor))failure('attachment_content_unavailable',404);available();return;}
  const message=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 FOR SHARE',[row.message_id])).rows[0];
  if(!message||message.state!=='accepted'||Date.parse(message.expires_at)<=this.now()*1000)failure('attachment_message_unavailable',404);
  if((await db.query('SELECT hidden FROM chat_message_preferences WHERE message_id=$1 AND subject_id=$2',[row.message_id,chatActorRef(actor)])).rows[0]?.hidden)failure('attachment_message_unavailable',404);
  available();if(Date.parse(message.expires_at)<=this.now()*1000)failure('attachment_message_unavailable',404);
 }
 async prepare(actor,input){const x=parse(attachmentPrepareSchema,input);this.configured();if(x.size>this.policy.maxFileBytes)failure('attachment_too_large',413);
  return this.chat.run(actor,true,async db=>{
   const ctx=await this.chat.requireRoom(db,actor,x.roomId,{write:true});await this.chat.requireAccount(db,actor);await this.chat.agent(db,actor,x.roomId,x.agentGrantId,{send:true});
   if(['archived','owner-succession'].includes(ctx.room.state))failure('chat_room_read_only');
   if(await this.authorPending(db,{subject_id:chatActorRef(actor)}))failure('attachment_author_unavailable');
   const requestHash=hash(canonicalize(x)),old=await this.row(db,x.attachmentId,'UPDATE');
   if(old){if(old.subject_id!==chatActorRef(actor)||old.request_hash!==requestHash)failure('attachment_operation_conflict');return this.receiptWithin(db,old);}
   if(this.businessRules)await this.businessRules.enforceWithin(db,{actor,target:'chat-upload',operationRef:x.attachmentId,stage:'prepare',fileBytes:x.size});
   await db.query('SELECT pg_advisory_xact_lock(734912320,0)');
   const totals=(await db.query(`SELECT COALESCE(sum(byte_size),0)::text AS all_bytes,COALESCE(sum(CASE WHEN owner_ref=$1 THEN byte_size ELSE 0 END),0)::text AS owner_bytes FROM (SELECT byte_size,subject_id AS owner_ref FROM chat_attachments WHERE purged_at IS NULL UNION ALL SELECT byte_size,'account:'||account_id::text AS owner_ref FROM forum_attachments_v1 WHERE purged_at IS NULL UNION ALL SELECT byte_size,'account:'||account_id::text AS owner_ref FROM feedback_attachments_v1 WHERE purged_at IS NULL) storage`,[chatActorRef(actor)])).rows[0];
   if(BigInt(totals.all_bytes)+BigInt(x.size)>BigInt(this.policy.maxGlobalBytes)||BigInt(totals.owner_bytes)+BigInt(x.size)>BigInt(this.policy.maxSubjectBytes))failure('attachment_storage_quota_exceeded');
   const row=(await db.query(`INSERT INTO chat_attachments(id,room_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,agent_grant_id,created_at,prepare_expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[x.attachmentId,x.roomId,chatActorRef(actor),requestHash,x.name,x.mediaType,x.size,x.sha256,'attachments/'+x.attachmentId,this.store.keyId,x.agentGrantId??null,stamp(this.now()),stamp(this.now()+3600)])).rows[0];return this.receiptWithin(db,row);
  });
 }
 async get(actor,input){const x=parse(attachmentReadSchema,input);return this.chat.run(actor,false,async db=>{const {row}=await this.roomRow(db,actor,x.attachmentId,x);return this.receiptWithin(db,row);});}
 async queryOwn(actor,input){const x=parse(attachmentQuerySchema,input);return this.chat.run(actor,false,async db=>{
  await this.chat.requireRoom(db,actor,x.roomId);const rows=(await db.query("SELECT * FROM chat_attachments WHERE subject_id=$1 AND room_id=$2 AND ($3='' OR id::text>$3) ORDER BY id LIMIT $4",[chatActorRef(actor),x.roomId,x.after??'',x.limit+1])).rows;
   return {items:await Promise.all(rows.slice(0,x.limit).map(r=>this.receiptWithin(db,r))),nextAfter:rows.length>x.limit?rows[x.limit-1].id:null};});}
 async upload(actor,id,stream,{contentLength,contentType='application/octet-stream',onBytes=()=>{}}={}){
  parse(attachmentReadSchema,{attachmentId:id});this.configured();if(contentType!=='application/octet-stream')failure('attachment_media_type_required',415);
  const lease=randomUUID(),started=await this.chat.run(actor,true,async db=>{
   const {row}=await this.roomRow(db,actor,id,{write:true,own:true});
   if(['scan-pending','scanning','available'].includes(this.status(row)))return {done:true,row};
   if(this.expired(row)||row.revoked_at||row.purged_at||!['prepared','uploading'].includes(row.state)||row.message_id)failure('attachment_upload_unavailable');
   if(row.agent_grant_id)await this.chat.agent(db,actor,row.room_id,row.agent_grant_id,{send:true});
   if(contentLength!==Number(row.byte_size))failure('attachment_size_mismatch',400);
   if(row.lease_until&&Date.parse(row.lease_until)>this.now()*1000)failure('attachment_upload_in_progress');
   if(this.businessRules)await this.businessRules.enforceWithin(db,{actor,target:'chat-upload',operationRef:id,stage:'upload-start',fileBytes:Number(row.byte_size)});
   await db.query('SELECT pg_advisory_xact_lock(734912320,0)');
   if(Number((await db.query("SELECT count(*) AS n FROM (SELECT id FROM chat_attachments WHERE state='uploading' AND lease_until>$1 UNION ALL SELECT id FROM forum_attachments_v1 WHERE state='uploading' AND lease_until>$1 UNION ALL SELECT id FROM feedback_attachments_v1 WHERE state='uploading' AND lease_until>$1) uploading",[stamp(this.now())])).rows[0].n)>=4)failure('attachment_upload_capacity',429);
   return {row:(await db.query(`UPDATE chat_attachments SET state='uploading',lease_id=$2,lease_until=$3,uploaded_at=COALESCE(uploaded_at,$4),expires_at=COALESCE(expires_at,$5),last_error=NULL WHERE id=$1 RETURNING *`,[id,lease,stamp(this.now()+120),stamp(this.now()),stamp(this.now()+30*86400)])).rows[0]};
  });
   if(started.done)return this.get(actor,{attachmentId:id,...(started.row.agent_grant_id?{agentGrantId:started.row.agent_grant_id}:{})});
  const r=started.row;let putAttempted=false;
  try{
   const bytes=await readAttachmentPayload(stream,{size:Number(r.byte_size),sha256:r.sha256,mediaType:r.media_type,maxFileBytes:this.policy.maxFileBytes,onBytes});
   if(this.businessRules)await this.chat.run(actor,true,async db=>{
    const {row}=await this.roomRow(db,actor,id,{write:true,own:true});if(row.lease_id!==lease||row.revoked_at||this.expired(row))failure('attachment_upload_no_longer_allowed');
    await this.businessRules.enforceWithin(db,{actor,target:'chat-upload',operationRef:id,stage:'upload-bytes',fileBytes:Number(row.byte_size)});
    putAttempted=true;await this.store.put({key:r.storage_key,bytes,sha256:r.sha256});
   });
   else{putAttempted=true;await this.store.put({key:r.storage_key,bytes,sha256:r.sha256});}
   return await this.chat.run(actor,true,async db=>{
    const {row}=await this.roomRow(db,actor,id,{write:true,own:true});
    if(row.lease_id!==lease||row.revoked_at||this.expired(row)||await this.authorPending(db,row))failure('attachment_upload_no_longer_allowed');
    return this.receiptWithin(db,(await db.query("UPDATE chat_attachments SET state='scan-pending',lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 RETURNING *",[id])).rows[0]);
   });
  }catch(error){
   const invalid=['attachment_too_large','attachment_digest_mismatch','attachment_file_format_invalid','attachment_media_type_mismatch','attachment_media_type_unrecognized'].includes(error.code);
   await transaction(this.db,async db=>{await db.query(`UPDATE chat_attachments SET lease_until=$3,last_error=$4,purge_pending=purge_pending OR revoked_at IS NOT NULL OR $5,state=CASE WHEN $5 THEN 'blocked' WHEN $6 THEN 'uploading' ELSE 'prepared' END WHERE id=$1 AND lease_id=$2`,[id,lease,stamp(this.now()),error instanceof ServiceError?error.code:'attachment_upload_failed',invalid,putAttempted]);}).catch(()=>{});
   throw error;
  }
 }
 async validateForMessageWithin(db,actor,{roomId,references,messageId=null}){
  if(!references?.length)return;
  if(references.length>this.policy.maxFilesPerMessage||new Set(references.map(r=>r.id)).size!==references.length)failure('attachment_reference_invalid',400);
  for(const ref of [...references].sort((a,b)=>a.id.localeCompare(b.id))){const row=await this.row(db,ref.id,'UPDATE');
   if(!row||row.subject_id!==chatActorRef(actor)||row.room_id!==roomId||row.sha256!==ref.sha256||this.status(row)!=='available'||await this.authorPending(db,row)
    ||row.message_id&&row.message_id!==messageId)failure('attachment_reference_unavailable');
    await assertFileAccessWithin(db,{endpoint:this.access.endpoint,kind:'chat',id:row.id,now:this.now()});
   if(messageId)await db.query('UPDATE chat_attachments SET message_id=$2 WHERE id=$1',[row.id,messageId]);
  }
 }
 async forMessagesWithin(db,actor,messageIds){if(!messageIds.length)return new Map();
  const rows=(await db.query('SELECT * FROM chat_attachments WHERE message_id=ANY($1::uuid[]) ORDER BY created_at,id',[messageIds])).rows,map=new Map();
  for(const row of rows){const list=map.get(row.message_id)??[];let permitted=true;try{await this.readableWithin(db,actor,row);}catch(e){if(!(e instanceof ServiceError))throw e;permitted=false;}
   list.push(permitted?await this.receiptWithin(db,row):{attachmentId:row.id,state:this.status(row)==='available'?'unavailable':this.status(row),contentAvailable:false});map.set(row.message_id,list);}
  return map;
 }
 async content(actor,input,{ownExport=false}={}){const x=parse(attachmentReadSchema,input);this.configured();
  return this.chat.run(actor,false,async db=>{let row;
   if(ownExport){row=await this.row(db,x.attachmentId);if(!row||row.subject_id!==chatActorRef(actor))failure('attachment_unavailable',404);}
   else ({row}=await this.roomRow(db,actor,x.attachmentId,x));
   await this.readableWithin(db,actor,row,{ownExport});const bytes=await this.store.get({key:row.storage_key,keyId:row.encryption_key_id,size:Number(row.byte_size)});
   if(!bytes||hash(bytes)!==row.sha256)failure('attachment_storage_integrity_failed',502);
   // Row/source locks preserve a current transaction snapshot, but time can
   // still advance while object storage is read. Re-check the actual room/
   // Agent and source authorization and expiry before returning any bytes.
   if(ownExport){row=await this.row(db,x.attachmentId);if(!row||row.subject_id!==chatActorRef(actor))failure('attachment_unavailable',404);}
   else ({row}=await this.roomRow(db,actor,x.attachmentId,x));
   await this.readableWithin(db,actor,row,{ownExport});
   return {bytes,name:row.name,mediaType:row.media_type,sha256:row.sha256,attachmentId:row.id};
  });
 }
 // Only the governance domain supplies this callback after establishing a
 // real operator and an explicit case selection. It grants no room identity,
 // history query, reusable URL or reporter credential.
 async selectedCaseContentWithin(db,{attachmentId,roomId,messageId,revision,assertCase}){
  this.configured();if(typeof assertCase!=='function')failure('attachment_unavailable',404);
  const current=async()=>{
   const selection=await assertCase();
   if(selection?.roomId!==roomId||selection.messageId!==messageId||selection.revision!==revision)failure('attachment_unavailable',404);
   const row=await this.row(db,attachmentId);
   if(!row||row.room_id!==roomId||row.message_id!==messageId||this.status(row)!=='available'||await this.authorPending(db,row))failure('attachment_content_unavailable',404);
    await assertFileAccessWithin(db,{endpoint:this.access.endpoint,kind:'chat',id:row.id,now:this.now()});
   const message=(await db.query('SELECT state,revision,expires_at FROM chat_message_refs WHERE message_id=$1 AND room_id=$2 FOR SHARE',[messageId,roomId])).rows[0];
   if(!message||message.state!=='accepted'||message.revision!==revision||Date.parse(message.expires_at)<=this.now()*1000)failure('attachment_message_unavailable',404);
   return row;
  };
  let row=await current();const bytes=await this.store.get({key:row.storage_key,keyId:row.encryption_key_id,size:Number(row.byte_size)});
  if(!bytes||hash(bytes)!==row.sha256)failure('attachment_storage_integrity_failed',502);
  row=await current();return{bytes,name:row.name,mediaType:row.media_type,sha256:row.sha256,attachmentId:row.id};
 }
 async revoke(actor,input){const x=parse(attachmentReadSchema,input);return this.chat.run(actor,true,async db=>{
  const row=await this.row(db,x.attachmentId,'UPDATE');if(!row||row.subject_id!==chatActorRef(actor))failure('attachment_unavailable',404);
   return this.receiptWithin(db,(await db.query('UPDATE chat_attachments SET revoked_at=COALESCE(revoked_at,$2),purge_pending=true WHERE id=$1 RETURNING *',[row.id,stamp(this.now())])).rows[0]);});}
 async scanPending({limit=1}={}){this.configured();if(!Number.isInteger(limit)||limit<1||limit>4)failure('invalid_attachment_scan_limit',400);let scanned=0;
  for(let i=0;i<limit;i++){
   const lease=randomUUID(),row=await transaction(this.db,async db=>{
    const r=(await db.query(`SELECT * FROM chat_attachments WHERE state IN ('scan-pending','scanning') AND revoked_at IS NULL AND purge_pending=false AND expires_at>$1 AND (lease_until IS NULL OR lease_until<=$1) ORDER BY uploaded_at LIMIT 1 FOR UPDATE SKIP LOCKED`,[stamp(this.now())])).rows[0];
    if(!r)return null;return(await db.query("UPDATE chat_attachments SET state='scanning',lease_id=$2,lease_until=$3,scan_attempts=scan_attempts+1 WHERE id=$1 RETURNING *",[r.id,lease,stamp(this.now()+120)])).rows[0];});
   if(!row)break;
   const startedAt=performance.now();
   try{if(await this.authorPending(this.db,row))failure('attachment_author_unavailable');
    const bytes=await this.store.get({key:row.storage_key,keyId:row.encryption_key_id,size:Number(row.byte_size)});if(!bytes||hash(bytes)!==row.sha256)failure('attachment_storage_integrity_failed');
    const result=await this.scanner.scan(bytes);if(!['clean','blocked'].includes(result.state))failure('attachment_scan_incomplete',503);
    await transaction(this.db,async db=>{const current=await this.row(db,row.id,'UPDATE');if(current.lease_id!==lease)return;
     if(await this.authorPending(db,current))failure('attachment_author_unavailable');
     const invalid=current.revoked_at||this.expired(current);
     await db.query("UPDATE chat_attachments SET state=$2,scan_result=$3,lease_id=NULL,lease_until=NULL,last_error=NULL,purge_pending=$4 WHERE id=$1",[row.id,invalid||result.state==='blocked'?'blocked':'available',JSON.stringify(result),!!invalid||result.state==='blocked']);});scanned++;
   }catch(error){this.diagnostic({event:'attachment_processing_deferred',stage:'attachment-scan',resourceId:row.id,startedAt,error});await this.db.query("UPDATE chat_attachments SET state='scan-pending',lease_id=NULL,lease_until=$3,last_error=$4 WHERE id=$1 AND lease_id=$2",[row.id,lease,stamp(this.now()+60),error instanceof ServiceError?error.code:'attachment_scan_failed']);}
  }
  return {scanned};
 }
 async purgeExpired({limit=20}={}){this.configured();if(!Number.isInteger(limit)||limit<1||limit>100)failure('invalid_attachment_cleanup_limit',400);
  await this.db.query(`UPDATE chat_attachments a SET purge_pending=true WHERE a.purged_at IS NULL AND ${automaticFileCleanupSql('chat')}`,[stamp(this.now())]);
  // Expiry is not an approval. Only owner deletion and concrete upload safety
  // failures continue here; operational expiry is consumed by approved plans.
  const rows=(await this.db.query(`SELECT a.id FROM chat_attachments a WHERE a.purge_pending=true AND a.purged_at IS NULL AND (a.lease_until IS NULL OR a.lease_until<=$1) AND ${automaticFileCleanupSql('chat')} ORDER BY a.created_at LIMIT $2`,[stamp(this.now()),limit])).rows;let removed=0;
  for(const {id} of rows){const startedAt=performance.now();try{await transaction(this.db,async db=>{const r=await this.row(db,id,'UPDATE');if(!r.purge_pending||r.purged_at||r.lease_until&&Date.parse(r.lease_until)>this.now()*1000)return;
    const eligibility=fileCleanupEligibility(r,await fileCleanupSourceWithin(db,{kind:'chat',row:r,now:this.now()}),this.now());if(eligibility.category!=='automatic'||eligibility.blockedReason)return;
    await this.store.erase({key:r.storage_key});await db.query("UPDATE chat_attachments SET state='erased',name='',media_type='',purge_pending=false,purged_at=$2,lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1",[r.id,stamp(this.now())]);removed++;});}catch(e){this.diagnostic({event:'attachment_processing_deferred',stage:'attachment-cleanup',resourceId:id,startedAt,error:e});await this.db.query("UPDATE chat_attachments SET last_error='attachment_cleanup_failed' WHERE id=$1 AND purge_pending=true AND purged_at IS NULL",[id]);if(!(e instanceof ServiceError))throw e;}}
  const metadata=await this.db.query("DELETE FROM chat_attachments a WHERE a.purged_at IS NOT NULL AND (a.purged_at<$1 OR EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=a.subject_id AND d.state IN ('partial','primary-erased')))",[stamp(this.now()-180*86400)]);
  return {objectRemoved:removed,metadataRemoved:metadata.rowCount??metadata.affectedRows??0,physicalBlockErasure:'storage-garbage-collection'};
 }
 async eraseSubject(subjectId){await this.db.query('UPDATE chat_attachments SET revoked_at=COALESCE(revoked_at,$2),purge_pending=true WHERE subject_id=$1 AND purged_at IS NULL',[subjectId,stamp(this.now())]);
  await this.purgeExpired({limit:100});const remaining=Number((await this.db.query('SELECT count(*) AS n FROM chat_attachments WHERE subject_id=$1 AND purged_at IS NULL',[subjectId])).rows[0].n);
  return {subjectId,pendingObjects:remaining,complete:remaining===0,physicalBlockErasure:'storage-garbage-collection'};
 }
}
