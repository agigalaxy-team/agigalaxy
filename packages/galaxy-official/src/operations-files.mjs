import {z} from 'zod';
import {OperationsBusinessDomain,operationsParse,operationsFail,operationsIso} from './operations-content-visibility.mjs';
import {operationsFilesQuerySchema,operationsFileRetrySchema} from './shared/operations-business-schema.mjs';
import {fileProcessingVersion,fileRetryState} from './operations-file-processing.mjs';

export class OperationsFilesService extends OperationsBusinessDomain {
 constructor({businessAdmin,chatAttachments=null,forumAttachments=null,now}){super({businessAdmin,now});Object.assign(this,{chatAttachments,forumAttachments});}
 service(kind){if(!['chat','forum'].includes(kind))operationsFail('not_found',404);const service=kind==='chat'?this.chatAttachments:this.forumAttachments;if(!service)operationsFail('attachment_service_unavailable',503);return service;}
 async viewWithin(db,kind,row,actor){
  const service=this.service(kind),retry=fileRetryState(row,this.now()),state=kind==='chat'?service.status(row):service.state(row),
   used=Number((await db.query("SELECT count(*) AS n FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='file-retry' AND selection->>'kind'=$2 AND selection->>'id'=$3 AND created_at>$4",[this.endpoint,kind,row.id,new Date((this.now()-86400)*1000)])).rows[0].n);
  const authorUnavailable=retry.scan?await service.authorPending(db,row):false,processingAvailable=service.specification().supported;
  return {id:row.id,kind,state,processingState:row.state,version:fileProcessingVersion(row),size:Number(row.byte_size),
   ownerAccountId:row.account_id??(row.subject_id?.startsWith('account:')?row.subject_id.slice(8):null),
   originSubjectId:row.subject_id?.startsWith('account:')?null:row.subject_id??null,
   createdAt:operationsIso(row.created_at),uploadedAt:operationsIso(row.uploaded_at),expiresAt:operationsIso(row.expires_at??row.prepare_expires_at),
   scanAttempts:row.scan_attempts,scanState:['clean','blocked'].includes(row.scan_result?.state)?row.scan_result.state:null,
   cleanupPending:row.purge_pending,removedAt:operationsIso(row.purged_at),revokedAt:operationsIso(row.revoked_at),retryAfter:operationsIso(row.lease_until),
   lastError:typeof row.last_error==='string'&&/^attachment_[a-z0-9_]{1,70}$/.test(row.last_error)?row.last_error:null,
   activeLease:retry.activeLease,retriesRemaining:Math.max(0,3-used),processingAvailable,
   canRetryScan:actor.role==='administrator'&&processingAvailable&&used<3&&retry.scan&&!authorUnavailable,
   canRetryCleanup:actor.role==='administrator'&&processingAvailable&&used<3&&retry.cleanup,contentAvailable:false,checkedAt:this.now()};
 }
 list(operator,input={}){const q=operationsParse(operationsFilesQuerySchema,input);return this.run(operator,false,'files-query',q,async(db,actor)=>{
  const after=q.after?.split(':');const rows=(await db.query(`SELECT * FROM (
   SELECT id,'chat'::text AS kind,state,created_at,expires_at,prepare_expires_at,revoked_at,purged_at,purge_pending FROM chat_attachments
   UNION ALL SELECT id,'forum'::text AS kind,state,created_at,expires_at,prepare_expires_at,revoked_at,purged_at,purge_pending FROM forum_attachments_v1) files
   WHERE ($1::uuid IS NULL OR (id,kind)>($1::uuid,$7::text)) AND ($2::text IS NULL OR kind=$2)
   AND ($3::text IS NULL OR CASE WHEN purged_at IS NOT NULL THEN 'erased' WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN COALESCE(expires_at,prepare_expires_at)<=$6 THEN 'expired' ELSE state END=$3)
   AND ($4::text IS NULL OR $4='scan' AND state IN ('scan-pending','scanning') AND NOT purge_pending AND purged_at IS NULL OR $4='cleanup' AND purge_pending AND purged_at IS NULL)
   ORDER BY id,kind LIMIT $5`,[after?.[1]??null,q.kind??null,q.state??null,q.processing??null,q.limit+1,new Date(this.now()*1000),after?.[0]??null])).rows;
  const selected=rows.slice(0,q.limit),items=[];
  for(const row of selected)items.push(await this.viewWithin(db,row.kind,await this.service(row.kind).row(db,row.id),actor));
  return {items,nextAfter:rows.length>q.limit?selected.at(-1).kind+':'+selected.at(-1).id:null,checkedAt:this.now(),metadataOnly:true};
 });}
 get(operator,kind,id){operationsParse(z.uuid(),id);this.service(kind);return this.run(operator,false,'file-read',{kind,id},async(db,actor)=>{
  const row=await this.service(kind).row(db,id);if(!row)operationsFail('not_found',404);return this.viewWithin(db,kind,row,actor);
 });}
 retry(operator,kind,id,input){const x=operationsParse(operationsFileRetrySchema,input);operationsParse(z.uuid(),id);const service=this.service(kind);
  return this.command(operator,'file-retry',{kind,id,command:x,operationId:x.operationId},async(db,actor)=>{
   const row=await service.row(db,id,'UPDATE');if(!row)operationsFail('not_found',404);
   const current=await this.viewWithin(db,kind,row,actor);
   if(current.retriesRemaining===0)operationsFail('operations_file_retry_limit',429);
   await service.retryProcessingWithin(db,row,x);
   const file=await this.viewWithin(db,kind,await service.row(db,id),actor);file.retriesRemaining=Math.max(0,file.retriesRemaining-1);
   if(!file.retriesRemaining){file.canRetryScan=false;file.canRetryCleanup=false;}
   return {file,state:'scheduled',processingComplete:false};
  });
 }
}
