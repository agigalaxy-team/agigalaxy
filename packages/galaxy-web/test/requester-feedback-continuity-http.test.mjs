import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {privacyConsumerFixture} from '../../galaxy-official/test/privacy-consumer-continuity-workflow.mjs';
import {createRequesterFeedbackClient,requesterFeedbackAvailable} from '../src/requester-feedback-client.mjs';
import {ServiceError} from '../../galaxy-official/src/shared/service-error.mjs';

// Real Ed25519 Consent, HTTP, Task transactions and PGlite; local Map hooks
// expose precise await boundaries. No browser IDB or production claim.
async function signed(runtime,path,payload,viewers=[]){return runtime.api.call(path,await runtime.api.authorizePayload(payload,{
 action:'assistance.publish',objectId:payload.operationId??payload.eventId,visibility:'Private',viewers,confirmed:true,
}));}
async function work(f){
 const{runtime:requester}=await f.makeOther(),provider=f.runtime,providerId=f.original.subjectId,requesterId=requester.api.snapshot().subjectId;
 const taskId=randomUUID(),participationId=randomUUID(),path=`/v2/participations/${participationId}/events`;
 await signed(requester,'/v2/tasks',{operationId:randomUUID(),taskId,caseId:null,intent:'collaboration',title:'[本地合成] 有限合作反馈',
  summary:'仅测试这次实际确认的参与',workContext:{goal:'记录实际合作',currentSituation:'参与已结束',attemptRefs:[]},visibility:'Private',
  collaboration:'open-assistance',enrollmentExpiresAt:f.now()+86400},[providerId]);
 await signed(requester,`/v2/tasks/${taskId}/participations`,{kind:'propose',eventId:randomUUID(),participationId,expectedTaskVersion:1,
  subjectId:providerId,role:'review',scopeVersion:1,agreedScope:'只复核这个合成例子'},[providerId]);
 await signed(provider,path,{kind:'confirm',eventId:randomUUID(),expectedParticipationVersion:1,scopeVersion:1},[requesterId]);
 await signed(provider,path,{kind:'withdraw',eventId:randomUUID(),expectedParticipationVersion:2,reason:'合成参与结束'},[requesterId]);
 const read=()=>provider.api.call('/v2/tasks/'+taskId,undefined,{method:'GET'}),task=await read(),participant=task.participations[0];
 const client=createRequesterFeedbackClient(provider,taskId,participationId,{subjectId:providerId,now:f.now});
 const draft={descriptionClarity:'partly-clear',scopeMatched:'no',note:'实际范围有需要补充说明的部分。',reason:'',baseFeedbackId:null};
 return{requester,requesterId,provider,providerId,taskId,participationId,path,read,task,participant,client,draft};
}
const businessWrites=(f,w)=>f.requests.filter(row=>row.path===w.path).length;
const consentWrites=f=>f.requests.filter(row=>row.path==='/v1/consents').length;
const events=async(f,w)=>(await f.f.db.query("SELECT id,payload_text,payload_hash FROM task_events WHERE task_id=$1 AND kind='requester-feedback' ORDER BY created_at,id",[w.taskId])).rows;

test('feedback definite business rejection is read in the background; the existing explicit original-content action reuses one event and Consent',async t=>{
 const f=await privacyConsumerFixture();t.after(()=>f.close());const w=await work(f),originalWrite=f.services.assistance.submitParticipationEvent.bind(f.services.assistance);let blocked=true;
 f.services.assistance.submitParticipationEvent=(...args)=>{if(blocked)throw new ServiceError('consent_required',403);return originalWrite(...args);};
 await assert.rejects(w.client.submit(w.task,w.participant,w.draft,{confirmed:true}),{code:'consent_required'});
 const original=await w.provider.getLocal('task-event:'+w.taskId),before=[consentWrites(f),businessWrites(f,w)];
 for(let count=0;count<3;count++){const result=await w.client.resumePending();assert.equal(result.state,'unacknowledged');assert.equal(result.reason,'business-rejected');}
 assert.deepEqual([consentWrites(f),businessWrites(f,w)],before);
 blocked=false;const preview=await w.client.reviewAuthorization();assert.equal(preview.state,'reuse-original-authorization');
 assert.equal(preview.eventId,original.eventId);assert.equal(preview.payloadHash,original.payloadHash);assert.equal(preview.expiresAt,original.authorizationExpiresAt);
 const accepted=await w.client.reauthorize(preview,{confirmed:true});assert.equal(accepted.state,'acknowledged');assert.equal(accepted.eventId,original.eventId);
 assert.deepEqual([consentWrites(f),businessWrites(f,w)],[before[0],before[1]+1]);
 const stored=await events(f,w);assert.equal(stored.length,1);assert.equal(stored[0].payload_text,original.payloadJson);assert.equal(stored[0].payload_hash,original.payloadHash);
 assert.equal(await w.client.readPending(),null);
});

test('one feedback choice links its original journal before HTTP; lost business ACK and later revision preserve exact private history',async t=>{
 const f=await privacyConsumerFixture();t.after(()=>f.close());const w=await work(f);let locator,lose=true;
 f.wireHooks.after=(path,response)=>{if(lose&&path===w.path){lose=false;assert.equal(response.status,200);throw Error('synthetic feedback ACK lost');}};
 await assert.rejects(w.client.submit(w.task,w.participant,w.draft,{confirmed:true,onJournal:async value=>{
  locator=value;const original=await w.provider.getLocal('task-event:'+w.taskId);
  assert.equal(original.eventId,value.eventId);assert.equal(original.payloadHash,value.payloadHash);assert.equal(JSON.parse(original.payloadJson).note,w.draft.note);
  assert.deepEqual(Object.keys(value).sort(),['eventId','kind','participationId','payloadHash','taskId']);
  assert.equal(value.kind,'requester-feedback');assert.equal((await events(f,w)).length,0);
 }}),/feedback ACK lost/);
 const saved=await w.client.readPending();assert.equal(saved.eventId,locator.eventId);assert.equal(saved.expiresAt,f.now()+2591900);
 assert.deepEqual(saved.viewers,[w.providerId,w.requesterId]);assert.equal(saved.payload.supersedes,undefined);
 const before=businessWrites(f,w);await w.provider.connect({confirmed:true});
 assert.equal((await w.client.resumePending()).state,'acknowledged');assert.equal(businessWrites(f,w),before);assert.equal(await w.client.readPending(),null);
 const accepted=await w.client.receiptFor(locator);assert.equal(accepted.eventId,locator.eventId);assert.equal(accepted.participationId,w.participationId);
 assert.equal(accepted.kind,'requester-feedback');assert.equal((await events(f,w)).length,1);
 const task=await w.read(),participant=task.participations[0];assert.equal(participant.feedback.eventId,locator.eventId);
 assert.equal(requesterFeedbackAvailable(task,participant,w.requesterId),false);
 const requesterClient=createRequesterFeedbackClient(w.requester,w.taskId,w.participationId,{subjectId:w.requesterId,now:f.now});
 await assert.rejects(requesterClient.submit(task,participant,w.draft,{confirmed:true}),/实际确认参与/);
 await assert.rejects(w.client.submit(task,participant,{...w.draft,note:'更正内容',baseFeedbackId:locator.eventId},{confirmed:true}));
 const revised=await w.client.submit(task,participant,{descriptionClarity:'clear',scopeMatched:'yes',note:'已核对约定和补充说明。',reason:'先前漏读补充说明。',baseFeedbackId:locator.eventId},{confirmed:true});
 assert.equal(revised.state,'acknowledged');const rows=await events(f,w);assert.equal(rows.length,2);
 const correction=JSON.parse(rows.find(row=>row.id===revised.eventId).payload_text);assert.equal(correction.supersedes,locator.eventId);assert.equal(correction.reason,'先前漏读补充说明。');
 assert.equal(rows.find(row=>row.id===locator.eventId).payload_text,saved.payloadJson);
 const{runtime:reader}=await f.makeOther();await assert.rejects(reader.api.call('/v2/tasks/'+w.taskId,undefined,{method:'GET'}),error=>error.status===404);
 await assert.rejects(reader.api.call('/v2/tasks/receipt',{taskId:w.taskId,eventId:locator.eventId,payloadHash:locator.payloadHash}),error=>error.status===404);
});

test('an absent original Consent after binding change performs zero automatic writes; explicit exact review preserves ID, JSON, hash and valid deadline',async t=>{
 const f=await privacyConsumerFixture();t.after(()=>f.close());const w=await work(f);let block=true;
 f.wireHooks.before=path=>{if(block&&path==='/v1/consents'){block=false;throw Error('synthetic original Consent not received');}};
 await assert.rejects(w.client.submit(w.task,w.participant,w.draft,{confirmed:true}),/not received/);
 const saved=await w.client.readPending(),original=await w.provider.getLocal('task-event:'+w.taskId);await w.provider.connect({confirmed:true});
 const before=[consentWrites(f),businessWrites(f,w)],pending=await w.client.resumePending();
 assert.equal(pending.state,'unacknowledged');assert.equal(pending.reason,'binding-changed');assert.deepEqual([consentWrites(f),businessWrites(f,w)],before);
 const edited=await w.client.reviewAuthorization();edited.expiresAt+=1;
 await assert.rejects(w.client.reauthorize(edited,{confirmed:true}),error=>error.code==='requester_feedback_review_changed');
 assert.deepEqual([consentWrites(f),businessWrites(f,w)],before);
 const preview=await w.client.reviewAuthorization();assert.equal(preview.state,'reauthorization-required');assert.equal(preview.expiresAt,saved.expiresAt);
 let continued;f.wireHooks.before=async path=>{if(path===w.path)continued=await w.provider.getLocal('task-event:'+w.taskId);};
 const accepted=await w.client.reauthorize(preview,{confirmed:true});assert.equal(accepted.state,'acknowledged');assert.equal(accepted.eventId,saved.eventId);
 assert.equal(continued.payloadJson,saved.payloadJson);assert.equal(continued.payloadHash,saved.payloadHash);assert.equal(continued.authorizationExpiresAt,saved.expiresAt);
 assert.equal(continued.authorizationHistory[0].preparedConsent.signedIntent,original.preparedConsent.signedIntent);
 assert.deepEqual([consentWrites(f),businessWrites(f,w)],[before[0]+1,before[1]+1]);assert.equal((await events(f,w)).length,1);
});

test('accepted original Consent survives legitimate rebinding; only aged transport signatures on the same binding renew the original fixed choice',async t=>{
 const f=await privacyConsumerFixture();t.after(()=>f.close());const w=await work(f);let block=true;
 f.wireHooks.before=path=>{if(block&&path===w.path){block=false;throw Error('synthetic business not received');}};
 await assert.rejects(w.client.submit(w.task,w.participant,w.draft,{confirmed:true}),/business not received/);
 const saved=await w.client.readPending(),before=consentWrites(f);await w.provider.connect({confirmed:true});
 assert.equal((await w.client.resumePending()).state,'acknowledged');assert.equal(consentWrites(f),before);assert.equal((await events(f,w))[0].payload_text,saved.payloadJson);
 const task=await w.read(),participant=task.participations[0];block=true;
 f.wireHooks.before=path=>{if(block&&path==='/v1/consents'){block=false;throw Error('synthetic aged original Consent absent');}};
 await assert.rejects(w.client.submit(task,participant,{...w.draft,reason:'更正先前的说明',baseFeedbackId:saved.eventId},{confirmed:true}),/original Consent absent/);
 const second=await w.client.readPending();f.setTime(f.now()+301);f.wireHooks.before=null;
 const renewed=await w.client.resumePending();assert.equal(renewed.state,'acknowledged');assert.equal(renewed.eventId,second.eventId);
 const rows=await events(f,w);assert.equal(rows.length,2);assert.equal(rows.find(row=>row.id===second.eventId).payload_text,second.payloadJson);
 const intent=(await f.f.db.query("SELECT intent FROM consents WHERE intent->>'objectId'=$1",[second.eventId])).rows[0].intent;
 assert.equal(intent.expiresAt,second.expiresAt);assert.equal(intent.bindingId,w.provider.api.snapshot().bindingId);
});

test('callback failure and expired local selection never create another feedback; a different binding invalidates the exact review',async t=>{
 const f=await privacyConsumerFixture();t.after(()=>f.close());const w=await work(f),before=[consentWrites(f),businessWrites(f,w)];
 await assert.rejects(w.client.submit(w.task,w.participant,w.draft,{confirmed:true,onJournal:()=>{throw Error('synthetic local draft conflict');}}),/local draft conflict/);
 const saved=await w.client.readPending();assert.deepEqual([consentWrites(f),businessWrites(f,w)],before);assert.equal((await events(f,w)).length,0);
 await assert.rejects(w.client.submit(w.task,w.participant,w.draft,{confirmed:true}),/上一次操作/);
 // Only this client's clock observes the selection as expired. Current Task
 // grants/service signer remain valid; no database expiry is rewritten.
 const expired=createRequesterFeedbackClient(w.provider,w.taskId,w.participationId,{subjectId:w.providerId,now:()=>saved.expiresAt+1});
 assert.equal((await expired.resumePending()).reason,'authorization-expired');assert.deepEqual([consentWrites(f),businessWrites(f,w)],before);
 const preview=await expired.reviewAuthorization();assert.equal(preview.originalExpiresAt,saved.expiresAt);assert.ok(preview.expiresAt>saved.expiresAt+1);
 await w.provider.connect({confirmed:true});await assert.rejects(expired.reauthorize(preview,{confirmed:true}),error=>error.code==='receipt_status_authority_changed');
 assert.deepEqual([consentWrites(f),businessWrites(f,w)],before);
});

test('revoked original feedback Consent requires exact explicit review; concurrent form saves claim one original before any network write',async t=>{
 const f=await privacyConsumerFixture();t.after(()=>f.close());const w=await work(f);let block=true;
 f.wireHooks.before=path=>{if(block&&path===w.path){block=false;throw Error('synthetic original feedback before business');}};
 await assert.rejects(w.client.submit(w.task,w.participant,w.draft,{confirmed:true}),/before business/);
 const saved=await w.client.readPending(),original=await w.provider.getLocal('task-event:'+w.taskId);
 await w.provider.api.call('/v1/consents/'+original.preparedConsent.intent.id+'/revoke',{});
 const before=[consentWrites(f),businessWrites(f,w)];assert.equal((await w.client.resumePending()).reason,'authorization-revoked');
 assert.deepEqual([consentWrites(f),businessWrites(f,w)],before);const preview=await w.client.reviewAuthorization();
 assert.equal(preview.state,'reauthorization-required');assert.equal(preview.expiresAt,saved.expiresAt);
 assert.equal((await w.client.reauthorize(preview,{confirmed:true})).state,'acknowledged');assert.equal((await events(f,w))[0].payload_text,saved.payloadJson);
 assert.deepEqual([consentWrites(f),businessWrites(f,w)],[before[0]+1,before[1]+1]);
 const task=await w.read(),participant=task.participations[0],draft={...w.draft,baseFeedbackId:saved.eventId,reason:'准确修订合成说明。'},
 second=createRequesterFeedbackClient(w.provider,w.taskId,w.participationId,{subjectId:w.providerId,now:f.now});
 let claimed=0;const onJournal=()=>{claimed++;throw Error('synthetic local attach not completed');},count=[consentWrites(f),businessWrites(f,w)];
 const attempted=await Promise.allSettled([w.client.submit(task,participant,draft,{confirmed:true,onJournal}),second.submit(task,participant,draft,{confirmed:true,onJournal})]);
 assert.equal(attempted.filter(row=>row.status==='rejected').length,2);assert.equal(claimed,1);
 assert.deepEqual([consentWrites(f),businessWrites(f,w)],count);assert.equal((await w.client.readPending()).payload.supersedes,saved.eventId);
 assert.equal((await events(f,w)).length,1);
});
