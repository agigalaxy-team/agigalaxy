import {randomUUID,createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {readAttachmentPayload} from './infrastructure/attachment-payload.mjs';
import {attachmentPolicySchema,defaultAttachmentPolicy} from './shared/chat-attachments-schema.mjs';
import {feedbackAttachmentPrepareSchema,feedbackAttachmentTargetSchema,feedbackAttachmentReferencesSchema,feedbackAttachmentPolicySchema,defaultFeedbackAttachmentPolicy,parseFeedbackAttachment} from './shared/feedback-attachments-v1-schema.mjs';

const stamp=value=>new Date(value*1000).toISOString(),hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storage=`SELECT byte_size,subject_id AS owner_ref FROM chat_attachments WHERE purged_at IS NULL
 UNION ALL SELECT byte_size,'account:'||account_id::text AS owner_ref FROM forum_attachments_v1 WHERE purged_at IS NULL
 UNION ALL SELECT byte_size,'account:'||account_id::text AS owner_ref FROM feedback_attachments_v1 WHERE purged_at IS NULL`;

// Feedback owns this private reference and its permissions. Neither a forum
// source, room membership nor a governance case grants any access here.
export class FeedbackAttachmentsV1Service {
 constructor({db,endpoint,accounts=null,store=null,scanner=null,policy=defaultAttachmentPolicy,feedbackPolicy=defaultFeedbackAttachmentPolicy,now=()=>Math.floor(Date.now()/1000),logger=()=>{}}){
  Object.assign(this,{db,endpoint,accounts,store,scanner,now,logger});this.policy=attachmentPolicySchema.parse(policy);this.feedbackPolicy=feedbackAttachmentPolicySchema.parse(feedbackPolicy);
 }
 specification(){return {supported:!!this.store&&!!this.scanner,storageRuntimeVerified:false,maxFileBytes:this.policy.maxFileBytes,
  maxFilesPerFeedback:Math.min(4,this.policy.maxFilesPerMessage),...this.feedbackPolicy,retentionPolicySource:'configurable-engineering-default',
  startsAt:'first-upload-start',purpose:'private-feedback-attachment',publicStorageUrls:false,automaticEvidence:false,scanGuaranteesSafety:false,automaticPhysicalCleanup:false};}
 configured(){if(!this.store||!this.scanner)fail('attachment_service_unavailable',503);}
 expired(row){return Date.parse(row.expires_at??row.prepare_expires_at)<=this.now()*1000;}
 state(row){return row.purged_at?'erased':row.revoked_at?'revoked':this.expired(row)?'expired':row.state;}
 receipt(row){return {attachmentId:row.id,operationId:row.submission_operation_id,name:row.name,mediaType:row.media_type,
  size:Number(row.byte_size),sha256:row.sha256,state:this.state(row),expiresAt:row.expires_at??row.prepare_expires_at,
  uploadRetryAt:row.lease_until,uploadRetryable:['prepared','uploading'].includes(this.state(row))&&(!row.lease_until||Date.parse(row.lease_until)<=this.now()*1000),
  scanState:['clean','blocked'].includes(row.scan_result?.state)?row.scan_result.state:null};}
 async row(db,id,lock='SHARE'){return(await db.query(`SELECT * FROM feedback_attachments_v1 WHERE id=$1 AND endpoint=$2 FOR ${lock}`,[id,this.endpoint])).rows[0];}
 async run(actor,fn){
  if(actor?.kind!=='official-account'||actor.endpoint!==this.endpoint||!uuid.test(actor.accountId??''))fail('official_account_login_required',401);
  if(!this.accounts)fail('official_account_unavailable',503);
  // Feedback remains available when community publication is restricted.
  return this.accounts.runAuthorized(actor,'binding',async(db,_authorization,current)=>{
   const account=await this.accounts.resolveWithin(db,current,{accountId:actor.accountId,requireExplicit:true});return fn(db,account);
  },{control:true});
 }
 async lockDraftWithin(db,accountId,operationId){
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912395))',[this.endpoint+':feedback-intake:'+accountId]);
  if((await db.query('SELECT id FROM operations_feedback_v1 WHERE endpoint=$1 AND account_id=$2 AND submission_operation_id=$3',[this.endpoint,accountId,operationId])).rows.length)fail('feedback_attachment_draft_closed');
 }
 async ownedWithin(db,accountId,target,{lock='SHARE',draft=true}={}){
  const row=await this.row(db,target.attachmentId,lock);
  if(!row||row.account_id!==accountId||row.submission_operation_id!==target.operationId||draft&&row.feedback_id)fail('feedback_attachment_unavailable',404);return row;
 }
 async prepare(actor,input){const x=parseFeedbackAttachment(feedbackAttachmentPrepareSchema,input);this.configured();if(x.size>this.policy.maxFileBytes)fail('attachment_too_large',413);
  return this.run(actor,async(db,account)=>{
   await this.lockDraftWithin(db,account.id,x.operationId);const requestHash=hash(canonicalize(x)),old=await this.row(db,x.attachmentId,'UPDATE');
   if(old){if(old.account_id!==account.id||old.submission_operation_id!==x.operationId||old.request_hash!==requestHash||old.feedback_id)fail('attachment_operation_conflict');return this.receipt(old);}
   const count=(await db.query(`SELECT count(*)::int AS n FROM feedback_attachments_v1 WHERE endpoint=$1 AND account_id=$2 AND submission_operation_id=$3
    AND revoked_at IS NULL AND purged_at IS NULL AND NOT purge_pending AND COALESCE(expires_at,prepare_expires_at)>$4`,[this.endpoint,account.id,x.operationId,stamp(this.now())])).rows[0].n;
   if(count>=this.specification().maxFilesPerFeedback)fail('feedback_attachment_count_exceeded',400);
   await db.query('SELECT pg_advisory_xact_lock(734912320,0)');
   const usage=(await db.query(`SELECT COALESCE(sum(byte_size),0)::text AS all_bytes,COALESCE(sum(CASE WHEN owner_ref=$1 THEN byte_size ELSE 0 END),0)::text AS owner_bytes FROM (${storage}) storage`,['account:'+account.id])).rows[0];
   if(BigInt(usage.all_bytes)+BigInt(x.size)>BigInt(this.policy.maxGlobalBytes)||BigInt(usage.owner_bytes)+BigInt(x.size)>BigInt(this.policy.maxSubjectBytes))fail('attachment_storage_quota_exceeded');
   const row=(await db.query(`INSERT INTO feedback_attachments_v1(id,endpoint,account_id,submission_operation_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,created_at,prepare_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[x.attachmentId,this.endpoint,account.id,x.operationId,requestHash,x.name,x.mediaType,x.size,x.sha256,'feedback-attachments/'+x.attachmentId,this.store.keyId,stamp(this.now()),stamp(this.now()+3600)])).rows[0];return this.receipt(row);
  });
 }
 get(actor,input){const x=parseFeedbackAttachment(feedbackAttachmentTargetSchema,input);return this.run(actor,async(db,account)=>this.receipt(await this.ownedWithin(db,account.id,x)));}
 async upload(actor,attachmentId,stream,options={}){
  if(!uuid.test(attachmentId??''))fail('invalid_feedback_attachment_request',400);
  const operationId=await this.run(actor,async(db,account)=>{const row=await this.row(db,attachmentId);
   if(!row||row.account_id!==account.id||row.feedback_id)fail('feedback_attachment_unavailable',404);return row.submission_operation_id;});
  return this.uploadDraft(actor,attachmentId,operationId,stream,options);
 }
 async uploadDraft(actor,attachmentId,operationId,stream,{contentLength,contentType='application/octet-stream',onBytes=()=>{}}={}){
  const x=parseFeedbackAttachment(feedbackAttachmentTargetSchema,{attachmentId,operationId});this.configured();if(contentType!=='application/octet-stream')fail('attachment_media_type_required',415);
  const lease=randomUUID(),started=await this.run(actor,async(db,account)=>{
   await this.lockDraftWithin(db,account.id,x.operationId);const row=await this.ownedWithin(db,account.id,x,{lock:'UPDATE'}),state=this.state(row);
   if(!row.purge_pending&&['scan-pending','scanning','available'].includes(state))return {done:true,row};
   if(row.revoked_at||row.purge_pending||this.expired(row)||!['prepared','uploading'].includes(state))fail('attachment_upload_unavailable');
   if(contentLength!==Number(row.byte_size))fail('attachment_size_mismatch',400);
   if(row.lease_until&&Date.parse(row.lease_until)>this.now()*1000)fail('attachment_upload_in_progress');
   await db.query('SELECT pg_advisory_xact_lock(734912320,0)');
   const count=(await db.query(`SELECT count(*)::int AS n FROM (
    SELECT id FROM chat_attachments WHERE state='uploading' AND lease_until>$1
    UNION ALL SELECT id FROM forum_attachments_v1 WHERE state='uploading' AND lease_until>$1
    UNION ALL SELECT id FROM feedback_attachments_v1 WHERE state='uploading' AND lease_until>$1) uploading`,[stamp(this.now())])).rows[0].n;
   if(count>=4)fail('attachment_upload_capacity',429);
   return {row:(await db.query(`UPDATE feedback_attachments_v1 SET state='uploading',lease_id=$2,lease_until=$3,uploaded_at=COALESCE(uploaded_at,$4),expires_at=COALESCE(expires_at,$5),last_error=NULL WHERE id=$1 RETURNING *`,
    [x.attachmentId,lease,stamp(this.now()+120),stamp(this.now()),stamp(this.now()+this.feedbackPolicy.draftRetentionDays*86400)])).rows[0]};
  });
  if(started.done)return this.receipt(started.row);const row=started.row;let putAttempted=false;
  try{
   const bytes=await readAttachmentPayload(stream,{size:Number(row.byte_size),sha256:row.sha256,mediaType:row.media_type,maxFileBytes:this.policy.maxFileBytes,onBytes});
   putAttempted=true;await this.store.put({key:row.storage_key,bytes,sha256:row.sha256});
   return await this.run(actor,async(db,account)=>{
    await this.lockDraftWithin(db,account.id,x.operationId);const current=await this.ownedWithin(db,account.id,x,{lock:'UPDATE'});
    if(current.lease_id!==lease||current.revoked_at||current.purge_pending||this.expired(current))fail('attachment_upload_no_longer_allowed');
    return this.receipt((await db.query("UPDATE feedback_attachments_v1 SET state='scan-pending',lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 RETURNING *",[row.id])).rows[0]);
   });
  }catch(error){
   const invalid=['attachment_too_large','attachment_size_mismatch','attachment_digest_mismatch','attachment_file_format_invalid','attachment_media_type_mismatch','attachment_media_type_unrecognized'].includes(error.code);
   await transaction(this.db,db=>db.query(`UPDATE feedback_attachments_v1 SET lease_until=$3,last_error=$4,purge_pending=purge_pending OR revoked_at IS NOT NULL OR $5,
    state=CASE WHEN $5 THEN 'blocked' WHEN $6 THEN 'uploading' ELSE 'prepared' END WHERE id=$1 AND lease_id=$2`,
    [row.id,lease,stamp(this.now()),error instanceof ServiceError?error.code:'attachment_upload_failed',invalid,putAttempted])).catch(()=>{});throw error;
  }
 }
 revoke(actor,input){const x=parseFeedbackAttachment(feedbackAttachmentTargetSchema,input);return this.run(actor,async(db,account)=>{
  await this.lockDraftWithin(db,account.id,x.operationId);const row=await this.ownedWithin(db,account.id,x,{lock:'UPDATE'});
  return this.receipt((await db.query('UPDATE feedback_attachments_v1 SET revoked_at=COALESCE(revoked_at,$2),purge_pending=true WHERE id=$1 RETURNING *',[row.id,stamp(this.now())])).rows[0]);
 });}
 async bindWithin(db,{accountId,operationId,feedbackId,references}){
  const refs=parseFeedbackAttachment(feedbackAttachmentReferencesSchema,references);if(!refs.length)return;this.configured();
  if(refs.length>this.specification().maxFilesPerFeedback)fail('feedback_attachment_count_exceeded',400);
  for(const reference of [...refs].sort((a,b)=>a.id.localeCompare(b.id))){
   const row=await this.ownedWithin(db,accountId,{attachmentId:reference.id,operationId},{lock:'UPDATE'});
   if(row.sha256!==reference.sha256||row.purge_pending||this.state(row)!=='available'||row.scan_result?.state!=='clean'||!row.uploaded_at)fail('feedback_attachment_not_ready');
   await db.query('UPDATE feedback_attachments_v1 SET feedback_id=$2,bound_at=$3,expires_at=$4 WHERE id=$1',
    [row.id,feedbackId,stamp(this.now()),new Date(Date.parse(row.uploaded_at)+this.feedbackPolicy.submittedRetentionDays*86400000).toISOString()]);
  }
 }
 async forFeedbackWithin(db,feedbackId){const rows=(await db.query('SELECT * FROM feedback_attachments_v1 WHERE endpoint=$1 AND feedback_id=$2 ORDER BY created_at,id',[this.endpoint,feedbackId])).rows;
  return rows.map(row=>({id:row.id,name:row.name||'已移除的附件',mediaType:row.media_type,byteSize:Number(row.byte_size),sha256:row.sha256,
   state:this.state(row),expiresAt:row.expires_at??row.prepare_expires_at,url:null,
   availability:this.state(row)==='available'&&row.scan_result?.state==='clean'&&!row.purge_pending&&!!this.store&&!!this.scanner?'available':'unavailable'}));
 }
 async contentWithin(db,{feedbackId,attachmentId,assertReadable}){
  this.configured();if(!uuid.test(feedbackId)||!uuid.test(attachmentId)||typeof assertReadable!=='function')fail('feedback_attachment_unavailable',404);
  const current=async()=>{const feedback=await assertReadable(),row=await this.row(db,attachmentId);
   if(!row||row.feedback_id!==feedbackId||feedback?.id!==feedbackId||feedback.account_id!==row.account_id||feedback.submission_operation_id!==row.submission_operation_id
    ||row.purge_pending||this.state(row)!=='available'||row.scan_result?.state!=='clean')fail('feedback_attachment_content_unavailable',404);return row;};
  let row=await current();const bytes=await this.store.get({key:row.storage_key,keyId:row.encryption_key_id,size:Number(row.byte_size)});
  if(!bytes||bytes.length!==Number(row.byte_size)||hash(bytes)!==row.sha256)fail('attachment_storage_integrity_failed',502);
  row=await current();return {bytes,name:row.name,mediaType:row.media_type,sha256:row.sha256,attachmentId:row.id};
 }
 diagnostic(stage,row,error){try{this.logger({event:'attachment_processing_deferred',stage,resourceId:row.id,error:new ServiceError(error instanceof ServiceError?error.code:'attachment_processing_failed',503)});}catch{}}
 async scanPending({limit=1}={}){this.configured();if(!Number.isInteger(limit)||limit<1||limit>4)fail('invalid_attachment_scan_limit',400);let scanned=0;
  for(let index=0;index<limit;index++){
   const lease=randomUUID(),row=await transaction(this.db,async db=>{
    const row=(await db.query(`SELECT * FROM feedback_attachments_v1 WHERE endpoint=$1 AND state IN ('scan-pending','scanning') AND revoked_at IS NULL
     AND NOT purge_pending AND expires_at>$2 AND (lease_until IS NULL OR lease_until<=$2) ORDER BY uploaded_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[this.endpoint,stamp(this.now())])).rows[0];
    if(!row)return null;return(await db.query("UPDATE feedback_attachments_v1 SET state='scanning',lease_id=$2,lease_until=$3,scan_attempts=scan_attempts+1 WHERE id=$1 RETURNING *",[row.id,lease,stamp(this.now()+120)])).rows[0];
   });if(!row)break;
   try{
    const bytes=await this.store.get({key:row.storage_key,keyId:row.encryption_key_id,size:Number(row.byte_size)});if(!bytes||bytes.length!==Number(row.byte_size)||hash(bytes)!==row.sha256)fail('attachment_storage_integrity_failed',502);
    const scan=await this.scanner.scan(bytes);if(!['clean','blocked'].includes(scan?.state))fail('attachment_scan_incomplete',503);
    await transaction(this.db,async db=>{const current=await this.row(db,row.id,'UPDATE');if(!current||current.lease_id!==lease)return;
     const blocked=!!current.revoked_at||current.purge_pending||this.expired(current)||scan.state==='blocked';
     await db.query("UPDATE feedback_attachments_v1 SET state=$2,scan_result=$3,lease_id=NULL,lease_until=NULL,last_error=NULL,purge_pending=$4 WHERE id=$1",[row.id,blocked?'blocked':'available',JSON.stringify(scan),blocked]);});scanned++;
   }catch(error){this.diagnostic('feedback-attachment-scan',row,error);await this.db.query("UPDATE feedback_attachments_v1 SET state='scan-pending',lease_id=NULL,lease_until=$3,last_error=$4 WHERE id=$1 AND lease_id=$2",[row.id,lease,stamp(this.now()+60),error instanceof ServiceError?error.code:'attachment_scan_failed']);}
  }return {scanned};
 }
 // Expiry/revocation/quarantine stop reads immediately. There is deliberately
 // no automatic physical cleanup consumer here: a concrete website-file
 // cleanup plan needs the existing human confirmation before any object erase.
}
