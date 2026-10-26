import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {queueFixture} from './operations-jobs-fixture.mjs';
import {SearchIndex} from '../src/search-index.mjs';
import {OperationsJobActions} from '../src/operations-job-actions.mjs';
import {OperationsAgentOsActionTools} from '../src/operations-agentos-action-tools.mjs';
import {workbenchPrepareSchemas} from '../src/operations-agentos-action-catalog.mjs';
import {aiActionDefinition} from '../src/shared/operations-ai-action-registry.mjs';

test('typed job cards freeze real state; real queue/audit commit atomically and recovery never dispatches',async()=>{
 const db=new PGlite();let queue;
 try{
  await migrate(db);queue=queueFixture(db);await queue.jobs.start();
  const actor={kind:'business-operator',operatorId:'synthetic-job-operator',role:'reader',endpoint:'https://official.invalid'},permissions=new Set(['workbench.read','jobs.read','jobs.cancel','jobs.retry','search.read','search.retry']);let denyAudit=false;
  const businessAdmin={async authorizeAction(a,code){if(!permissions.has(code))throw Object.assign(Error(code),{code:'operations_permission_denied',status:403});return a;},async authorizeOperation(a,kind){return this.authorizeAction(a,kind==='search-retry'?'search.retry':kind==='job-cancel'?'jobs.cancel':'jobs.retry');},async recordWithin(tx,a,kind,{operationId,selection,result}){
   if(denyAudit)throw Error('synthetic audit failure');
   await tx.query('INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,selection,result,created_at,actor_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)',[randomUUID(),a.endpoint,a.operatorId,a.role,kind,operationId,JSON.stringify(selection),JSON.stringify(result),a.kind]);
  }};
  const authority={db,endpoint:actor.endpoint,now:()=>1000,async human(a,{action}={}){return action?businessAdmin.authorizeAction(a,action):a;}},jobActions=new OperationsJobActions({db,endpoint:actor.endpoint,businessAdmin,jobs:queue.jobs}),tools=new OperationsAgentOsActionTools({authority,services:{jobActions}});
  const id=await queue.jobs.enqueue('information-watch',{watchId:randomUUID()},{key:'explicit-job'}),request={kind:'job-cancel',queue:'information-watch',targetId:id,reason:'明确合成取消请求'};
  const proposal=await tools.prepareFor(actor,'maintenance',request),operationId=randomUUID();
  assert.equal((await queue.jobs.get(request.queue,id)).state,'created','prepare is read-only');
  assert.equal(proposal.decisionSource,'human-required');assert.equal(proposal.command.expectedState,'created');
  denyAudit=true;await assert.rejects(tools.executePrepared(actor,proposal,{operationId,authorize:()=>actor}),/synthetic audit failure/);
  assert.equal((await queue.jobs.get(request.queue,id)).state,'created','failed audit rolls queue back');
  denyAudit=false;const result=await tools.executePrepared(actor,proposal,{operationId,authorize:()=>actor});assert.equal(result.state,'completed');assert.equal(result.receipt.state,'cancelled');
  const originalCancel=queue.jobs.cancel.bind(queue.jobs);queue.jobs.cancel=()=>{throw Error('recovery dispatched writer');};
  permissions.delete('jobs.cancel');const recovered=await tools.recoverPrepared(actor,proposal,operationId);assert.equal(recovered.receipt.state,'cancelled');
  await assert.rejects(jobActions.operation({...actor,operatorId:'other'},request.kind,request,proposal.command,operationId),{code:'operations_agentos_operation_conflict'});
  queue.jobs.cancel=originalCancel;permissions.add('jobs.cancel');
  await assert.rejects(tools.executePrepared(actor,proposal,{operationId,authorize:()=>actor}),{code:'operations_job_operation_recorded'});
  assert.equal((await db.query('SELECT count(*)::int n FROM business_admin_audit_v1 WHERE operation_id=$1',[operationId])).rows[0].n,1);
  await assert.rejects(tools.prepareFor(actor,'maintenance',{...request,kind:'job-retry'}),{code:'operations_agentos_operation_unavailable'});
  const changed=await queue.jobs.enqueue('information-watch',{watchId:randomUUID()},{key:'changed-job'}),old=await tools.prepareFor(actor,'maintenance',{...request,targetId:changed});
  await queue.jobs.cancel('information-watch',changed);
  await assert.rejects(tools.executePrepared(actor,old,{operationId:randomUUID(),authorize:()=>actor}),{code:'operations_job_changed'});
  const retryId=await queue.jobs.enqueue('information-watch',{watchId:randomUUID()},{key:'failed-job'});
  await db.query("UPDATE galaxy_jobs.job SET state='failed' WHERE name='information-watch' AND id=$1",[retryId]);
  const retryProposal=await tools.prepareFor(actor,'maintenance',{...request,kind:'job-retry',targetId:retryId}),retryOperation=randomUUID();
  const retried=await tools.executePrepared(actor,retryProposal,{operationId:retryOperation,authorize:()=>actor});
  assert.equal(retried.receipt.previousState,'failed');assert.notEqual(retried.receipt.state,'failed');
  assert.deepEqual((await tools.recoverPrepared(actor,retryProposal,retryOperation)).receipt,retried.receipt);
  const index=new SearchIndex({db,endpoint:actor.endpoint,jobs:queue.jobs});await index.configure({enabled:true});jobActions.searchIndex=index;
  const searchId=randomUUID();await db.query("INSERT INTO jobs(id,kind,deduplication_key,payload,state,attempts) VALUES($1,'search-index',$2,$3,'failed',5)",[searchId,'typed-search:'+searchId,JSON.stringify({sourceType:'case',sourceId:randomUUID(),subjectId:randomUUID(),generation:4})]);
  const searchProposal=await tools.prepareFor(actor,'discovery',{kind:'search-retry',targetId:searchId,reason:'明确合成索引恢复'}),searchOperation=randomUUID();
  denyAudit=true;await assert.rejects(tools.executePrepared(actor,searchProposal,{operationId:searchOperation,authorize:()=>actor}),/synthetic audit failure/);
  assert.equal((await index.failureStatus(searchId)).state,'failed');denyAudit=false;
  const searchResult=await tools.executePrepared(actor,searchProposal,{operationId:searchOperation,authorize:()=>actor});assert.equal(searchResult.receipt.state,'pending');
  await db.query("UPDATE jobs SET payload=jsonb_set(payload,'{generation}','5') WHERE id=$1",[searchId]);
  assert.equal((await tools.recoverPrepared(actor,searchProposal,searchOperation)).receipt.generation,4);
  await assert.rejects(tools.executePrepared(actor,searchProposal,{operationId:randomUUID(),authorize:()=>actor}),{code:'search_recovery_conflict'});
  assert.equal(workbenchPrepareSchemas['job-retry'].safeParse({...request,kind:'job-retry',queue:'autonomy-task'}).success,false);
  assert.equal(aiActionDefinition('jobs.cancel').handlerImplemented,true);assert.equal(tools.dutyActionReady('jobs.cancel'),true);
 }finally{await queue?.jobs.stop();await db.close();}
});

test('search retry freezes exact generation; unknown recovery reads durable receipt, never current job success',async()=>{
 const actor={kind:'business-operator',operatorId:'same',endpoint:'https://official.invalid'},targetId=randomUUID(),operationId=randomUUID();let generation=4,receipt=null,writes=0;
 const authority={db:{},endpoint:actor.endpoint,now:()=>1000,async human(a){return a;}},service={async read(){return{jobId:targetId,state:'failed',generation};},async command(_a,_kind,_request,input){writes++;assert.equal(input.expectedGeneration,4);receipt={jobId:targetId,generation:4,state:'pending'};throw Error('synthetic response lost after commit');},async operation(){return receipt;},async qualifyWithin(){}};
 const tools=new OperationsAgentOsActionTools({authority,services:{jobActions:service}}),proposal=await tools.prepareFor(actor,'discovery',{kind:'search-retry',targetId,reason:'明确合成索引重试'});
 await assert.rejects(tools.executePrepared(actor,proposal,{operationId,authorize:()=>actor}),/response lost/);
 generation=5;const result=await tools.recoverPrepared(actor,proposal,operationId);assert.equal(result.receipt.generation,4);assert.equal(result.receipt.state,'pending');assert.equal(writes,1);
 await assert.rejects(tools.qualifyDutyTargetWithin({}, {actor:{kind:'operations-ai-service'},permission:'search.retry',targetId:randomUUID(),request:proposal.request,command:proposal.command}),{code:'operations_agentos_scope_denied'});
});

test('autonomous queue qualification never grants publishing or cleanup via generic jobs permission',async()=>{
 const service=new OperationsJobActions({db:{},endpoint:'https://official.invalid'});
 for(const queue of ['retention-cleanup','content-publication','messaging-delivery','search-recovery'])await assert.rejects(service.qualifyWithin({}, {kind:'operations-ai-service'},'job-retry',{queue,targetId:randomUUID()},{expectedState:'failed',expectedRetryCount:0}),{code:'operations_agentos_human_review_required'});
});
