import {z} from 'zod';
import canonicalize from 'canonicalize';
import {randomUUID} from 'node:crypto';
import {digest} from "../shared/digest.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {accountWorkPutSchema,accountWorkKeySchema,accountWorkListSchema,parseAccountWorkInput} from "../shared/account-work-schema.mjs";

const stamp = value => value instanceof Date?value.toISOString():value;
const json = value => typeof value==='string'?JSON.parse(value):value;
const identity = value => typeof value==='string'&&/^GUID[0-9A-Z]{28}$/.test(value);

/** Private projections of selected local work. An association chooses a possible
 * destination; it neither invents an origin nor grants another ID's material. */
export class AccountWorkService {
 constructor(access,{accounts}={}){
  if(!accounts)throw new Error('AccountWorkService requires the current account registry');
  this.access=access;this.accounts=accounts;
 }
 actor(actor,{put=false}={}){
  if(!actor||!z.uuid().safeParse(actor.accountId).success)throw new ServiceError('account_selection_required',409);
  if(actor.kind==='official-account'){
   if(put||actor.endpoint!==this.access.endpoint)throw new ServiceError('access_denied',401);
  }else if(!identity(actor.subjectId))throw new ServiceError('access_denied',401);
  return actor;
 }
 run(actor,operation,{write=false,put=false}={}){
  this.actor(actor,{put});
  return this.accounts.runAuthorized(actor,'binding',async(db,_authorization,currentActor)=>{
   // This takes the same controller-mapping lock as revocation and checks the
   // exact selected target again inside the active credential transaction.
   const account=await this.accounts.resolveWithin(db,currentActor,{accountId:actor.accountId,requireExplicit:true,lock:write});
   return operation(db,{...currentActor,accountId:account.id});
  },{resourceWrite:put,control:write&&!put});
 }
 async head(db,actor,workId,{lock=false}={}){
  const row=(await db.query('SELECT * FROM account_work_v1 WHERE account_id=$1 AND work_id=$2'+(lock?' FOR UPDATE':''),[actor.accountId,workId])).rows[0];
  // The website owner can manage every origin. A linked ID can only manage
  // its own selected work, even when other IDs share the same online account.
  return row&&(actor.kind==='official-account'||row.origin_subject_id===actor.subjectId)?row:null;
 }
 absent(actor,workId){return {accountId:actor.accountId,workId,state:'absent',revision:0,scopeId:null,lastOperationId:null,audience:'owner-only'};}
 view(row,{includeData=false,includePreview=false}={}){
  const data=row.data===null?null:json(row.data);
  return {accountId:row.account_id,workId:row.work_id,originSubjectId:row.origin_subject_id,scopeId:row.scope_id,
   state:row.state,revision:Number(row.revision),lastOperationId:row.last_operation_id,uploadLevel:row.upload_level,
   ...(data?.startedAt?{startedAt:data.startedAt}:{}),...(data?.updatedAt?{updatedAt:data.updatedAt}:{}),
   storedAt:stamp(row.updated_at),audience:'owner-only',
   ...(includePreview&&data?{workType:data.workType,role:data.role,sourceHost:data.source?.host,resultStatus:data.resultStatus}:{}),
   ...(includePreview&&row.state==='stored'&&['work-content','conversation-archive'].includes(row.upload_level)&&data?.summary?
    {title:data.summary.title,preview:data.summary.summary.slice(0,240)}:{}),
   ...(row.state==='deleted'?{deletedAt:stamp(row.deleted_at),deletedReason:'owner-deleted'}:{}),
   ...(includeData?{data}:{}),completeConversation:false};
 }
 put(actor,input){
  const p=parseAccountWorkInput(accountWorkPutSchema,input);
  this.actor(actor,{put:true});
  if(p.data.galaxyId!==actor.subjectId)throw new ServiceError('account_work_source_mismatch',403);
  const requestHash=digest(canonicalize(p));
  return this.run(actor,async(db,current)=>{
   const existing=(await db.query('SELECT * FROM account_work_v1 WHERE account_id=$1 AND work_id=$2 FOR UPDATE',[current.accountId,p.workId])).rows[0];
   if(existing&&existing.origin_subject_id!==current.subjectId)throw new ServiceError('account_work_source_mismatch',403);
   const scope=(await db.query('SELECT * FROM account_work_scopes_v1 WHERE account_id=$1 AND scope_id=$2',[current.accountId,p.scopeId])).rows[0];
   if(scope&&(scope.origin_subject_id!==current.subjectId||scope.work_id!==p.workId))throw new ServiceError('account_work_scope_mismatch',409);
   const prior=(await db.query('SELECT * FROM account_work_operations_v1 WHERE account_id=$1 AND operation_id=$2',[current.accountId,p.operationId])).rows[0];
   if(prior&&(prior.origin_subject_id!==current.subjectId||prior.request_hash!==requestHash))throw new ServiceError('account_work_operation_conflict',409);
   // Owner deletion wins even over a retry whose original ACK was lost. The
   // scope tombstone survives a later explicit re-selection with a new scope.
   if(scope?.deleted_at)throw new ServiceError('account_work_owner_deleted',410);
   if(prior)return {...json(prior.receipt),duplicate:true};
   if(scope&&existing?.scope_id!==p.scopeId)throw new ServiceError('account_work_scope_changed',409);
   if(Number(existing?.revision??0)!==p.expectedRevision)throw new ServiceError('account_work_revision_conflict',409);
   if(existing?.state==='deleted'&&existing.scope_id===p.scopeId)throw new ServiceError('account_work_owner_deleted',410);
   const at=new Date(this.access.now()*1000).toISOString();
   if(!scope)await db.query(`INSERT INTO account_work_scopes_v1(account_id,scope_id,work_id,origin_subject_id,created_at)
    VALUES($1,$2,$3,$4,$5)`,[current.accountId,p.scopeId,p.workId,current.subjectId,at]);
   const row=(await db.query(`INSERT INTO account_work_v1(account_id,work_id,origin_subject_id,scope_id,revision,state,upload_level,data,last_operation_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'stored',$6,$7::jsonb,$8,$9,$9)
    ON CONFLICT(account_id,work_id) DO UPDATE SET scope_id=EXCLUDED.scope_id,revision=EXCLUDED.revision,state='stored',
     upload_level=EXCLUDED.upload_level,data=EXCLUDED.data,last_operation_id=EXCLUDED.last_operation_id,updated_at=EXCLUDED.updated_at,deleted_at=NULL
    RETURNING *`,[current.accountId,p.workId,current.subjectId,p.scopeId,p.revision,p.data.uploadLevel,JSON.stringify(p.data),p.operationId,at])).rows[0];
   const receipt={...this.view(row),operationId:p.operationId,acceptedRevision:p.revision,duplicate:false};
   // Runtime idempotency retains only the content digest and an attribution
   // receipt, so deleting a work really removes its uploaded prose and material.
   await db.query(`INSERT INTO account_work_operations_v1(account_id,operation_id,work_id,scope_id,origin_subject_id,request_hash,receipt,created_at,
    origin_binding_id,origin_device_id,origin_key_id,http_request_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
   [current.accountId,p.operationId,p.workId,p.scopeId,current.subjectId,requestHash,JSON.stringify(receipt),at,
    current.bindingId,current.deviceId??null,current.keyId??null,current.httpRequestId??null]);
   return receipt;
  },{write:true,put:true});
 }
 status(actor,input){
  const p=parseAccountWorkInput(accountWorkKeySchema,input);
  return this.run(actor,async(db,current)=>{const row=await this.head(db,current,p.workId);return row?this.view(row):this.absent(current,p.workId);});
 }
 get(actor,input){
  const p=parseAccountWorkInput(accountWorkKeySchema,input);
  return this.run(actor,async(db,current)=>{const row=await this.head(db,current,p.workId);return row?this.view(row,{includeData:true}):{...this.absent(current,p.workId),data:null};});
 }
 list(actor,input={}){
  const p=parseAccountWorkInput(accountWorkListSchema,input);
  return this.run(actor,async(db,current)=>{
   const rows=(await db.query(`SELECT * FROM account_work_v1 WHERE account_id=$1 AND state='stored'
    AND ($2::text IS NULL OR origin_subject_id=$2) AND ($3::text IS NULL OR work_id>$3) ORDER BY work_id LIMIT $4`,
   [current.accountId,current.kind==='official-account'?null:current.subjectId,p.after??null,p.limit+1])).rows;
   return {accountId:current.accountId,items:rows.slice(0,p.limit).map(row=>this.view(row,{includePreview:true})),nextAfter:rows.length>p.limit?rows[p.limit-1].work_id:null,audience:'owner-only'};
  });
 }
 delete(actor,input){
  const p=parseAccountWorkInput(accountWorkKeySchema,input);
  return this.run(actor,async(db,current)=>{
   const row=await this.head(db,current,p.workId,{lock:true});
   if(!row)return {...this.absent(current,p.workId),localOriginalsAffected:false};
   if(row.state==='deleted')return {...this.view(row),localOriginalsAffected:false};
   const at=new Date(this.access.now()*1000).toISOString();
   await db.query(`UPDATE account_work_scopes_v1 SET deleted_at=$3,deleted_reason='owner-deleted',deleted_by_kind=$4,
    deleted_by_subject_id=$5,deleted_request_id=$6 WHERE account_id=$1 AND work_id=$2 AND deleted_at IS NULL`,
   [current.accountId,p.workId,at,current.kind==='official-account'?'official-account':'identity',
    current.kind==='official-account'?null:current.subjectId,current.httpRequestId??randomUUID()]);
   const deleted=(await db.query(`UPDATE account_work_v1 SET state='deleted',revision=revision+1,data=NULL,deleted_at=$3,updated_at=$3
    WHERE account_id=$1 AND work_id=$2 RETURNING *`,[current.accountId,p.workId,at])).rows[0];
   return {...this.view(deleted),localOriginalsAffected:false};
  },{write:true});
 }
}
