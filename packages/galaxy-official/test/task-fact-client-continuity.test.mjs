import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {getFactClient} from "../../galaxy-web/src/features/work-records/client.mjs";
import {factContinuityFixture,deferred,outcome,intervention} from "./task-fact-client-continuity-workflow.mjs";
const hash=v=>createHash('sha256').update(v).digest('hex');
const changed=e=>e.code==='fact_authority_changed';
const consents=h=>h.calls.filter(c=>c.path==='/v1/consents').length;
const privateText='PRIVATE FICTIONAL';
const minimal=r=>{
 assert.equal(r.currentAccessGranted,false);assert.equal(r.authority,'accepted-operation-only');
 assert.equal(JSON.stringify(r).includes(privateText),false);assert.equal('current' in r,false);
};
const input={confirmed:true,viewers:[]};
async function unknownEvidence(h,task,mode='after'){
 h.fault('/v2/verification-records/submit',mode);
 await assert.rejects(h.client.submitRecord(task,{synthetic:true},null,h.fields(),input),e=>e.resultUnknown===true);
 return h.pendingRaw(task.taskId);
}

test('original Verification accepted and Evidence undispatched recover by metadata after source/Consent revoke with zero resend',async()=>{
 const h=await factContinuityFixture();try{
  const a=await h.seedTask(),b=await h.seedTask(),facts=await h.client.readCase(a);
  const produced=await h.client.submitFact(a,facts,null,{kind:'result-recorded',origin:{kind:'intervention',id:facts.interventions[0].id,version:1},
   scopeVersion:1,deliverableRefs:[],reportedOutcome:'partial',summary:'FICTIONAL bounded diagnostic result',limitations:'Synthetic',supersedes:null},input);
  const evidence=await h.client.submitRecord(a,{synthetic:true},null,h.fields(),input);
  h.fault('/v2/verification-records/submit','after');
  await assert.rejects(h.client.submitRecord(a,{synthetic:true},null,{kind:'verification',expectedVersion:0,
   target:{type:'result',...produced.objectRef},scopeVersion:1,method:'local-test',scope:'Fictional bounded scope',
   conditions:{environment:'synthetic'},observation:'inconclusive',summary:privateText+' limited check',
   evidenceRefs:[{id:evidence.id,version:evidence.version}],relationship:'same-controller',
   observedAt:new Date(h.f.now*1000).toISOString(),synthetic:true},input),e=>e.resultUnknown===true);
  const accepted=await h.pendingRaw(a.taskId),absent=await unknownEvidence(h,b,'before'),saved=[accepted,absent];
  const prior=await h.original(accepted.operationId);
  for(const [i,record] of saved.entries()){
   await h.runtime.api.call('/v1/consents/'+record.items[0].submission.consentId+'/revoke',{});
   await h.revokeRoot([a,b][i]);
  }
  const c=consents(h),w=h.bodyWrites().length;
  const acknowledged=await h.client.reconcile(a.taskId),unsubmitted=await h.client.reconcile(b.taskId);
  assert.equal(acknowledged.state,'acknowledged');assert.equal(unsubmitted.state,'absent');minimal(acknowledged);minimal(unsubmitted);
  assert.equal(acknowledged.operationId,accepted.operationId);assert.equal(acknowledged.payloadHash,hash(accepted.items[0].submission.payloadJson));
  assert.deepEqual(await h.original(accepted.operationId),prior);assert.equal(await h.original(absent.operationId),undefined);
  assert.equal(consents(h),c);assert.equal(h.bodyWrites().length,w);
  assert.equal(await h.client.pending(a.taskId),null);assert.equal((await h.client.pending(b.taskId)).operationId,absent.operationId);
  assert.equal((await h.client.reconcile(a.taskId,{retry:true,confirmed:true})).state,'acknowledged');
  assert.equal(h.bodyWrites().length,w);assert.equal(consents(h),c);
  assert.equal(JSON.stringify(await h.archive(a.taskId)).includes('payloadJson'),false);
 }finally{await h.close();}
});

test('Case-link and later Case events use their exact original receipts without current Case body',async()=>{
 const h=await factContinuityFixture();try{
  const a=await h.seedTask(false);h.fault('/v2/tasks/'+a.taskId+'/case','after');
  await assert.rejects(h.client.submitFact(a,null,null,intervention(),{...input,caseSummary:'FICTIONAL link',synthetic:true}));
  const linked=await h.pendingRaw(a.taskId);
  for(const i of linked.items)await h.runtime.api.call('/v1/consents/'+i.submission.consentId+'/revoke',{});
  const c=consents(h),w=h.bodyWrites().length,firstCall=h.calls.length;
  const linkReceipt=await h.client.reconcile(a.taskId);assert.equal(linkReceipt.state,'acknowledged');minimal(linkReceipt);
  assert.equal(linkReceipt.caseId,linked.caseId);assert.equal(linkReceipt.payloadHash,linked.payloadHash);
  assert.equal(h.calls.slice(firstCall).some(c=>c.path.endsWith('/read')),false);
  assert.equal(consents(h),c);assert.equal(h.bodyWrites().length,w);
  const b=await h.seedTask(),facts=await h.client.readCase(b);h.fault('/v2/cases/events','after');
  await assert.rejects(h.client.submitFact(b,facts,null,intervention(),input));
  const fact=await h.pendingRaw(b.taskId);await h.runtime.api.call('/v1/consents/'+fact.items[0].submission.consentId+'/revoke',{});
  const c2=consents(h),w2=h.bodyWrites().length,secondCall=h.calls.length;
  const event=await h.client.reconcile(b.taskId);assert.equal(event.state,'acknowledged');minimal(event);
  assert.equal(event.receipt.eventId,fact.operationId);assert.equal(event.payloadHash,hash(fact.items[0].submission.payloadJson));
  assert.equal(h.calls.slice(secondCall).some(c=>c.path.endsWith('/read')),false);
  assert.equal(consents(h),c2);assert.equal(h.bodyWrites().length,w2);
 }finally{await h.close();}
});

test('storage waiting and queued confirmation retain the enqueue same-GUID connection with zero new Consent/fact',async()=>{
 for(const stage of ['read','queue']){
  const h=await factContinuityFixture(),entered=deferred(),release=deferred();try{
   const task=await h.seedTask(false),original=h.runtime.api.snapshot();h.calls.length=0;let blocked=false;
   h.onGet(async key=>{if(!blocked&&key.includes('task-fact-pending:')){blocked=true;entered.resolve();await release.promise;}});
   const first=stage==='read'?outcome(h.client.submitFact(task,null,null,intervention(),{...input,caseSummary:'FICTIONAL new Case',synthetic:true})):
    outcome(h.client.reconcile(task.taskId));
   await entered.promise;const second=stage==='queue'?outcome(h.client.submitFact(task,null,null,intervention(),
    {...input,caseSummary:'FICTIONAL queued Case',synthetic:true})):null;
   await h.runtime.connect({confirmed:true});release.resolve();
   for(const settled of await Promise.all(second?[first,second]:[first]))assert.ok(changed(settled.error));
   assert.equal(h.runtime.api.snapshot().subjectId,original.subjectId);assert.ok(h.runtime.api.snapshot().generation>original.generation);
   assert.equal(consents(h),0);assert.equal(h.bodyWrites().length,0);
  }finally{release.resolve();await h.close();}
 }
});

test('Consent and durable storage completion cannot dispatch on a replacement connection; pending metadata remains original',async()=>{
 for(const stage of ['consent','write']){
  const h=await factContinuityFixture();try{
   const task=await h.seedTask(),original=h.runtime.api.snapshot();let switched=false;h.calls.length=0;
   const r=stage==='consent'?{...h.runtime,api:{...h.runtime.api,submitAuthorization:async(...args)=>{
    const value=await h.runtime.api.submitAuthorization(...args);if(!switched){switched=true;await h.runtime.connect({confirmed:true});}return value;}}}:h.runtime;
   if(stage==='write')h.onPut(async(key,value)=>{if(!switched&&key.includes('task-fact-pending:')&&value?.state==='prepared'){
    switched=true;await h.runtime.connect({confirmed:true});}});
   const client=getFactClient(r,h.subjectId);
   await assert.rejects(client.submitRecord(task,{synthetic:true},null,h.fields(),input),changed);
   assert.equal(switched,true);assert.equal(h.bodyWrites().length,0);assert.equal(consents(h),stage==='consent'?1:0);
   const pending=await client.pending(task.taskId);assert.ok(pending.payloadHash);
   assert.equal((await client.reconcile(task.taskId)).state,'absent');
   assert.ok(h.runtime.api.snapshot().generation>original.generation);
  }finally{await h.close();}
 }
});

test('absent requires a fresh exact preview after rebind; no implicit Consent and duplicate confirmation dispatches only once',async()=>{
 const h=await factContinuityFixture();try{
  const task=await h.seedTask(),before=await unknownEvidence(h,task,'before'),bytes=before.items[0].submission.payloadJson;
  await h.runtime.connect({confirmed:true});const c=consents(h),w=h.bodyWrites().length;
  await assert.rejects(h.client.reconcile(task.taskId,{retry:true,confirmed:true}),e=>e.code==='fact_reauthorization_review_required');
  assert.equal(consents(h),c);assert.equal(h.bodyWrites().length,w);
  const preview=await h.client.prepareRetry(task.taskId);
  assert.equal(preview.operationId,before.operationId);assert.equal(preview.items[0].payloadJson,bytes);
  assert.equal(preview.payloadHash,hash(bytes));assert.deepEqual(preview.viewers,[]);
  await assert.rejects(h.client.confirmRetry(preview),e=>e.code==='fact_confirmation_required');
  await assert.rejects(h.client.confirmRetry({...preview,viewers:[h.f.actor.subjectId]},{confirmed:true}),e=>e.code==='fact_retry_preview_changed');
  assert.equal(consents(h),c);assert.equal(h.bodyWrites().length,w);
  await h.runtime.connect({confirmed:true});
  await assert.rejects(h.client.confirmRetry(preview,{confirmed:true}),changed);
  const renewed=await h.client.prepareRetry(task.taskId);
  assert.equal(renewed.operationId,preview.operationId);assert.equal(renewed.payloadHash,preview.payloadHash);assert.equal(renewed.items[0].payloadJson,bytes);
  const results=await Promise.allSettled([h.client.confirmRetry(renewed,{confirmed:true}),h.client.confirmRetry(renewed,{confirmed:true})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(h.bodyWrites().length,w+1);assert.equal(consents(h),c+1);
  const accepted=await h.original(before.operationId);
  assert.equal(accepted.payload_text,bytes);assert.equal(accepted.payload_hash,preview.payloadHash);
  assert.equal((await h.client.reconcile(task.taskId)).state,'acknowledged');assert.equal(await h.client.pending(task.taskId),null);
 }finally{await h.close();}
});

test('late accepted ACK and terminal journal completion remain original-owner metadata and are withheld from a new owner',async()=>{
 for(const stage of ['ack-owner','terminal-rebind']){
  const h=await factContinuityFixture();try{
   const task=await h.seedTask();let switched=false;h.calls.length=0;
   const r=stage==='ack-owner'?{...h.runtime,api:{...h.runtime.api,call:async(...args)=>{
    const value=await h.runtime.api.call(...args);if(args[0]==='/v2/verification-records/submit'&&!switched){
     switched=true;await h.switchOwner();}return value;}}}:h.runtime;
   if(stage==='terminal-rebind')h.onPut(async(key,value)=>{if(!switched&&key.includes('task-fact-pending:')&&value===null){
    switched=true;await h.runtime.connect({confirmed:true});}});
   const client=getFactClient(r,h.subjectId);
   await assert.rejects(client.submitRecord(task,{synthetic:true},null,h.fields(),input),changed);
   assert.equal(switched,true);assert.equal(h.bodyWrites().length,1);const archive=await h.archive(task.taskId);
   const accepted=archive.find(r=>r.kind==='verification');assert.ok(accepted);assert.equal(accepted.state,'acknowledged');
   assert.equal(JSON.stringify(archive).includes(privateText),false);assert.equal(JSON.stringify(archive).includes('payloadJson'),false);
   assert.equal(accepted.subjectId,h.subjectId);assert.ok(await h.original(accepted.operationId));
   if(stage==='ack-owner'){
    assert.notEqual(h.runtime.api.snapshot().subjectId,h.subjectId);
    assert.equal(await getFactClient(h.runtime,h.runtime.api.snapshot().subjectId).pending(task.taskId),null);
   }else{
    const c=consents(h),w=h.bodyWrites().length;
    assert.equal((await client.reconcile(task.taskId)).state,'acknowledged');assert.equal(consents(h),c);assert.equal(h.bodyWrites().length,w);
   }
  }finally{await h.close();}
 }
});

test('null-to-null lifecycle ABA cannot return old pending metadata after local storage waiting',async()=>{
 const h=await factContinuityFixture(),entered=deferred(),release=deferred();try{
  const task=await h.seedTask();await unknownEvidence(h,task,'before');h.runtime.api.disconnect();
  let blocked=false;h.onGet(async key=>{if(!blocked&&key.includes('task-fact-pending:')){blocked=true;entered.resolve();await release.promise;}});
  const reading=outcome(h.client.pending(task.taskId));await entered.promise;h.runtime.api.disconnect();release.resolve();
  const settled=await reading;assert.ok(changed(settled.error));assert.equal(settled.value,undefined);
 }finally{release.resolve();await h.close();}
});

test('offline unknown stop stores only original locator and later reads accepted receipt with zero writes',async()=>{
 const h=await factContinuityFixture();try{
  const task=await h.seedTask(),original=await unknownEvidence(h,task,'after'),c=consents(h),w=h.bodyWrites().length;
  h.offline(true);assert.equal((await h.client.reconcile(task.taskId,{retry:true,confirmed:true})).state,'result-unknown');
  const stopped=await h.client.stopRetry(task.taskId,{confirmed:true});
  assert.equal(stopped.localRetryStopped,true);assert.equal(stopped.serverCancellationConfirmed,false);
  assert.equal(stopped.receiptState,'result-unknown');assert.equal(await h.pendingRaw(task.taskId),null);
  const archive=await h.archive(task.taskId),locator=archive.find(r=>r.operationId===original.operationId);assert.ok(locator);
  assert.equal(locator.payloadHash,hash(original.items[0].submission.payloadJson));
  assert.equal(JSON.stringify(archive).includes('payloadJson'),false);assert.equal(JSON.stringify(archive).includes('signedIntent'),false);
  await assert.rejects(h.client.submitRecord(task,{synthetic:true},null,h.fields(),input),e=>e.code==='fact_pending');
  h.offline(false);await h.runtime.connect({confirmed:true});
  const ack=await h.client.reconcile(task.taskId);assert.equal(ack.state,'acknowledged');minimal(ack);
  assert.equal(ack.receiptState,'acknowledged');assert.equal(consents(h),c);assert.equal(h.bodyWrites().length,w);
  assert.equal(await h.client.pending(task.taskId),null);
 }finally{await h.close();}
});
