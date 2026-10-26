import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from '../../shared/service-error.mjs';
import {operationsParse as parse,operationsFail as fail,operationsIso as iso} from "../public-content/content-visibility.mjs";
import {hasOperationsPermission as permitted} from '../../operations-permission-catalog.mjs';
import {operationsOperatorNamesWithin} from "../accounts/history-identities.mjs";
import {operationsFileCleanupCandidatesSchema,operationsFileCleanupPlansSchema,operationsFileCleanupCreateSchema,operationsFileCleanupDecisionSchema} from '../../shared/operations-file-cleanup-schema.mjs';
import {OperationsFilesReadModel} from './read-model.mjs';
import {fileProcessingVersion} from './processing.mjs';
import {fileCleanupTable,fileCleanupSourceWithin,fileCleanupEligibility} from './cleanup-eligibility.mjs';

const stamp=now=>new Date(now*1000).toISOString();
// eslint-disable-next-line no-control-regex -- Deliberately reject or sanitize ASCII control characters.
const safeName=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,180)||null:null;
const total=values=>{const sum=values.reduce((value,next)=>value+Number(next),0);return Number.isSafeInteger(sum)?sum:null;};
const readMeta=now=>({checkedAt:now,readExpiresAt:now+30,metadataOnly:true});
const workerCode=error=>error instanceof ServiceError&&/^[a-z][a-z0-9_]{0,100}$/.test(error.code)?error.code:'operations_file_cleanup_unavailable';

export class OperationsFileCleanupService extends OperationsFilesReadModel{
 constructor({logger=()=>{},...options}){super(options);this.logger=logger;}
 human(operator){const actor=this.require(operator,true);if(actor.kind!=='business-operator')fail('operations_permission_denied',403);return actor;}
 async fresh(actor,action,authorize,db=this.db){
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  const current=this.human(await authorize({db}));if(current.operatorId!==actor.operatorId||current.endpoint!==this.endpoint)fail('business_admin_denied',403);
  return this.businessAdmin.authorizeAction(current,action,{db});
 }
 caps(actor){return{canCreate:permitted(actor,'files.cleanup.plan'),canApprove:permitted(actor,'files.cleanup.approve'),canCancel:permitted(actor,'files.cleanup.plan')};}
 async facts(db,kind,row,{lock=false,planId=null}={}){
  if(planId)await db.query('SELECT public.galaxy_worker_lock_file_cleanup_sources($1,$2,$3,$4)',[this.endpoint,planId,kind,row.id]);
  const source=await fileCleanupSourceWithin(db,{kind,row,now:this.now(),lock}),eligibility=fileCleanupEligibility(row,source,this.now());
  return{source,eligibility};
 }
 candidate(kind,row,facts){const store=this.service(kind,{required:false})?.store,storageAvailable=typeof store?.head==='function'&&typeof store?.erase==='function';
  return{kind,id:row.id,name:safeName(row.name),size:Number(row.byte_size),expectedVersion:fileProcessingVersion(row),expiresAt:iso(row.expires_at??row.prepare_expires_at),
   reason:facts.eligibility.reason,referenceCount:facts.source.references.length,activeReferences:facts.source.activeReferences,
   eligible:facts.eligibility.eligible&&storageAvailable,blockedReason:facts.eligibility.blockedReason??(!storageAvailable?'storage-unavailable':null)};
 }
 candidates(operator,input={}){
  const q=parse(operationsFileCleanupCandidatesSchema,input);return this.run(operator,false,'file-cleanup-read',{view:'candidates',...q},async(db,actor)=>{
   const after=q.after?.split(':'),rows=(await db.query(`WITH files AS(
    SELECT a.id,'chat'::text AS kind FROM chat_attachments a WHERE a.purged_at IS NULL
     AND (a.subject_id NOT LIKE 'account:%' OR EXISTS(SELECT 1 FROM community_accounts o WHERE 'account:'||o.id::text=a.subject_id AND o.endpoint=$1))
     AND (a.purge_pending OR COALESCE(a.expires_at,a.prepare_expires_at)<=$2)
    UNION ALL SELECT a.id,'forum'::text AS kind FROM forum_attachments_v1 a JOIN community_accounts o ON o.id=a.account_id AND o.endpoint=$1 WHERE a.purged_at IS NULL
     AND (a.purge_pending OR COALESCE(a.expires_at,a.prepare_expires_at)<=$2 OR a.published_at IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM forum_attachment_links_v1 l JOIN forum_posts_v1 p ON p.id=l.post_id JOIN forum_versions_v1 v ON v.id=l.version_id LEFT JOIN forum_replies_v1 r ON r.id=l.reply_id
      WHERE l.attachment_id=a.id AND l.published_until>$2 AND p.state='published' AND v.state='published' AND (l.reply_id IS NULL OR r.state='published'))))
    SELECT * FROM files WHERE ($3::text IS NULL OR kind=$3) AND ($4::uuid IS NULL OR (id,kind)>($4::uuid,$5::text)) ORDER BY id,kind LIMIT $6`,
   [this.endpoint,stamp(this.now()),q.kind??null,after?.[1]??null,after?.[0]??null,q.limit+1])).rows,selected=rows.slice(0,q.limit),items=[];
   for(const value of selected){const row=await this.scopedRowWithin(db,value.kind,value.id),facts=await this.facts(db,value.kind,row);if(facts.eligibility.category==='operational')items.push(this.candidate(value.kind,row,facts));}
   return{items,nextAfter:rows.length>q.limit?selected.at(-1).kind+':'+selected.at(-1).id:null,permissions:this.caps(actor),...readMeta(this.now())};
  });
 }
 async planRow(db,id,{write=false}={}){parse(z.uuid(),id);const row=(await db.query(`SELECT * FROM operations_file_cleanup_plans_v1 WHERE endpoint=$1 AND id=$2 FOR ${write?'UPDATE':'SHARE'}`,[this.endpoint,id])).rows[0];if(!row)fail('operations_file_cleanup_plan_not_found',404);return row;}
 async planView(db,row,actor,{items=true}={}){
  const names=await operationsOperatorNamesWithin(db,{endpoint:this.endpoint,operatorIds:[row.created_by,row.approved_by,row.cancelled_by].filter(Boolean)});
  const counts=(await db.query('SELECT state,count(*)::integer AS n FROM operations_file_cleanup_items_v1 WHERE plan_id=$1 GROUP BY state',[row.id])).rows;
  const result={id:row.id,revision:row.revision,state:row.state,createdAt:iso(row.created_at),createdBy:{operatorId:row.created_by,displayName:names.get(row.created_by)??null},
   approvedAt:iso(row.approved_at),approvedBy:row.approved_by?{operatorId:row.approved_by,displayName:names.get(row.approved_by)??null}:null,
   cancelledAt:iso(row.cancelled_at),completedAt:iso(row.completed_at),reason:row.reason,itemCount:row.item_count,declaredBytes:Number(row.declared_bytes),
   counts:Object.fromEntries(['pending','removing','removed','skipped','result-unknown'].map(state=>[state,counts.find(value=>value.state===state)?.n??0])),
   permissions:{canApprove:row.state==='awaiting-approval'&&this.caps(actor).canApprove,canCancel:['awaiting-approval','queued','running','attention'].includes(row.state)&&this.caps(actor).canCancel},
   impact:{serverCopyRemoval:true,restorationAvailable:false,physicalBlocksReleased:null},...readMeta(this.now())};
  if(items){result.items=[];for(const item of (await db.query('SELECT * FROM operations_file_cleanup_items_v1 WHERE plan_id=$1 ORDER BY position',[row.id])).rows){
   let current=null;try{current=await this.scopedRowWithin(db,item.kind,item.file_id);}catch(error){if(!(error instanceof ServiceError)||error.status!==404)throw error;}
   result.items.push({kind:item.kind,id:item.file_id,name:safeName(current?.name),size:Number(item.byte_size),reason:item.reason,expiresAt:iso(item.expires_at),
    referenceCount:Array.isArray(item.reference_state?.references)?item.reference_state.references.length:null,
    activeReferences:item.reference_state?.activeReferences??null,state:item.state,attemptCount:item.attempt_count,resultCode:item.result_code,
    objectRemoved:item.object_removed,completedAt:iso(item.completed_at),currentState:current?.purged_at?'erased':current?.state??null});
  }}return result;
 }
 plans(operator,input={}){const q=parse(operationsFileCleanupPlansSchema,input);return this.run(operator,false,'file-cleanup-read',{view:'plans',...q},async(db,actor)=>{
  const rows=(await db.query('SELECT * FROM operations_file_cleanup_plans_v1 WHERE endpoint=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3',[this.endpoint,q.after??null,q.limit+1])).rows;
  return{items:await Promise.all(rows.slice(0,q.limit).map(row=>this.planView(db,row,actor,{items:false}))),nextAfter:rows.length>q.limit?rows[q.limit-1].id:null,permissions:this.caps(actor),...readMeta(this.now())};
 });}
 plan(operator,id){return this.run(operator,false,'file-cleanup-read',{view:'plan',id},async(db,actor)=>this.planView(db,await this.planRow(db,id),actor));}
 operation(operator,operationId){parse(z.uuid(),operationId);return this.run(operator,false,'file-cleanup-read',{view:'operation',id:operationId},async(db,actor)=>{
  const row=(await db.query("SELECT action,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2 AND operator_id=$3 AND action IN('file-cleanup-create','file-cleanup-approve','file-cleanup-cancel')",[this.endpoint,operationId,actor.operatorId])).rows[0];
  return{state:row?'recorded':'not-recorded',operationId,...(row?{kind:row.action.slice('file-cleanup-'.length),planId:row.result.planId}:{}),...readMeta(this.now())};
 });}
 async create(operator,input,{authorize=null}={}){
  const actor=this.human(operator),x=parse(operationsFileCleanupCreateSchema,input);await this.fresh(actor,'files.cleanup.plan',authorize);
  const receipt=await this.command(actor,'file-cleanup-create',{operationId:x.operationId,command:x},async(db)=>{
   await this.fresh(actor,'files.cleanup.plan',authorize,db);const planned=[];
   for(const item of [...x.items].sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id))){
    const row=await this.scopedRowWithin(db,item.kind,item.id),facts=await this.facts(db,item.kind,row);
    if(fileProcessingVersion(row)!==item.expectedVersion)fail('operations_file_changed');
    if(!this.candidate(item.kind,row,facts).eligible)fail('operations_file_cleanup_ineligible');planned.push({item,row,facts});
   }
   const bytes=total(planned.map(value=>value.row.byte_size));if(bytes===null)fail('operations_file_cleanup_size_unavailable');
   const planId=randomUUID();await db.query("INSERT INTO operations_file_cleanup_plans_v1(id,endpoint,revision,state,created_by,created_at,reason,item_count,declared_bytes) VALUES($1,$2,1,'awaiting-approval',$3,$4,$5,$6,$7)",[planId,this.endpoint,actor.operatorId,stamp(this.now()),x.reason,planned.length,bytes]);
   for(const [position,{item,row,facts}] of planned.entries())await db.query("INSERT INTO operations_file_cleanup_items_v1(plan_id,position,kind,file_id,expected_version,reference_state,reason,byte_size,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')",
    [planId,position,item.kind,item.id,fileProcessingVersion(row),JSON.stringify(facts.source),facts.eligibility.reason,row.byte_size,row.expires_at??row.prepare_expires_at]);
   await this.fresh(actor,'files.cleanup.plan',authorize,db);return{planId,kind:'create',state:'awaiting-approval'};
  });await this.fresh(actor,'files.cleanup.plan',authorize);return{...receipt,plan:await this.plan(actor,receipt.planId)};
 }
 async approve(operator,id,input,{authorize=null}={}){return this.decision(operator,id,input,{authorize,kind:'approve'});}
 async cancel(operator,id,input,{authorize=null}={}){return this.decision(operator,id,input,{authorize,kind:'cancel'});}
 async decision(operator,id,input,{authorize,kind}){
  const actor=this.human(operator),x=parse(operationsFileCleanupDecisionSchema,input);parse(z.uuid(),id);const action=kind==='approve'?'files.cleanup.approve':'files.cleanup.plan';await this.fresh(actor,action,authorize);
  const receipt=await this.command(actor,'file-cleanup-'+kind,{operationId:x.operationId,id,command:x},async(db,current)=>{
   await this.fresh(actor,action,authorize,db);const plan=await this.planRow(db,id,{write:true});if(plan.revision!==x.expectedRevision)fail('operations_file_cleanup_plan_changed');
   if(kind==='approve'){
    if(plan.state!=='awaiting-approval')fail('operations_file_cleanup_plan_state');
    for(const item of (await db.query('SELECT * FROM operations_file_cleanup_items_v1 WHERE plan_id=$1 ORDER BY kind,file_id',[id])).rows){
     const row=await this.scopedRowWithin(db,item.kind,item.file_id),facts=await this.facts(db,item.kind,row);
     if(fileProcessingVersion(row)!==item.expected_version||!isDeepStrictEqual(facts.source,item.reference_state)||!facts.eligibility.eligible||facts.eligibility.reason!==item.reason)fail('operations_file_cleanup_plan_changed');
    }
    await db.query("UPDATE operations_file_cleanup_plans_v1 SET state='queued',revision=revision+1,approved_by=$2,approved_at=$3 WHERE id=$1",[id,current.operatorId,stamp(this.now())]);
   }else{
    if(!['awaiting-approval','queued','running','attention'].includes(plan.state))fail('operations_file_cleanup_plan_state');
    await db.query("UPDATE operations_file_cleanup_plans_v1 SET state='cancelled',revision=revision+1,cancelled_by=$2,cancelled_at=$3 WHERE id=$1",[id,current.operatorId,stamp(this.now())]);
    await db.query("UPDATE operations_file_cleanup_items_v1 SET state='skipped',result_code='plan-cancelled',completed_at=$2 WHERE plan_id=$1 AND state IN('pending','removing','result-unknown')",[id,stamp(this.now())]);
   }await this.fresh(actor,action,authorize,db);return{planId:id,kind,state:kind==='approve'?'queued':'cancelled'};
  });await this.fresh(actor,action,authorize);return{...receipt,plan:await this.plan(actor,id)};
 }
 async approver(db,plan){
  if(!plan.approved_by||!plan.approved_at)fail('operations_file_cleanup_approval_required',403);
  // A stored identity is an approval locator, never a role/session authority.
  // effective() discards reader and asks the real management directory + PG.
  return this.businessAdmin.authorizeAction({kind:'business-operator',operatorId:plan.approved_by,endpoint:this.endpoint,role:'reader'},'files.cleanup.approve',{db});
 }
 async finishWithin(db,id){
  const items=(await db.query('SELECT state,attempt_count FROM operations_file_cleanup_items_v1 WHERE plan_id=$1',[id])).rows;
  const unfinished=items.some(item=>item.state==='pending'||item.state==='removing'||item.state==='result-unknown'&&item.attempt_count<3);
  const state=unfinished?'running':items.some(item=>item.state==='result-unknown')?'attention':'completed';
  await db.query("UPDATE operations_file_cleanup_plans_v1 SET state=$2,revision=revision+1,completed_at=CASE WHEN $2 IN('completed','attention') THEN $3::timestamptz ELSE NULL END WHERE id=$1 AND state IN('queued','running')",[id,state,stamp(this.now())]);
 }
 async processApproved({limit=1}={}){
  if(!Number.isInteger(limit)||limit<1||limit>20)fail('invalid_operations_request',400);let processed=0;
  for(let n=0;n<limit;n++){
   const claimed=await transaction(this.db,async db=>{
    const plan=(await db.query("SELECT * FROM operations_file_cleanup_plans_v1 p WHERE endpoint=$1 AND state IN('queued','running') AND EXISTS(SELECT 1 FROM operations_file_cleanup_items_v1 i WHERE i.plan_id=p.id AND (i.state='pending' OR i.state IN('removing','result-unknown') AND i.attempt_count<3 AND i.next_attempt_at<=$2)) ORDER BY created_at,id LIMIT 1 FOR UPDATE OF p SKIP LOCKED",[this.endpoint,stamp(this.now())])).rows[0];if(!plan)return null;
    const item=(await db.query("SELECT * FROM operations_file_cleanup_items_v1 WHERE plan_id=$1 AND (state='pending' OR state IN('removing','result-unknown') AND attempt_count<3 AND next_attempt_at<=$2) ORDER BY position LIMIT 1 FOR UPDATE",[plan.id,stamp(this.now())])).rows[0];
    const attempt=randomUUID();await db.query("UPDATE operations_file_cleanup_items_v1 SET state='removing',attempt_count=attempt_count+1,attempt_id=$3,attempted_at=$4,next_attempt_at=$5 WHERE plan_id=$1 AND position=$2",[plan.id,item.position,attempt,stamp(this.now()),stamp(this.now()+120)]);
    await db.query("UPDATE operations_file_cleanup_plans_v1 SET state='running',revision=revision+1 WHERE id=$1",[plan.id]);return{planId:plan.id,position:item.position,attempt};
   });if(!claimed)break;
   const startedAt=performance.now();try{await transaction(this.db,async db=>{
    const plan=await this.planRow(db,claimed.planId,{write:true}),item=(await db.query('SELECT * FROM operations_file_cleanup_items_v1 WHERE plan_id=$1 AND position=$2 FOR UPDATE',[plan.id,claimed.position])).rows[0];
    if(!['queued','running'].includes(plan.state)||item.attempt_id!==claimed.attempt||item.state!=='removing')return;
    await this.approver(db,plan);let row=null;try{row=await this.scopedRowWithin(db,item.kind,item.file_id,{write:true});}catch(error){if(!(error instanceof ServiceError)||error.status!==404)throw error;}
    let skip=null;
    if(!row)skip='file-unavailable';else if(row.purged_at)skip='already-removed';
    else{const facts=await this.facts(db,item.kind,row,{planId:plan.id});if(fileProcessingVersion(row)!==item.expected_version)skip='file-changed';
     else if(!isDeepStrictEqual(facts.source,item.reference_state))skip='references-changed';else if(!facts.eligibility.eligible||facts.eligibility.reason!==item.reason)skip='eligibility-changed';}
    if(skip){await db.query("UPDATE operations_file_cleanup_items_v1 SET state=$3,result_code=$4,object_removed=$5,completed_at=$6,next_attempt_at=NULL WHERE plan_id=$1 AND position=$2",[plan.id,item.position,skip==='already-removed'?'removed':'skipped',skip,skip==='already-removed'?true:null,stamp(this.now())]);await this.finishWithin(db,plan.id);return;}
    const store=this.service(item.kind).store;if(typeof store?.head!=='function'||typeof store?.erase!=='function')fail('attachment_service_unavailable',503);
    await this.approver(db,plan);const before=await store.head({key:row.storage_key,keyId:row.encryption_key_id});
    if(before&&(before.size!==Number(row.byte_size)||before.sha256!=null&&before.sha256!==row.sha256))fail('attachment_storage_integrity_failed',502);
    if(before){await this.approver(db,plan);const receipt=await store.erase({key:row.storage_key});if(receipt?.objectRemoved!==true)fail('operations_file_cleanup_result_unknown',503);
     if(await store.head({key:row.storage_key,keyId:row.encryption_key_id}))fail('operations_file_cleanup_result_unknown',503);}
    await this.approver(db,plan);
    await db.query(`UPDATE ${fileCleanupTable(item.kind)} SET state='erased',name='',media_type='',purge_pending=false,purged_at=$2,lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1`,[row.id,stamp(this.now())]);
    await db.query("UPDATE operations_file_cleanup_items_v1 SET state='removed',result_code=$3,object_removed=true,completed_at=$4,next_attempt_at=NULL WHERE plan_id=$1 AND position=$2",[plan.id,item.position,before?'object-removed':'object-already-absent',stamp(this.now())]);
    await this.finishWithin(db,plan.id);
   });}catch(error){
    try{this.logger({event:'file_cleanup_deferred',stage:'approved-file-cleanup',resourceId:claimed.planId,startedAt,error});}catch{}
    await transaction(this.db,async db=>{const plan=await this.planRow(db,claimed.planId,{write:true});if(plan.state==='cancelled')return;
     await db.query("UPDATE operations_file_cleanup_items_v1 SET state='result-unknown',result_code=$4,object_removed=NULL,next_attempt_at=CASE WHEN attempt_count<3 THEN $5::timestamptz ELSE NULL END WHERE plan_id=$1 AND position=$2 AND attempt_id=$3 AND state='removing'",[claimed.planId,claimed.position,claimed.attempt,workerCode(error),stamp(this.now()+30)]);
     await this.finishWithin(db,plan.id);
    });
   }processed++;
  }return{processed,physicalBlocksReleased:null};
 }
}
