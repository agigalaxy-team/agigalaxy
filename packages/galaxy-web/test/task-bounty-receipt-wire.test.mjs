import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createWebTaskOperations} from '../src/runtime/task-operations.mjs';
import {taskDraft,publicationFromDraft,applicationFromDraft,policyKey,localDateTime} from '../src/features/tasks/task-bounty-client.mjs';

// HTTP-wire fixture: accepted commands and their receipt are kept separately
// from the client journal. It simulates a response lost after server acceptance.
function fixture(){
 const subjectId='GUID1000000000000000000000000000',endpoint='https://official.example.invalid',bindingId=randomUUID();
 const connection={subjectId,endpoint,bindingId,generation:1},prefix='wire:',saved=new Map(),accepted=new Map(),calls=[];
 const store={get:async key=>structuredClone(saved.get(key)),put:async(key,value)=>saved.set(key,structuredClone(value)),update:async(key,change)=>{const value=change(structuredClone(saved.get(key)));saved.set(key,structuredClone(value));return structuredClone(value);}};
 let lose=true;
 const api={snapshot:()=>connection,prepareAuthorization:async(payloadJson,options)=>{calls.push('authorize');return {payloadJson,intent:{id:randomUUID(),...options}};},submitAuthorization:async prepared=>({consentId:prepared.intent.id,payloadJson:prepared.payloadJson}),call:async(path,input)=>{
  calls.push(path);
  if(path==='/v2/tasks/receipt'){const receipt=accepted.get(input.eventId);return receipt?{...input,...receipt,state:receipt.payloadHash===input.payloadHash?'acknowledged':'conflict',checkedAt:2000000000}:{...input,state:'absent',checkedAt:2000000000};}
  const payload=JSON.parse(input.payloadJson),event=payload.event??payload,ref={taskId:payload.taskId,eventId:event.eventId??payload.operationId,payloadHash:createHash('sha256').update(input.payloadJson).digest('hex'),version:payload.event?2:1};
  accepted.set(ref.eventId,ref);if(lose){lose=false;throw Error('synthetic lost acknowledgement');}return ref;
 }};
 const state={active:subjectId,closed:false},lease=()=>({assertCurrent(){assert.equal(state.active,subjectId);}}),operations=createWebTaskOperations({api,prefix,store,captureTaskDraftLease:lease,now:()=>2000000000,taskDraftScope:()=>connection,receiptStatus:{},localKey:name=>`${prefix}${subjectId}:${name}`,agentContinuity:{requireCurrent:async()=>{}},createTaskDraftClient:()=>({clear:async()=>false,close(){}}),config:{endpoint},runtimeState:state});
 return {operations,store,calls,subjectId,prefix,loseAgain(){lose=true;}};
}
test('bounty task and application retain original drafts and reconcile accepted unknown receipts without resending',async()=>{
 const f=fixture(),draft=taskDraft({title:'保留旧草稿',summary:'主动诊断帮助',goal:'找到边界',situation:'没有失败尝试',visibility:'Public',intent:'diagnosis',unknownLocalNote:'旧本机材料'},2000000000);
 await f.store.put(`${f.prefix}${f.subjectId}:task-draft`,draft);
 const policy={id:'test-bounty-current',version:'1',capabilityId:'software-debugging',title:'测试范围条件',collaboration:'basic-bounty',notBefore:1999999999,notAfter:2000003600,minProofs:0,minAcceptedCollaborations:1,historyWindowSeconds:31536000,requireCiSuccess:false,repositories:[]};
 const paid={...draft,collaboration:'basic-bounty',budgetMode:'range',minimum:'0.10000001',maximum:'400.25',unit:'SYNTHETIC',policyKey:policyKey(policy),enrollmentLocal:localDateTime(2000001800)};
 const payload=publicationFromDraft(paid,[policy],2000000000);assert.equal(payload.caseId,null);assert.equal(payload.budget.minimum,'0.10000001');
 assert.throws(()=>publicationFromDraft({...paid,minimum:'9',maximum:'1'},[policy],2000000000));
 await assert.rejects(f.operations.publishTask(payload,{confirmed:true}),/lost acknowledgement/);
 const pending=await f.store.get(`${f.prefix}${f.subjectId}:task-publication`),counts=[f.calls.filter(v=>v==='/v2/tasks').length,f.calls.filter(v=>v==='authorize').length];
 const receipt=await f.operations.reconcilePublication({retry:true});assert.equal(receipt.state,'acknowledged');assert.equal(receipt.taskId,pending.payload.taskId);
 assert.deepEqual([f.calls.filter(v=>v==='/v2/tasks').length,f.calls.filter(v=>v==='authorize').length],counts);assert.deepEqual(await f.store.get(`${f.prefix}${f.subjectId}:task-draft`),draft);
 const application={proposal:'提供有限诊断',scope:'核对单个流程',quoteMode:'own',budgetMode:'fixed',amount:'125.00000001',minimum:'',maximum:'',unit:'SYNTHETIC',selected:[]};
 await f.store.put(`${f.prefix}${f.subjectId}:task-application-draft:${receipt.taskId}`,application);
 const task={taskId:receipt.taskId,version:1,request:payload},event=applicationFromDraft(application,task);f.loseAgain();
 await assert.rejects(f.operations.taskEvent(receipt.taskId,event,{confirmed:true}),/lost acknowledgement/);
 const original=await f.store.get(`${f.prefix}${f.subjectId}:task-event:${receipt.taskId}`),path=`/v2/tasks/${receipt.taskId}/events`,sent=f.calls.filter(v=>v===path).length;
 const eventReceipt=await f.operations.reconcileTaskEvent(receipt.taskId,{retry:true});assert.equal(eventReceipt.state,'acknowledged');assert.equal(eventReceipt.eventId,original.eventId);assert.equal(f.calls.filter(v=>v===path).length,sent);
 assert.equal(JSON.parse(original.payloadJson).event.quote.amount,'125.00000001');assert.deepEqual(await f.store.get(`${f.prefix}${f.subjectId}:task-application-draft:${receipt.taskId}`),application);
});
