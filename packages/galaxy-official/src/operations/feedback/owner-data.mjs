import {randomUUID} from 'node:crypto';
import {transaction} from '../../database.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {accountFeedbackDataIntentSchema,accountFeedbackDataIdSchema,accountFeedbackDataPageSchema,parseAccountFeedbackData as parse} from '../../shared/account-feedback-data-schema.mjs';

const stamp=value=>new Date(value*1000).toISOString(),iso=value=>value==null?null:new Date(value).toISOString();
const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const knownErrors=new Set(['attachment_service_unavailable','attachment_storage_unavailable','attachment_storage_integrity_failed','attachment_encryption_key_unavailable','account_feedback_attachment_clear_unconfirmed']);

// The current official-account actor authorizes selection. A later worker only
// completes that exact recorded owner deletion; it never invents a human actor.
export class AccountFeedbackDataService {
 constructor({db,endpoint,accounts,feedbackAttachments,now=()=>Math.floor(Date.now()/1000),logger=()=>{}}){Object.assign(this,{db,endpoint,accounts,files:feedbackAttachments,now,logger});}
 owner(actor){if(actor?.kind!=='official-account'||actor.endpoint!==this.endpoint||!accountFeedbackDataIdSchema.safeParse(actor.accountId).success)fail('official_account_login_required',401);return actor.accountId;}
 run(actor,fn){const id=this.owner(actor);if(!this.accounts)fail('official_account_unavailable',503);
  return this.accounts.runAuthorized(actor,'binding',async(db,_authorization,current)=>{
   const account=await this.accounts.resolveWithin(db,current,{accountId:id,requireExplicit:true});return fn(db,account.id);
  },{control:true});}
 async lock(db,id){await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912395))',[this.endpoint+':feedback-intake:'+id]);}
 async row(db,accountId,operationId){return(await db.query('SELECT * FROM account_feedback_data_operations_v1 WHERE operation_id=$1 AND endpoint=$2 AND account_id=$3',[operationId,this.endpoint,accountId])).rows[0]??null;}
 async viewWithin(db,row,{replayed=false}={}){
  const counts=(await db.query(`SELECT count(*) FILTER(WHERE state IN('pending','removing'))::int AS pending,
   count(*) FILTER(WHERE state='removed')::int AS removed,count(*) FILTER(WHERE state='result-unknown')::int AS unknown
   FROM account_feedback_data_items_v1 WHERE operation_id=$1`,[row.operation_id])).rows[0];
  const now=this.now();return {state:'recorded',operationId:row.operation_id,kind:row.kind,phase:row.state,
   scope:'own-submitted-feedback-at-selection',feedbackCount:row.feedback_count,attachmentCount:row.attachment_count,
   metadataDeleted:row.metadata_deleted,attachments:{pending:counts.pending,removed:counts.removed,resultUnknown:counts.unknown,
    objectRemoved:row.attachment_count>0&&counts.removed===row.attachment_count?true:null,physicalBlocksReleased:null},
   recordedAt:iso(row.created_at),updatedAt:iso(row.updated_at),replayed,checkedAt:now,readExpiresAt:now+30};
 }
 async begin(actor,input,kind){const x=parse(accountFeedbackDataIntentSchema,input);
  return this.run(actor,async(db,id)=>{
   await this.lock(db,id);const prior=(await db.query('SELECT * FROM account_feedback_data_operations_v1 WHERE operation_id=$1',[x.operationId])).rows[0];
   if(prior){if(prior.endpoint!==this.endpoint||prior.account_id!==id||prior.kind!==kind)fail('account_feedback_operation_conflict');return this.viewWithin(db,prior,{replayed:true});}
   const selected=(await db.query(`SELECT coalesce(max(sequence),0)::text AS cutoff,count(*)::int AS count FROM operations_feedback_v1
    WHERE endpoint=$1 AND account_id=$2 AND owner_deleted_at IS NULL`,[this.endpoint,id])).rows[0];
   const files=(await db.query(`SELECT count(*)::int AS count FROM feedback_attachments_v1 a JOIN operations_feedback_v1 f
    ON f.id=a.feedback_id AND f.endpoint=a.endpoint AND f.account_id=a.account_id AND f.submission_operation_id=a.submission_operation_id
    WHERE f.endpoint=$1 AND f.account_id=$2 AND f.owner_deleted_at IS NULL AND f.sequence<=$3::bigint`,[this.endpoint,id,selected.cutoff])).rows[0];
   const at=stamp(this.now());await db.query(`INSERT INTO account_feedback_data_operations_v1(operation_id,endpoint,account_id,kind,cutoff_sequence,state,feedback_count,attachment_count,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,[x.operationId,this.endpoint,id,kind,selected.cutoff,kind==='export'?'ready':'pending',selected.count,files.count,at]);
   if(kind==='delete')await db.query('SELECT public.galaxy_account_erase_feedback_data($1,$2,$3)',[this.endpoint,id,x.operationId]);
   return this.viewWithin(db,await this.row(db,id,x.operationId));
  });
 }
 export(actor,input){return this.begin(actor,input,'export');}
 delete(actor,input){return this.begin(actor,input,'delete');}
 operation(actor,operationId){parse(accountFeedbackDataIdSchema,operationId);return this.run(actor,async(db,id)=>{
  const row=await this.row(db,id,operationId),now=this.now();return row?this.viewWithin(db,row):{state:'not-recorded',operationId,checkedAt:now,readExpiresAt:now+30};
 });}
 async exportRow(db,id,operationId){const row=await this.row(db,id,operationId);if(!row||row.kind!=='export')fail('not_found',404);return row;}
 exportPage(actor,operationId,input={}){parse(accountFeedbackDataIdSchema,operationId);const q=parse(accountFeedbackDataPageSchema,input);
  return this.run(actor,async(db,id)=>{
   const intent=await this.exportRow(db,id,operationId);if(BigInt(q.after??'0')>BigInt(intent.cutoff_sequence))fail('invalid_account_feedback_data_request',400);
   const rows=(await db.query(`SELECT f.id,f.sequence,f.title,f.body,f.submitted_category,f.submitted_module,f.created_at,f.owner_deleted_at
    FROM operations_feedback_v1 f WHERE f.endpoint=$1 AND f.account_id=$2 AND f.sequence>$3::bigint AND f.sequence<=$4::bigint
     AND (f.owner_deleted_at IS NULL OR EXISTS(SELECT 1 FROM account_feedback_data_operations_v1 d WHERE d.operation_id=f.owner_delete_operation_id AND d.sequence>$6::bigint))
    ORDER BY f.sequence LIMIT $5`,
   [this.endpoint,id,q.after??'0',intent.cutoff_sequence,q.limit+1,intent.sequence])).rows;
   const items=[];for(const row of rows.slice(0,q.limit)){
    if(row.owner_deleted_at){items.push({id:row.id,state:'deleted',submittedAt:iso(row.created_at),title:null,body:null,category:null,module:null,attachments:[]});continue;}
    const attachments=await this.files.forFeedbackWithin(db,row.id);
    items.push({id:row.id,state:'available',submittedAt:iso(row.created_at),title:row.title,body:row.body,category:row.submitted_category,module:row.submitted_module,
     attachments:attachments.map(file=>({id:file.id,name:file.name,mediaType:file.mediaType,byteSize:file.byteSize,sha256:file.sha256,state:file.state,
      availability:file.availability,expiresAt:iso(file.expiresAt),contentPath:file.availability==='available'?'/v1/account/data/feedback/exports/'+operationId+'/attachments/'+file.id+'/content':null}))});
   }
   const now=this.now();return {operationId,accountId:id,scope:'own-submitted-feedback-at-selection',items,
    nextAfter:rows.length>q.limit?String(rows[q.limit-1].sequence):null,selectedAt:iso(intent.created_at),checkedAt:now,readExpiresAt:now+30};
  });
 }
 async attachmentContent(actor,operationId,attachmentId,{authorize}={}){
  parse(accountFeedbackDataIdSchema,operationId);parse(accountFeedbackDataIdSchema,attachmentId);
  if(typeof authorize!=='function')fail('official_account_unavailable',503);
  const ownerId=this.owner(actor),before=await authorize();if(this.owner(before)!==ownerId)fail('official_account_changed',409);
  const result=await this.run(before,async(db,id)=>{
   const intent=await this.exportRow(db,id,operationId);
   const selected=(await db.query(`SELECT f.id FROM operations_feedback_v1 f JOIN feedback_attachments_v1 a
    ON a.feedback_id=f.id AND a.endpoint=f.endpoint AND a.account_id=f.account_id AND a.submission_operation_id=f.submission_operation_id
    WHERE a.id=$1 AND f.endpoint=$2 AND f.account_id=$3 AND f.sequence<=$4::bigint AND f.owner_deleted_at IS NULL`,[attachmentId,this.endpoint,id,intent.cutoff_sequence])).rows[0];
   if(!selected)fail('feedback_attachment_unavailable',404);
   return this.files.contentWithin(db,{feedbackId:selected.id,attachmentId,assertReadable:async()=>{
    await this.accounts.resolveWithin(db,before,{accountId:id,requireExplicit:true});
    const current=(await db.query('SELECT id,account_id,submission_operation_id FROM operations_feedback_v1 WHERE id=$1 AND endpoint=$2 AND account_id=$3 AND owner_deleted_at IS NULL',[selected.id,this.endpoint,id])).rows[0];
    if(!current)fail('feedback_attachment_content_unavailable',404);return current;
   }});
  });
  // Session reads use the official account store. Do not re-enter that global
  // store while a serialized/pinned source transaction is held.
  const after=await authorize();if(this.owner(after)!==ownerId)fail('official_account_changed',409);
  await this.run(after,async(db,id)=>{
   const intent=await this.exportRow(db,id,operationId),source=(await db.query(`SELECT f.id,f.submission_operation_id FROM operations_feedback_v1 f
    WHERE f.endpoint=$1 AND f.account_id=$2 AND f.sequence<=$3::bigint AND f.owner_deleted_at IS NULL
     AND EXISTS(SELECT 1 FROM feedback_attachments_v1 a WHERE a.id=$4 AND a.feedback_id=f.id AND a.account_id=f.account_id AND a.endpoint=f.endpoint AND a.submission_operation_id=f.submission_operation_id)`,[this.endpoint,id,intent.cutoff_sequence,attachmentId])).rows[0];
   const file=await this.files.row(db,attachmentId);
   if(!source||!file||file.feedback_id!==source.id||file.account_id!==id||file.submission_operation_id!==source.submission_operation_id
    ||file.purge_pending||this.files.state(file)!=='available'||file.scan_result?.state!=='clean'||file.sha256!==result.sha256||Number(file.byte_size)!==result.bytes.length)
    fail('feedback_attachment_content_unavailable',404);
  });
  return result;
 }
 async finishWithin(db,operationId){
  const counts=(await db.query(`SELECT count(*) FILTER(WHERE state IN('pending','removing') OR state='result-unknown' AND attempt_count<3)::int AS pending,
   count(*) FILTER(WHERE state='result-unknown')::int AS unknown FROM account_feedback_data_items_v1 WHERE operation_id=$1`,[operationId])).rows[0];
  await db.query("UPDATE account_feedback_data_operations_v1 SET state=$2,updated_at=$3 WHERE operation_id=$1 AND kind='delete'",[operationId,counts.pending?'pending':counts.unknown?'attention':'completed',stamp(this.now())]);
 }
 async processOwnerDeletions({limit=1}={}){
  if(!Number.isInteger(limit)||limit<1||limit>4)fail('invalid_account_feedback_data_request',400);let processed=0;
  for(let n=0;n<limit;n++){
   const claimed=await transaction(this.db,async db=>{
    const item=(await db.query(`SELECT i.* FROM account_feedback_data_items_v1 i JOIN account_feedback_data_operations_v1 o ON o.operation_id=i.operation_id
     WHERE o.endpoint=$1 AND o.kind='delete' AND o.metadata_deleted AND o.state IN('pending','attention')
      AND (i.state='pending' OR i.state IN('removing','result-unknown') AND i.next_attempt_at<=$2)
     ORDER BY o.created_at,i.attachment_id LIMIT 1 FOR UPDATE OF i SKIP LOCKED`,[this.endpoint,stamp(this.now())])).rows[0];
    if(!item)return null;const attempt=randomUUID(),verificationOnly=item.attempt_count>=3;
    await db.query("UPDATE account_feedback_data_items_v1 SET state='removing',attempt_count=attempt_count+$3,attempt_id=$4,attempted_at=$5,next_attempt_at=$6 WHERE operation_id=$1 AND attachment_id=$2",[item.operation_id,item.attachment_id,verificationOnly?0:1,attempt,stamp(this.now()),stamp(this.now()+120)]);
    return {operationId:item.operation_id,attachmentId:item.attachment_id,attempt,verificationOnly};
   });if(!claimed)break;
   try{await transaction(this.db,async db=>{
    const item=(await db.query('SELECT * FROM account_feedback_data_items_v1 WHERE operation_id=$1 AND attachment_id=$2 FOR UPDATE',[claimed.operationId,claimed.attachmentId])).rows[0];
    if(item?.state!=='removing'||item.attempt_id!==claimed.attempt)return;
    const source=(await db.query(`SELECT a.* FROM feedback_attachments_v1 a JOIN operations_feedback_v1 f
     ON f.id=a.feedback_id AND f.endpoint=a.endpoint AND f.account_id=a.account_id AND f.submission_operation_id=a.submission_operation_id
     JOIN account_feedback_data_operations_v1 o ON o.operation_id=f.owner_delete_operation_id AND o.account_id=f.account_id AND o.endpoint=f.endpoint
     WHERE a.id=$1 AND o.operation_id=$2 AND o.endpoint=$3 AND o.kind='delete' AND o.metadata_deleted
      AND f.owner_deleted_at IS NOT NULL AND f.sequence<=o.cutoff_sequence FOR UPDATE OF a`,[claimed.attachmentId,claimed.operationId,this.endpoint])).rows[0];
    if(!source)fail('account_feedback_delete_source_changed');
    const store=this.files?.store;if(typeof store?.head!=='function'||typeof store?.erase!=='function')fail('attachment_service_unavailable',503);
    const before=await store.head({key:source.storage_key,keyId:source.encryption_key_id});
    if(before&&(before.size!==Number(source.byte_size)||before.sha256!=null&&before.sha256!==source.sha256))fail('attachment_storage_integrity_failed',502);
    if(before){if(claimed.verificationOnly)fail('account_feedback_attachment_clear_unconfirmed',503);
     const result=await store.erase({key:source.storage_key});if(result?.objectRemoved!==true)fail('account_feedback_attachment_clear_unconfirmed',503);
     if(await store.head({key:source.storage_key,keyId:source.encryption_key_id}))fail('account_feedback_attachment_clear_unconfirmed',503);
    }
    const at=stamp(this.now());await db.query("UPDATE feedback_attachments_v1 SET state='erased',name='',media_type='',scan_result=NULL,purge_pending=false,purged_at=COALESCE(purged_at,$2),lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1",[source.id,at]);
    await db.query("UPDATE account_feedback_data_items_v1 SET state='removed',object_removed=true,result_code=$3,completed_at=$4,next_attempt_at=NULL WHERE operation_id=$1 AND attachment_id=$2",[claimed.operationId,source.id,before?'object-removed':'object-already-absent',at]);
    await this.finishWithin(db,claimed.operationId);
   });}catch(error){
    const code=knownErrors.has(error?.code)?error.code:'account_feedback_attachment_clear_unconfirmed';
    try{this.logger({event:'attachment_processing_deferred',stage:'feedback-owner-deletion',resourceId:claimed.operationId,error:new ServiceError(code,503)});}catch{}
    await transaction(this.db,async db=>{await db.query("UPDATE account_feedback_data_items_v1 SET state='result-unknown',object_removed=NULL,result_code=$4,next_attempt_at=$5 WHERE operation_id=$1 AND attachment_id=$2 AND attempt_id=$3 AND state='removing'",[claimed.operationId,claimed.attachmentId,claimed.attempt,code,stamp(this.now()+(claimed.verificationOnly?300:30))]);await this.finishWithin(db,claimed.operationId);});
   }processed++;
  }
  return {processed,physicalBlocksReleased:null};
 }
}
