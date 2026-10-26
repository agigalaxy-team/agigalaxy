import {z} from 'zod';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {cleanupPrivateConversationsWithin} from './operations/private-conversation-retention.mjs';
import {cleanupExpiredExports} from './infrastructure/export-retention.mjs';
import {cleanupInformationWatchesWithin} from './operations/information-watch-retention-v2.mjs';
import {lifecyclePolicyVersion,productV2Retention} from './infrastructure/lifecycle-registry-v2.mjs';
import {operationsPageSchema,retentionTargetSchema,retentionRequestSchema,operationsProductParse as parse} from './shared/operations-product-schema.mjs';
import {operationsProductCommand,operationsStamp as stamp} from './operations-product-commands.mjs';

const targets={
  'private-conversation-archives':{
    label:'已到期的私有会话副本',maximumRowsPerRun:100,expiry:'owner-configured-expires-at',
    count:async(db,at)=>Number((await db.query('SELECT count(*)::text AS n FROM private_conversation_archives_v1 WHERE expires_at<=$1',[at])).rows[0].n),
    clean:(db,at)=>cleanupPrivateConversationsWithin(db,at,{limit:100}),
    result:z.strictObject({privateConversationArchives:z.number().int().nonnegative()}),
  },
  'data-exports':{
    label:'已到期或撤销的导出请求',maximumRowsPerRun:100,expiry:'existing-expires-at-or-revoked',
    count:async(db,at)=>Number((await db.query('SELECT count(*)::text AS n FROM data_exports WHERE expires_at<=$1 OR revoked_at IS NOT NULL',[at])).rows[0].n),
    clean:(db,at)=>cleanupExpiredExports(db,new Date(at*1000)),
    result:z.strictObject({removed:z.number().int().nonnegative(),payloadFilesStored:z.literal(false)}),
  },
  'information-watches':{
    label:'到期的资料关注回执',maximumRowsPerRun:null,maximumRootsPerRun:100,expiry:'existing-90-day-receipts',
    count:async(db,at)=>{
      const now=Date.parse(at),before=new Date(now-productV2Retention.informationWatches.watchReceiptDaysAfterExitOrExpiry*86400000).toISOString();
      return Number((await db.query(`SELECT ((SELECT count(*) FROM information_watch_changes_v2 WHERE expires_at<=$1)
        +(SELECT count(*) FROM information_watches_v2 WHERE COALESCE(ended_at,expires_at)<=$2))::text AS n`,[at,before])).rows[0].n);
    },
    clean:(db,at)=>cleanupInformationWatchesWithin(db,at),
    result:z.strictObject({informationChangeReceipts:z.number().int().nonnegative(),informationWatchReceipts:z.number().int().nonnegative()}),
  },
};
const view=row=>({id:row.id,target:row.target,state:row.state,requestedBy:row.requested_by,attempts:row.attempts,result:row.result,errorCode:row.error_code,
  createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at),finishedAt:stamp(row.finished_at),jobId:row.job_id});
const cancellations=new WeakMap();
export function registerOperationsRetentionCancellation({jobs,endpoint,now=()=>Math.floor(Date.now()/1000)}){
  let endpoints=cancellations.get(jobs);
  if(!endpoints){
    endpoints=new Map();cancellations.set(jobs,endpoints);
    jobs.onCancel('retention-cleanup',async(db,{runId},context={})=>{
      const row=(await db.query('SELECT * FROM operations_retention_runs_v1 WHERE id=$1 FOR UPDATE',[runId])).rows[0];
      if(!row||!endpoints.has(row.endpoint)||context.endpoint&&row.endpoint!==context.endpoint)throw new ServiceError('operations_retention_not_found',404);
      if(row.state==='completed')throw new ServiceError('operations_retention_not_cancellable',409);
      if(row.state!=='cancelled')await db.query("UPDATE operations_retention_runs_v1 SET state='cancelled',updated_at=$2,finished_at=$2 WHERE id=$1",[runId,new Date(endpoints.get(row.endpoint)()*1000).toISOString()]);
    });
  }
  endpoints.set(endpoint,now);
}

export class OperationsRetention{
  constructor({db,endpoint,businessAdmin,jobs,now=()=>Math.floor(Date.now()/1000)}){
    Object.assign(this,{db,endpoint,businessAdmin,jobs,now});registerOperationsRetentionCancellation({jobs,endpoint,now});
  }
  async status(operator){
    await this.businessAdmin.authorizeAction(operator,'retention.read');const items=[],at=new Date(this.now()*1000).toISOString();
    for(const [key,target]of Object.entries(targets)){
      const observations=(await this.db.query('SELECT * FROM operations_retention_observations_v1 WHERE endpoint=$1 AND target=$2 ORDER BY component',[this.endpoint,key])).rows;
      items.push({key,label:target.label,backlog:await target.count(this.db,at),maximumRowsPerRun:target.maximumRowsPerRun,maximumRootsPerRun:target.maximumRootsPerRun??null,expiry:target.expiry,
        observations:observations.map(row=>({component:row.component,result:row.result,errorCode:row.error_code,checkedAt:stamp(row.checked_at)}))});
    }
    return {policyVersion:lifecyclePolicyVersion,targets:items,checkedAt:this.now(),scope:'configured-business-database'};
  }
  async list(operator,input={}){
    await this.businessAdmin.authorizeAction(operator,'retention.read');const page=parse(operationsPageSchema,input),rows=(await this.db.query(`SELECT * FROM operations_retention_runs_v1
      WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3`,[this.endpoint,page.after??null,page.limit+1])).rows;
    return {items:rows.slice(0,page.limit).map(view),nextAfter:rows.length>page.limit?String(rows[page.limit-1].sequence):null,checkedAt:this.now()};
  }
  async rowWithin(db,id,{lock=false}={}){
    parse(z.uuid(),id);const row=(await db.query(`SELECT * FROM operations_retention_runs_v1 WHERE endpoint=$1 AND id=$2${lock?' FOR UPDATE':''}`,[this.endpoint,id])).rows[0];
    if(!row)throw new ServiceError('operations_retention_not_found',404);return row;
  }
  async get(operator,id){await this.businessAdmin.authorizeAction(operator,'retention.read');return {run:view(await this.rowWithin(this.db,id))};}
  async request(operator,input){
    const data=parse(retentionRequestSchema,input);
    return operationsProductCommand(this,operator,'retention-request',data,async(db,actor)=>{
      const at=new Date(this.now()*1000).toISOString();
      const row=(await db.query(`INSERT INTO operations_retention_runs_v1(id,endpoint,target,state,requested_by,request_actor,created_at,updated_at)
        VALUES($1,$2,$3,'queued',$4,$5,$6,$6) RETURNING *`,[data.operationId,this.endpoint,data.target,actor.operatorId,JSON.stringify(actor),at])).rows[0];
      const jobId=await this.jobs.enqueue('retention-cleanup',{runId:row.id},{key:'retention:'+row.id,db});
      if(!jobId)throw new ServiceError('operations_retention_queue_unavailable',503);
      await db.query('UPDATE operations_retention_runs_v1 SET job_id=$2 WHERE id=$1',[row.id,jobId]);row.job_id=jobId;
      return {result:{run:view(row)},selection:{runId:row.id,target:data.target},auditResult:{state:'queued',maximumRowsPerRun:targets[data.target].maximumRowsPerRun,maximumRootsPerRun:targets[data.target].maximumRootsPerRun??null}};
    });
  }
  // Internal worker hook only. Call after a REAL existing scheduled sweep, with
  // its actual category counts. Absence is shown as no observation, not failure
  // or a claim that scheduled cleanup has never run.
  async recordMaintenance({target,component='worker',result=null,errorCode=null},db=this.db){
    parse(retentionTargetSchema,target);
    if(component!=='worker'||errorCode!==null&&!['retention_cleanup_failed','operations_permission_denied','business_admin_denied','identity_directory_unavailable','operations_authorization_unavailable'].includes(errorCode))throw new ServiceError('invalid_operations_product_request');
    const value=errorCode?null:parse(targets[target].result,result);
    await db.query(`INSERT INTO operations_retention_observations_v1(endpoint,target,component,result,error_code,checked_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(endpoint,target,component) DO UPDATE SET result=EXCLUDED.result,error_code=EXCLUDED.error_code,checked_at=EXCLUDED.checked_at`,
    [this.endpoint,target,component,value?JSON.stringify(value):null,errorCode,new Date(this.now()*1000).toISOString()]);
  }
}

export function createOperationsRetentionWorker({retention,jobs=retention.jobs}){
  async function execute({runId}){
    parse(z.uuid(),runId);
    try{
      return await transaction(retention.db,async db=>{
        const row=await retention.rowWithin(db,runId,{lock:true});
        if(['completed','cancelled'].includes(row.state))return {state:row.state};
        const actor=await retention.businessAdmin.revalidate(row.request_actor,{write:true,action:'retention.request',db});
        if(actor.operatorId!==row.requested_by)throw new ServiceError('operations_retention_authority_changed',403);
        const result=parse(targets[row.target].result,await targets[row.target].clean(db,retention.now())),at=new Date(retention.now()*1000).toISOString();
        await db.query("UPDATE operations_retention_runs_v1 SET state='completed',attempts=attempts+1,result=$2,error_code=NULL,updated_at=$3,finished_at=$3 WHERE id=$1",[runId,JSON.stringify(result),at]);
        await retention.recordMaintenance({target:row.target,result},db);
        await retention.businessAdmin.recordWithin(db,actor,'retention-complete',{selection:{runId,target:row.target,execution:'worker'},result:{state:'completed',counts:result}});
        return {state:'completed',result};
      });
    }catch(error){
      const code=['operations_permission_denied','business_admin_denied','identity_directory_unavailable','operations_authorization_unavailable'].includes(error?.code)?error.code:'retention_cleanup_failed';
      await transaction(retention.db,async db=>{
        const row=await retention.rowWithin(db,runId,{lock:true});if(['completed','cancelled'].includes(row.state))return;
        const at=new Date(retention.now()*1000).toISOString();
        await db.query("UPDATE operations_retention_runs_v1 SET state='failed',attempts=attempts+1,error_code=$2,updated_at=$3,finished_at=$3 WHERE id=$1",[runId,code,at]);
        await retention.recordMaintenance({target:row.target,errorCode:code},db);
        const actor=retention.businessAdmin.require(row.request_actor,{write:true});
        await retention.businessAdmin.recordWithin(db,actor,'retention-failed',{selection:{runId,target:row.target,execution:'worker',reason:['business_admin_denied','operations_permission_denied'].includes(code)?'authority_changed':'execution_failed'},result:{state:'failed',code}});
      });
      throw new ServiceError(code,['business_admin_denied','operations_permission_denied'].includes(code)?403:503);
    }
  }
  return {execute,start:()=>jobs.work('retention-cleanup',execute),stop:()=>jobs.stopWork('retention-cleanup')};
}
