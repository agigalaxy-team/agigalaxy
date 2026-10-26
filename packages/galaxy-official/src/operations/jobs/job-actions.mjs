import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {ServiceError} from "../../shared/service-error.mjs";

export const aiJobQueues=['information-watch','search-recovery','content-publication','account-notice','retention-cleanup','messaging-run','messaging-delivery'];
export const jobActionCommandSchema=z.strictObject({operationId:z.uuid(),expectedState:z.string().min(1).max(32),expectedRetryCount:z.number().int().nonnegative(),reason:z.string().trim().min(3).max(1600)});
export const searchRetryCommandSchema=z.strictObject({operationId:z.uuid(),expectedGeneration:z.number().int().positive(),reason:z.string().trim().min(3).max(1600)});
const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const domainPermission=(queue,kind)=>queue==='content-publication'?'cms.publish':['account-notice','messaging-run','messaging-delivery'].includes(queue)?(kind==='job-cancel'?'notices.withdraw':'notices.publish'):queue==='retention-cleanup'?'retention.request':queue==='search-recovery'?'search.retry':null;

// Uses the existing queue/search transaction and audit, never a second effect
// ledger. The exact operation receipt is committed together with the mutation.
export class OperationsJobActions {
 constructor({db,endpoint,businessAdmin,jobs,searchIndex}){Object.assign(this,{db,endpoint,businessAdmin,jobs,searchIndex});}
 async read(actor,kind,request){
  const read=kind==='search-retry'?'search.read':'jobs.read';
  await this.businessAdmin.authorizeAction(actor,read);
  const job=kind==='search-retry'?await this.searchIndex.failureStatus(request.targetId):await this.jobs.get(request.queue,request.targetId);
  if(!job)fail('operations_job_not_found',404);
  return job;
 }
 async qualifyWithin(db,actor,kind,request,command){
  if(kind==='search-retry'){
   const job=(await db.query("SELECT j.id,j.state,j.payload FROM jobs j JOIN search_index_control c ON c.singleton AND c.endpoint=$2 AND c.enabled WHERE j.id=$1 AND j.kind='search-index'",[request.targetId,this.endpoint])).rows[0];
   if(!job||job.state!=='failed'||job.payload.generation!==command.expectedGeneration)fail('search_recovery_conflict');
  }else{
   // A generic queue grant cannot stand in for publishing, messaging or data
   // cleanup decisions. Those queues remain concrete human-card operations.
   if(actor.kind==='operations-ai-service'&&request.queue!=='information-watch')fail('operations_agentos_human_review_required');
   const row=(await db.query('SELECT id,state,retry_count FROM galaxy_jobs.job WHERE name=$1 AND id=$2',[request.queue,request.targetId])).rows[0];
   if(!row||row.state!==command.expectedState||row.retry_count!==command.expectedRetryCount)fail('operations_job_changed');
  }
 }
 async command(actor,kind,request,input,{authorize}={}){
  const schema=kind==='search-retry'?searchRetryCommandSchema:jobActionCommandSchema,parsed=schema.safeParse(input);
  if(!parsed.success||!['job-cancel','job-retry','search-retry'].includes(kind))fail('invalid_operations_job_action',400);
  const command=parsed.data,selection={id:request.targetId,jobId:request.targetId,...(request.queue?{queue:request.queue}:{}),command};
  let actual=actor;
  const current=async db=>{
   actual=await authorize?.({db})??actor;
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.endpoint+':job-action:'+command.operationId]);
   const prior=(await db.query('SELECT operation_id FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,command.operationId])).rows[0];
   // A repeated POST never dispatches. Its owner must read the original result.
   if(prior)fail('operations_job_operation_recorded');
   actual=await this.businessAdmin.authorizeOperation(actual,kind,{...selection,operationId:command.operationId},{db});
   const domain=request.queue&&domainPermission(request.queue,kind);
   if(domain)actual=await this.businessAdmin.authorizeAction(actual,domain,{db});
   await this.qualifyWithin(db,actual,kind,request,command);
  };
  let receipt;const audit=async(db,result)=>{receipt=result;await this.businessAdmin.recordWithin(db,actual,kind,{operationId:command.operationId,selection,result});};
  if(kind==='search-retry')await this.searchIndex.retryFailed({jobId:request.targetId,expectedGeneration:command.expectedGeneration},{authorize:current,audit});
  else await this.jobs[kind==='job-cancel'?'cancel':'retry'](request.queue,request.targetId,{endpoint:this.endpoint,authorize:current,audit,
   check:(_db,job)=>{if(job.state!==command.expectedState||job.retryCount!==command.expectedRetryCount)fail('operations_job_changed');}});
  return receipt;
 }
 async operation(actor,kind,request,command,operationId){
  await this.businessAdmin.authorizeAction(actor,kind==='search-retry'?'search.read':'jobs.read');
  const row=(await this.db.query('SELECT operator_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];
  if(!row)return null;
  const expected={id:request.targetId,jobId:request.targetId,...(request.queue?{queue:request.queue}:{}),command:{...command,operationId}};
  if(row.operator_id!==actor.operatorId||row.action!==kind||!isDeepStrictEqual(row.selection,expected))fail('operations_agentos_operation_conflict');
  return row.result;
 }
}
