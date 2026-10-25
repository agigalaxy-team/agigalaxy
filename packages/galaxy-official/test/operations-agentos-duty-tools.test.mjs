import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ServiceError} from '../src/shared/service-error.mjs';
import {createOperationsAgentOsDutyTools} from '../src/operations-agentos-duty-tools.mjs';
import {originalOperationTarget} from '../src/operations-agentos-duty-receipts.mjs';

const fixture=()=>{
 const task={id:randomUUID(),ai_account_id:randomUUID()},actor={kind:'operations-ai-service',taskId:null,aiAccountId:null};
 actor.taskId=task.id;actor.aiAccountId=task.ai_account_id;
 return{task,actor,operationId:randomUUID(),authority:{acceptsDuty:value=>value===actor}};
};

test('duty bridge accepts only the server minted task actor and keeps its original command identity',async()=>{
 const f=fixture(),calls=[],authorizeOperation=async()=>({allowed:true});
 const bridge=createOperationsAgentOsDutyTools({...f,authorizeOperation,actions:{async executeDutyOperation(value){calls.push(value);return{state:'unknown',operationId:value.operationId,receipt:null};}}});
 const args={kind:'content-curation',targetKind:'post',targetId:randomUUID(),topic:null,reason:'原条件内处理'};
 const result=await bridge({...f,tool:'execute-operation',arguments:args,reconcile:true});
 assert.equal(result.state,'unknown');assert.equal(result.receipt,null);assert.equal(result.businessReceipt,undefined);
 assert.deepEqual(calls[0],{actor:f.actor,operationId:f.operationId,arguments:args,authorizeOperation,reconcile:true});
 await assert.rejects(bridge({...f,actor:{...f.actor},tool:'execute-operation',arguments:args}),{code:'operations_ai_duty_operation_denied'});
 await assert.rejects(bridge({...f,tool:'execute-operation',arguments:{...args,operationId:randomUUID()}}),{code:'invalid_operations_autonomy_request'});
 assert.equal(calls.length,1);
});

test('AI role management calls the existing bounded service with the ledger operation rather than a model role identity',async()=>{
 const f=fixture(),calls=[];
 const bridge=createOperationsAgentOsDutyTools({...f,permissions:{
  async delegatedDirectory(actor){calls.push({actor,read:true});return{delegation:{version:3},roles:[]};},
  async delegatedRoleSave(actor,input){calls.push({actor,input});return{operationId:input.operationId,delegationVersion:3,recordedAt:'2026-10-26T00:00:00Z',role:{id:randomUUID(),version:1}};}
 }});
 assert.equal((await bridge({...f,tool:'read-ai-delegation',arguments:{}})).delegation.version,3);
 const args={kind:'role-create',name:'消息查询',description:'批准范围',expectedVersion:0,enabled:true,permissions:['messaging.read'],targetAiAccountIds:[randomUUID()]};
 await bridge({...f,tool:'manage-ai-role',arguments:args});
 assert.equal(calls[1].actor,f.actor);assert.deepEqual(calls[1].input,{...args,operationId:f.operationId});
 await assert.rejects(bridge({...f,tool:'manage-ai-role',arguments:{...args,role:'administrator'}}),{code:'invalid_operations_autonomy_request'});
});

test('a required human decision stays attached to this task while unavailable writers never pretend to execute',async()=>{
 const f=fixture(),human=[];
 const bridge=createOperationsAgentOsDutyTools({...f,authorizeOperation:async()=>({allowed:true}),
  onHumanRequired:async value=>human.push(value),actions:{async executeDutyOperation(){throw new ServiceError('operations_agentos_human_review_required',409);}}});
 const result=await bridge({...f,tool:'execute-operation',arguments:{kind:'file-cleanup-approve',planId:randomUUID()}});
 assert.equal(result.state,'waiting-human');assert.equal(result.effectState,'not-confirmed');assert.equal(result.operationId,f.operationId);
 assert.deepEqual(human,[{taskId:f.task.id,operationId:f.operationId,code:'operations_agentos_human_review_required'}]);
 const unavailable=createOperationsAgentOsDutyTools(f);
 await assert.rejects(unavailable({...f,tool:'execute-operation',arguments:{kind:'file-scan-retry',targetKind:'forum',targetId:randomUUID()}}),{code:'operations_autonomy_tool_not_configured',status:503});
});

test('projection failure preserves a committed original business receipt without issuing the action again',async()=>{
 const f=fixture();let calls=0;
 const bridge=createOperationsAgentOsDutyTools({...f,authorizeOperation:async()=>({allowed:true}),
  onBusinessReceipt:async()=>{throw new Error('explicit-projection-outage');},
  actions:{async executeDutyOperation({operationId}){calls++;return{operationId,state:'completed',effectState:'completed',receipt:{operationId,state:'completed'},target:{kind:'post',id:'original-target'},basis:'persisted-domain-operation-receipt'};}}});
 const result=await bridge({...f,tool:'execute-operation',arguments:{kind:'content-curation',targetKind:'post',targetId:'original-target'}});
 assert.equal(calls,1);assert.equal(result.effectState,'completed');assert.equal(result.receipt.operationId,f.operationId);
 assert.equal(result.businessReceipt.operationId,f.operationId);assert.equal(result.businessReceipt.basis,'persisted-domain-operation-receipt');
});

test('a partial batch keeps the immutable per-object outcomes under one original composite operation',async()=>{
 const f=fixture(),first=randomUUID(),second=randomUUID(),receipt={operationId:f.operationId,counts:{applied:1,rejected:1},items:[
  {kind:'post',id:first,status:'applied',code:null,revision:2},
  {kind:'reply',id:second,status:'rejected',code:'content_revision_changed',revision:null}],replayed:false};
 const bridge=createOperationsAgentOsDutyTools({...f,authorizeOperation:async()=>({allowed:true}),
  actions:{async executeDutyOperation(){return{operationId:f.operationId,state:'completed',effectState:'completed',target:{kind:'content-batch',id:first},basis:'persisted-domain-operation-receipt',receipt};}}});
 const value=await bridge({...f,tool:'execute-operation',arguments:{kind:'public-content-batch',items:[{kind:'post',id:first},{kind:'reply',id:second}],action:'restore',reason:'当前明确范围'}});
 assert.equal(value.businessReceipt.operationId,f.operationId);assert.equal(value.businessReceipt.targetType,null);assert.equal(value.businessReceipt.targetId,null);
 assert.deepEqual(value.businessReceipt.details,{counts:receipt.counts,items:receipt.items});assert.equal(value.businessReceipts,undefined);
 receipt.counts.applied=2;
 assert.equal((await bridge({...f,tool:'execute-operation',arguments:{kind:'public-content-batch'}})).businessReceipt,undefined,'Inconsistent counts cannot be projected as a business completion');
});

test('receipt target projection follows current domain proposal kinds and preserves their actual source identity',()=>{
 const id=randomUUID();
 for(const [kind,expected] of [['public-case','community-report'],['message-plan','messaging-plan'],['account','account'],['section','content-section'],['projects','project'],['methods','method'],['rule','rule-key'],['search-configuration','search-quality'],['recommendation-theme','recommendation-policy'],['strategy','strategy'],['strategy-configuration','strategy-configuration'],['strategy-run','strategy-run']])assert.deepEqual(originalOperationTarget({kind,id},{}),{targetType:expected,targetId:id});
 assert.deepEqual(originalOperationTarget({kind:'file',id},{targetKind:'chat'}),{targetType:'file-chat',targetId:id});
 assert.deepEqual(originalOperationTarget({kind:'file',id},{targetKind:'forum'}),{targetType:'file-forum',targetId:id});
 assert.deepEqual(originalOperationTarget({kind:'content-batch',id},{}),{targetType:null,targetId:null});
 assert.deepEqual(originalOperationTarget({kind:'file',id},{}),{targetType:null,targetId:null});
});
