import {z} from 'zod';
import {hasOperationsPermission as permitted} from '../../operations-permission-catalog.mjs';
import {OperationsBusinessDomain,operationsParse,operationsFail,operationsIso} from "../public-content/content-visibility.mjs";
import {operationsFilesQuerySchema,operationsFilesSummaryQuerySchema} from '../../shared/operations-business-schema.mjs';
import {fileProcessingVersion,fileRetryState,fileProcessingFacts} from './processing.mjs';
import {operationsOperatorNamesWithin} from "../accounts/history-identities.mjs";
import {fileAccessWithin,fileAccessRestorationWithin} from './access-gate.mjs';

const safeSize=value=>{const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null;};
const safeName=value=>typeof value==='string'?value.replace(/[\p{Cc}]/gu,' ').trim().slice(0,180)||null:null;
const safeError=value=>typeof value==='string'&&/^attachment_[a-z0-9_]{1,70}$/.test(value)?value:null;
const filters=q=>({kind:q.kind??null,state:q.state??null,processing:q.processing??null,issue:q.issue??null});

// Only lifecycle metadata is projected. Account rows remain endpoint-scoped;
// Native rows belong to this configured business database, as in the old API.
// No room/message IDs, source text, URLs or storage/encryption keys are read.
const fileCte=`WITH raw_files AS (
 SELECT a.id,'chat'::text AS kind,a.name,a.state,a.created_at,a.uploaded_at,a.expires_at,a.prepare_expires_at,a.revoked_at,a.purged_at,a.purge_pending,
  a.byte_size,a.subject_id,NULL::uuid AS account_id,a.scan_attempts,a.scan_result,a.lease_id,a.lease_until,a.last_error,a.operations_retry_revision
 FROM chat_attachments a WHERE a.subject_id NOT LIKE 'account:%' OR EXISTS(SELECT 1 FROM community_accounts o WHERE 'account:'||o.id::text=a.subject_id AND o.endpoint=$1)
 UNION ALL
 SELECT a.id,'forum'::text AS kind,a.name,a.state,a.created_at,a.uploaded_at,a.expires_at,a.prepare_expires_at,a.revoked_at,a.purged_at,a.purge_pending,
  a.byte_size,a.subject_id,a.account_id,a.scan_attempts,a.scan_result,a.lease_id,a.lease_until,a.last_error,a.operations_retry_revision
 FROM forum_attachments_v1 a JOIN community_accounts o ON o.id=a.account_id AND o.endpoint=$1
), files AS (
 SELECT *,CASE WHEN purged_at IS NOT NULL THEN 'erased' WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN COALESCE(expires_at,prepare_expires_at)<=$6 THEN 'expired' ELSE state END AS effective_state,
  purged_at IS NULL AND (purge_pending OR revoked_at IS NOT NULL OR COALESCE(expires_at,prepare_expires_at)<=$6) AS needs_cleanup,
  purged_at IS NULL AND purge_pending AND last_error='attachment_cleanup_failed' AS cleanup_unknown,
  purged_at IS NULL AND state IN ('scan-pending','scanning') AND scan_attempts>0 AND last_error IS NOT NULL AND last_error<>'attachment_cleanup_failed' AS scan_failed
 FROM raw_files
), selected_files AS (
 SELECT * FROM files WHERE ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR effective_state=$3)
 AND ($4::text IS NULL OR $4='scan' AND state IN ('scan-pending','scanning') AND NOT purge_pending AND purged_at IS NULL OR $4='cleanup' AND needs_cleanup)
 AND ($5::text IS NULL OR $5='scan' AND scan_failed OR $5='cleanup' AND cleanup_unknown OR $5='any' AND purged_at IS NULL AND last_error IS NOT NULL)
)`;

export class OperationsFilesReadModel extends OperationsBusinessDomain {
 constructor({businessAdmin,chatAttachments=null,forumAttachments=null,now}){super({businessAdmin,now});Object.assign(this,{chatAttachments,forumAttachments});}
 service(kind,{required=true}={}){if(!['chat','forum'].includes(kind))operationsFail('not_found',404);const service=kind==='chat'?this.chatAttachments:this.forumAttachments;if(required&&!service)operationsFail('attachment_service_unavailable',503);return service;}
 queryValues(q){return[this.endpoint,q.kind??null,q.state??null,q.processing??null,q.issue??null,new Date(this.now()*1000)];}
 async scopedRowWithin(db,kind,id,{write=false}={}){
  this.service(kind,{required:false});const table=kind==='chat'?'chat_attachments':'forum_attachments_v1',row=(await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR ${write?'UPDATE':'SHARE'}`,[id])).rows[0];
  if(!row)operationsFail('not_found',404);
  const accountId=kind==='forum'?row.account_id:row.subject_id?.startsWith('account:')?row.subject_id.slice(8):null;
  if(accountId&&!(await db.query('SELECT 1 FROM community_accounts WHERE id::text=$1 AND endpoint=$2',[accountId,this.endpoint])).rows.length)operationsFail('not_found',404);
  return row;
 }
 async historyWithin(db,kind,row){
  const history=[],add=(kind,at,extra={})=>{if(at)history.push({kind,at:operationsIso(at),...extra});};
  add('prepared',row.created_at);add('upload-started',row.uploaded_at);add('revoked',row.revoked_at);add('object-removal-recorded',row.purged_at);
  if(typeof row.scan_result?.checkedAt==='number'&&Number.isFinite(row.scan_result.checkedAt)&&row.scan_result.checkedAt>0&&['clean','blocked'].includes(row.scan_result.state))
   add('scan-result',row.scan_result.checkedAt*1000,{scanState:row.scan_result.state});
  const events=(await db.query(`SELECT operation_id,operator_id,created_at,selection->'command'->>'kind' AS retry_kind FROM business_admin_audit_v1
   WHERE endpoint=$1 AND action='file-retry' AND selection->>'kind'=$2 AND selection->>'id'=$3 ORDER BY sequence DESC LIMIT 21`,[this.endpoint,kind,row.id])).rows;
  const names=await operationsOperatorNamesWithin(db,{endpoint:this.endpoint,operatorIds:events.map(event=>event.operator_id)});
  for(const event of events.slice(0,20))if(['scan','cleanup'].includes(event.retry_kind))add(event.retry_kind+'-retry',event.created_at,{operationId:event.operation_id,operatorId:event.operator_id,operatorDisplayName:names.get(event.operator_id)??null});
   const accessEvents=(await db.query(`SELECT action,created_at,operation_id,operator_id,stopped_until,reason FROM operations_file_access_events_v1
    WHERE endpoint=$1 AND kind=$2 AND file_id=$3 ORDER BY revision DESC LIMIT 21`,[this.endpoint,kind,row.id])).rows;
   const accessNames=await operationsOperatorNamesWithin(db,{endpoint:this.endpoint,operatorIds:accessEvents.map(event=>event.operator_id)});
   for(const event of accessEvents.slice(0,20))add('access-'+event.action,event.created_at,{operationId:event.operation_id,operatorId:event.operator_id,operatorDisplayName:accessNames.get(event.operator_id)??null,
    until:event.stopped_until?Math.floor(new Date(event.stopped_until).getTime()/1000):null,reason:event.reason});
   return{items:history.sort((a,b)=>a.at.localeCompare(b.at)),truncated:events.length>20||accessEvents.length>20,fullProcessingHistoryAvailable:false};
 }
 async viewWithin(db,kind,row,actor,{detail=false}={}){
  const service=this.service(kind,{required:false}),retry=fileRetryState(row,this.now()),facts=fileProcessingFacts(row,this.now()),
   used=Number((await db.query("SELECT count(*) AS n FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='file-retry' AND selection->>'kind'=$2 AND selection->>'id'=$3 AND created_at>$4",[this.endpoint,kind,row.id,new Date((this.now()-86400)*1000)])).rows[0].n);
  const processingAvailable=!!service?.specification().supported,authorUnavailable=retry.scan&&service?await service.authorPending(db,row):false,version=fileProcessingVersion(row);
   const access=await fileAccessWithin(db,{endpoint:this.endpoint,kind,id:row.id,now:this.now(),detail:true}),
    names=await operationsOperatorNamesWithin(db,{endpoint:this.endpoint,operatorIds:access.operatorId?[access.operatorId]:[]}),
    restoreBlockedReason=access.stopped?await fileAccessRestorationWithin(db,{kind,row,service,now:this.now()}):null,
    stoppable=!row.purged_at&&!row.revoked_at&&!row.purge_pending&&!facts.expired&&!await service?.authorPending(db,row),human=actor.kind==='business-operator'||this.businessAdmin.executorAuthority?.acceptsDuty(actor)===true;
  return{id:row.id,kind,name:safeName(row.name),scope:'existing-managed-file',state:facts.state,processingState:row.state,version,processingVersion:version,size:safeSize(row.byte_size),
   ownerAccountId:row.account_id??(row.subject_id?.startsWith('account:')?row.subject_id.slice(8):null),originSubjectId:row.subject_id?.startsWith('account:')?null:row.subject_id??null,
   createdAt:operationsIso(row.created_at),uploadedAt:operationsIso(row.uploaded_at),expiresAt:operationsIso(row.expires_at??row.prepare_expires_at),
   scanAttempts:row.scan_attempts,scanState:['clean','blocked'].includes(row.scan_result?.state)?row.scan_result.state:null,
   cleanupPending:row.purge_pending,removedAt:operationsIso(row.purged_at),revokedAt:operationsIso(row.revoked_at),retryAfter:operationsIso(row.lease_until),
   lastError:safeError(row.last_error),activeLease:retry.activeLease,retriesRemaining:Math.max(0,3-used),processingAvailable,
   canRetryScan:permitted(actor,'files.scan.retry')&&processingAvailable&&used<3&&retry.scan&&!authorUnavailable,canRetryCleanup:false,
   accounting:{reservedBytes:row.purged_at?0:safeSize(row.byte_size),actualStoredBytes:null},scan:facts.scan,cleanup:facts.cleanup,
    access:{...access,operatorDisplayName:names.get(access.operatorId)??null,canStop:human&&permitted(actor,'files.access.stop')&&stoppable&&!access.stopped,
     canRestore:human&&permitted(actor,'files.access.restore')&&access.stopped&&!restoreBlockedReason,restoreBlockedReason},
    ...(detail?{history:await this.historyWithin(db,kind,row)}:{}),contentAvailable:false,checkedAt:this.now(),readExpiresAt:access.stopped?Math.min(this.now()+30,access.until):this.now()+30};
 }
 policy(){
  const limits=service=>({processingAvailable:!!service?.specification().supported,maxFileBytes:service?.policy.maxFileBytes??null,maxSubjectBytes:service?.policy.maxSubjectBytes??null,maxGlobalBytes:service?.policy.maxGlobalBytes??null});
  return{relay:{state:'not-configured',enabled:false,ttlSeconds:null,startsAt:null,maxFileBytes:null,maxCacheBytes:null,automaticExpiryCleanupEnabled:false},
   existing:{chat:{...limits(this.chatAttachments),retentionDays:30,startsAt:'first-upload-start'},forum:{...limits(this.forumAttachments),retention:'source-bound'}},
   cleanup:{legacyWorker:'owner-and-safety-only',manualPlanRequired:true,executionObservation:'per-plan',physicalBlocksReleased:null}};
 }
 list(operator,input={}){const q=operationsParse(operationsFilesQuerySchema,input);return this.run(operator,false,'files-query',{...q,view:'list'},async(db,actor)=>{
  const after=q.after?.split(':'),rows=(await db.query(fileCte+` SELECT * FROM selected_files WHERE ($7::uuid IS NULL OR (id,kind)>($7::uuid,$8::text)) ORDER BY id,kind LIMIT $9`,
   [...this.queryValues(q),after?.[1]??null,after?.[0]??null,q.limit+1])).rows,selected=rows.slice(0,q.limit),items=[];
  for(const row of selected)items.push(await this.viewWithin(db,row.kind,row,actor));
  return{items,nextAfter:rows.length>q.limit?selected.at(-1).kind+':'+selected.at(-1).id:null,checkedAt:this.now(),readExpiresAt:this.now()+30,metadataOnly:true};
 });}
 summary(operator,input={}){const q=operationsParse(operationsFilesSummaryQuerySchema,input);return this.run(operator,false,'files-query',{...q,view:'summary'},async db=>{
  const aggregates=(await db.query(fileCte+` SELECT kind,GROUPING(kind) AS all_kinds,count(*)::text AS records,COALESCE(sum(byte_size) FILTER(WHERE purged_at IS NULL),0)::text AS reserved_bytes,
    count(*) FILTER(WHERE effective_state='available' AND NOT purge_pending AND NOT EXISTS(SELECT 1 FROM operations_file_access_heads_v1 h
     WHERE h.endpoint=$1 AND h.kind=selected_files.kind AND h.file_id=selected_files.id AND h.stopped_until>$6))::text AS ready_files,
   count(*) FILTER(WHERE state IN ('scan-pending','scanning') AND effective_state NOT IN ('expired','revoked','erased') AND NOT purge_pending)::text AS pending_scan,
   count(*) FILTER(WHERE scan_failed)::text AS scan_failed,count(*) FILTER(WHERE effective_state='expired')::text AS expired,
   count(*) FILTER(WHERE effective_state='revoked')::text AS revoked,count(*) FILTER(WHERE purged_at IS NOT NULL)::text AS removed,
   count(*) FILTER(WHERE needs_cleanup AND NOT COALESCE(cleanup_unknown,false))::text AS cleanup_pending,
   count(*) FILTER(WHERE cleanup_unknown)::text AS cleanup_unknown FROM selected_files GROUP BY GROUPING SETS((),(kind))`,this.queryValues(q))).rows,
   row=aggregates.find(row=>row.all_kinds===1),groups=aggregates.filter(row=>row.all_kinds===0);
  return{checkedAt:this.now(),readExpiresAt:this.now()+30,metadataOnly:true,scope:'configured-business-database',filters:filters(q),
   totals:{records:Number(row.records),reservedBytes:safeSize(row.reserved_bytes),actualStoredBytes:null,readyFiles:Number(row.ready_files),pendingScan:Number(row.pending_scan),scanFailed:Number(row.scan_failed),
    expired:Number(row.expired),revoked:Number(row.revoked),removed:Number(row.removed),cleanupPending:Number(row.cleanup_pending),cleanupResultUnknown:Number(row.cleanup_unknown),cleanupRunning:null,cleanupFailed:null},
   byKind:['chat','forum'].map(kind=>{const group=groups.find(row=>row.kind===kind);return{kind,records:Number(group?.records??0),reservedBytes:safeSize(group?.reserved_bytes??0)};}),policy:this.policy()};
 });}
 get(operator,kind,id){operationsParse(z.uuid(),id);this.service(kind,{required:false});return this.run(operator,false,'file-read',{kind,id},async(db,actor)=>this.viewWithin(db,kind,await this.scopedRowWithin(db,kind,id),actor,{detail:true}));}
}
