import test from 'node:test';
import assert from 'node:assert/strict';
import {publicationFixture} from '../../galaxy-official/test/task-publication-continuity-fixture.mjs';
import {ServiceError} from '../../galaxy-official/src/shared/service-error.mjs';

// Real signed Consent/HTTP/current Task service/PGlite. Only the explicitly
// controlled service-admission failure and local Map store are test doubles.
function admission(f, method = 'createTask', status = 403) {
 const original = f.f.assistance[method].bind(f.f.assistance), control = {blocked:true,status};
 f.f.assistance[method] = (...args) => {
  if(control.blocked)throw new ServiceError(control.status===403?'consent_required':'service_temporarily_unavailable',control.status);
  return original(...args);
 };
 return control;
}
async function rows(f, eventId) {
 return (await f.f.db.query('SELECT id,subject_id,payload_text,payload_hash,consent_id FROM task_events WHERE id=$1',[eventId])).rows;
}
const sameOriginal = (current, original) => {
 assert.equal(current.payloadJson,original.payloadJson);assert.equal(current.payloadHash,original.payloadHash);
 assert.equal(current.payload?.operationId??current.eventId,original.payload?.operationId??original.eventId);
 assert.deepEqual(current.submission,original.submission);assert.equal(current.preparedConsent.signedIntent,original.preparedConsent.signedIntent);
 assert.equal(current.authorizationExpiresAt,original.authorizationExpiresAt);
};

test('definite publication rejection persists the original and blocks automatic and legacy retry; one explicit continuation preserves a later draft',async t=>{
 const f=await publicationFixture();t.after(()=>f.close());const failure=admission(f),draft=f.runtime.createTaskDraftClient();t.after(()=>draft.close());
 await draft.load();const first=await draft.save({title:f.draft.title,summary:f.draft.summary});
 await assert.rejects(f.runtime.publishTask(f.draft,{confirmed:true,draftHead:first.head}),{code:'consent_required',status:403,outcome:'rejected'});
 const original=await f.runtime.getLocal('task-publication'),before={...f.counts};
 assert.equal(original.state,'business-rejected');assert.equal(original.automaticRetryBlock.code,'consent_required');assert.ok(original.automaticRetryBlock.rejectedAt);
 for(let count=0;count<3;count++)await assert.rejects(f.runtime.resumePublication(),{code:'publication_business_rejected',reason:'consent_required',status:403});
 await assert.rejects(f.runtime.reconcilePublication({retry:true}),{code:'publication_business_rejected'});
 assert.equal(f.counts.publications,before.publications);assert.equal(f.counts.consents,before.consents);assert.ok(f.counts.receipts>before.receipts);
 sameOriginal(await f.runtime.getLocal('task-publication'),original);
 const later=await draft.save({title:'A later unsent edit'});failure.blocked=false;
 await assert.rejects(f.runtime.resumePublication(),{code:'publication_business_rejected'});
 const accepted=await f.runtime.resumePublication({explicitRetry:true});assert.equal(accepted.state,'acknowledged');assert.equal(accepted.eventId,original.payload.operationId);
 assert.equal(accepted.payloadHash,original.payloadHash);assert.equal(accepted.localDraftCleanup.state,'retained');
 assert.equal(f.counts.publications,before.publications+1);assert.equal(f.counts.consents,before.consents);
 const stored=await rows(f,original.payload.operationId);assert.equal(stored.length,1);assert.equal(stored[0].payload_text,original.payloadJson);
 assert.equal(stored[0].payload_hash,original.payloadHash);assert.equal(stored[0].consent_id,original.submission.consentId);
 assert.equal((await draft.load()).head.revision,later.head.revision);assert.equal((await draft.load()).value.title,'A later unsent edit');
 assert.equal(await f.runtime.getLocal('task-publication'),null);
});

test('an exact accepted business receipt takes priority over a persisted rejection and retires only the original draft revision',async t=>{
 const f=await publicationFixture();t.after(()=>f.close());const failure=admission(f),draft=f.runtime.createTaskDraftClient();t.after(()=>draft.close());
 await draft.load();const saved=await draft.save({title:f.draft.title});
 await assert.rejects(f.runtime.publishTask(f.draft,{confirmed:true,draftHead:saved.head}),{code:'consent_required'});
 const original=await f.runtime.getLocal('task-publication');failure.blocked=false;
 await f.runtime.api.call('/v2/tasks',original.submission);const before={...f.counts};
 const accepted=await f.runtime.resumePublication();assert.equal(accepted.state,'acknowledged');assert.equal(accepted.eventId,original.payload.operationId);
 assert.equal(accepted.localDraftCleanup.state,'cleared');assert.equal(f.counts.publications,before.publications);assert.equal(f.counts.consents,before.consents);
 assert.equal(await draft.load(),null);assert.equal((await rows(f,original.payload.operationId)).length,1);
});

test('network loss and HTTP 5xx still automatically resume the same publication; lost accepted ACK is read without another business POST',async t=>{
 const f=await publicationFixture();t.after(()=>f.close());const failure=admission(f,'createTask',503);
 await assert.rejects(f.runtime.publishTask(f.draft,{confirmed:true}),{status:503});
 const original=await f.runtime.getLocal('task-publication'),before={...f.counts};assert.equal(original.automaticRetryBlock,undefined);
 failure.blocked=false;const accepted=await f.runtime.resumePublication();assert.equal(accepted.state,'acknowledged');assert.equal(accepted.eventId,original.payload.operationId);
 assert.equal(f.counts.consents,before.consents);assert.equal(f.counts.publications,before.publications+1);assert.equal((await rows(f,original.payload.operationId))[0].payload_text,original.payloadJson);
 f.hooks.loseAck=true;await assert.rejects(f.runtime.publishTask({...f.draft,title:'Another explicit original choice'},{confirmed:true}),/lost task publication ACK/);
 const lost=await f.runtime.getLocal('task-publication'),after={...f.counts};assert.equal(lost.automaticRetryBlock,undefined);
 const recovered=await f.runtime.resumePublication();assert.equal(recovered.state,'acknowledged');assert.equal(recovered.eventId,lost.payload.operationId);
 assert.equal(f.counts.publications,after.publications);assert.equal(f.counts.consents,after.consents);assert.equal((await rows(f,lost.payload.operationId)).length,1);
});

test('a definite Task event rejection blocks automatic and legacy retry, then explicitly continues one original event and Consent',async t=>{
 const f=await publicationFixture();t.after(()=>f.close());const task=await f.runtime.publishTask(f.draft,{confirmed:true}),failure=admission(f,'submitTaskEvent');
 const path=`/v2/tasks/${task.taskId}/events`,calls=[];f.hooks.response=(target,response)=>calls.push({target,status:response.status});
 await assert.rejects(f.runtime.taskEvent(task.taskId,{kind:'stop-enrollment',expectedTaskVersion:1,reason:'Explicitly end the synthetic enrollment'},{confirmed:true}),{code:'consent_required'});
 const original=await f.runtime.getLocal('task-event:'+task.taskId),writes=()=>calls.filter(row=>row.target===path).length,before={business:writes(),consents:f.counts.consents};
 for(let count=0;count<3;count++)await assert.rejects(f.runtime.resumeTaskEvent(task.taskId),{code:'task_operation_business_rejected',reason:'consent_required'});
 await assert.rejects(f.runtime.reconcileTaskEvent(task.taskId,{retry:true}),{code:'task_operation_business_rejected'});
 assert.equal(writes(),before.business);assert.equal(f.counts.consents,before.consents);sameOriginal(await f.runtime.getLocal('task-event:'+task.taskId),original);
 failure.blocked=false;const accepted=await f.runtime.resumeTaskEvent(task.taskId,{explicitRetry:true,expectedEventId:original.eventId,expectedPayloadHash:original.payloadHash});
 assert.equal(accepted.state,'acknowledged');assert.equal(accepted.eventId,original.eventId);assert.equal(accepted.payloadHash,original.payloadHash);
 assert.equal(writes(),before.business+1);assert.equal(f.counts.consents,before.consents);
 const stored=await rows(f,original.eventId);assert.equal(stored.length,1);assert.equal(stored[0].payload_text,original.payloadJson);assert.equal(stored[0].consent_id,original.submission.consentId);
});

test('HTTP 408 and 429 do not become permanent business-rejection blockers',async t=>{
 const f=await publicationFixture();t.after(()=>f.close());const failure=admission(f,'createTask',408);
 for(const status of [408,429]){
  failure.status=status;await assert.rejects(f.runtime.publishTask({...f.draft,title:'Synthetic response '+status},{confirmed:true}),{status});
  const original=await f.runtime.getLocal('task-publication');assert.equal(original.automaticRetryBlock,undefined);
  failure.blocked=false;assert.equal((await f.runtime.resumePublication()).state,'acknowledged');
  assert.equal((await rows(f,original.payload.operationId)).length,1);failure.blocked=true;
 }
});
