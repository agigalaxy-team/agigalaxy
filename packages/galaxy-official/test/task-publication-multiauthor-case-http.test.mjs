import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {publicationFixture} from './task-publication-continuity-fixture.mjs';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {digest} from '../src/shared/digest.mjs';

async function multipleAuthors({peerReadable=true}={}) {
 const f=await publicationFixture(),now=f.f.now,peer=await serviceFixture(['binding','consent','case-teaser','assistance'],f.f.db,{now,migrateDatabase:false});
 const api=createApi({...f.f,rateLimit:1000});await new Promise(done=>api.listen(0,'127.0.0.1',done));
 const origin='http://127.0.0.1:'+api.address().port,owner=(await f.runtime.status()).identity.subjectId;
 async function peerCall(path,payload){const response=await fetch(origin+path,{method:'POST',headers:{authorization:'Bearer '+peer.credential,'content-type':'application/json'},body:JSON.stringify(payload)}),value=await response.json();
  if(!response.ok)throw Object.assign(Error(value.error),{code:value.error,status:response.status});return value;}
 async function grant(who,payload,action,viewers){
  const objectId=payload.operationId??payload.eventId;
  if(who==='owner')return f.runtime.api.authorizePayload(payload,{action,objectId,visibility:'Private',viewers,confirmed:true});
  const payloadJson=JSON.stringify(payload),intent={version:1,id:randomUUID(),subjectId:peer.actor.subjectId,bindingId:peer.actor.bindingId,
   endpoint:peer.access.endpoint,objectId,action,purpose:'operational',recipient:peer.access.endpoint,fields:Object.keys(payload),visibility:'Private',viewers,
   payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:now,expiresAt:now+3600};
  await peerCall('/v1/consents',{signedIntent:await peer.signForTest(JSON.stringify(intent),'galaxy-consent+jws')});
  return{consentId:intent.id,payloadJson};
 }
 const taskId=randomUUID(),caseId=randomUUID(),participationId=randomUUID(),task={...f.draft,operationId:randomUUID(),taskId};
 const close=async()=>{api.closeAllConnections();await new Promise(done=>api.close(done));await f.close();};
 try{
  await f.runtime.api.call('/v2/tasks',await grant('owner',task,'assistance.publish',[peer.actor.subjectId]));
  const root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:owner,taskId,localRef:randomUUID(),
   title:'FICTIONAL two-author original work',summary:'Only synthetic scoped work',source:{kind:'active-task',reference:taskId},synthetic:true};
  const attempt={schemaVersion:2,kind:'attempt-start',eventId:randomUUID(),caseId,expectedVersion:1,actorId:owner,taskId,role:'implementation',
   strategy:'Synthetic first inspection',configurationRef:null,inputScopeSummary:'Only synthetic text',permissionScope:['selected-context']};
  await f.runtime.api.call(`/v2/tasks/${taskId}/case`,{operationId:randomUUID(),expectedTaskVersion:1,
   case:await grant('owner',root,'case.teaser.publish',[peer.actor.subjectId]),initialFact:await grant('owner',attempt,'case.teaser.publish',[peer.actor.subjectId])});
  let caseVersion=2;
  const append=async(who,kind,extra,viewers)=>{const event={schemaVersion:2,kind,eventId:randomUUID(),caseId,expectedVersion:caseVersion,actorId:who==='owner'?owner:peer.actor.subjectId,taskId,...extra},submission=await grant(who,event,'case.teaser.publish',viewers);
   if(who==='owner')await f.runtime.api.call('/v2/cases/events',submission);else await peerCall('/v2/cases/events',submission);caseVersion++;return{event,submission};};
  await append('owner','attempt-end',{attemptRef:{id:attempt.eventId,version:1},status:'completed',reportedOutcome:'partial',summary:'Synthetic limited result',failureReason:'One paragraph remains'},[peer.actor.subjectId]);
  await append('owner','attempt-correct',{attemptRef:{id:attempt.eventId,version:2},status:'completed',reportedOutcome:'partial',summary:'Accurate synthetic correction',failureReason:'One scope remains',reason:'Correct a missed qualifier'},[peer.actor.subjectId]);
  const proposal={kind:'propose',eventId:randomUUID(),expectedTaskVersion:1,participationId,subjectId:peer.actor.subjectId,role:'review',scopeVersion:1,agreedScope:'Only fictional text review'};
  await f.runtime.api.call(`/v2/tasks/${taskId}/participations`,await grant('owner',proposal,'assistance.publish',[peer.actor.subjectId]));
  await peerCall(`/v2/participations/${participationId}/events`,await grant('peer',{kind:'confirm',eventId:randomUUID(),expectedParticipationVersion:1,scopeVersion:1},'assistance.publish',[owner]));
  const peerViewers=peerReadable?[owner]:[],peerStart=await append('peer','attempt-start',{participationId,role:'review',strategy:'Fictional peer inspection',configurationRef:null,inputScopeSummary:'Only agreed text',permissionScope:['selected-context']},peerViewers);
  const peerEnd=await append('peer','attempt-end',{participationId,attemptRef:{id:peerStart.event.eventId,version:1},status:'completed',reportedOutcome:'succeeded',summary:'Fictional peer result',failureReason:'No other files inspected'},peerViewers);
  return{...f,peer,peerCall,close,caseId,taskId,owner,peerEnd,sourceRows:await f.f.db.query('SELECT id,subject_id,payload_text,payload_hash FROM case_events WHERE case_id=$1 ORDER BY version',[caseId]),
   next:{...f.draft,caseId,workContext:{...f.draft.workContext,attemptRefs:[{id:attempt.eventId,version:3},{id:peerStart.event.eventId,version:2}]}}};
 }catch(error){await close();throw error;}
}

test('multiple actual authors in an owned Case can publish exact selected attempt versions and read a lost original ACK',async()=>{
 const f=await multipleAuthors();try{
  f.hooks.loseAck=true;await assert.rejects(f.runtime.publishTask(f.next,{confirmed:true}),/lost task publication ACK/);
  const original=await f.runtime.getLocal('task-publication'),before={...f.counts};
  const receipt=await f.runtime.resumePublication();assert.equal(receipt.state,'acknowledged');assert.equal(receipt.eventId,original.payload.operationId);
  assert.equal(receipt.payloadHash,original.payloadHash);assert.equal(f.counts.publications,before.publications);assert.equal(f.counts.consents,before.consents);
  const rows=(await f.f.db.query('SELECT subject_id,payload_text,payload_hash,consent_id FROM task_events WHERE id=$1',[original.payload.operationId])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].subject_id,f.owner);assert.equal(rows[0].payload_text,original.payloadJson);assert.equal(rows[0].payload_hash,original.payloadHash);assert.equal(rows[0].consent_id,original.submission.consentId);
  const current=await f.runtime.api.call(`/v2/tasks/${original.payload.taskId}`,undefined,{method:'GET'});assert.deepEqual(current.request.workContext.attemptRefs,f.next.workContext.attemptRefs);
  assert.deepEqual((await f.f.db.query('SELECT id,subject_id,payload_text,payload_hash FROM case_events WHERE case_id=$1 ORDER BY version',[f.caseId])).rows,f.sourceRows.rows);
 }finally{await f.close();}
});

test('publication still rejects a selected peer attempt that is not currently readable by the Case owner',async()=>{
 const f=await multipleAuthors({peerReadable:false});try{
  await assert.rejects(f.runtime.publishTask(f.next,{confirmed:true}),{code:'origin_not_authorized'});
  const original=await f.runtime.getLocal('task-publication');assert.ok(original.submission);assert.equal((await f.runtime.reconcilePublication()).state,'absent');
  assert.equal((await f.f.db.query('SELECT id FROM task_events WHERE id=$1',[original.payload.operationId])).rows.length,0);
  assert.equal(JSON.stringify(f.next.workContext.attemptRefs),JSON.stringify(original.payload.workContext.attemptRefs));
 }finally{await f.close();}
});

test('publication still rejects revoked original peer Consent and preserves the unaccepted original ID and JSON',async()=>{
 const f=await multipleAuthors();try{
  await f.peerCall(`/v1/consents/${f.peerEnd.submission.consentId}/revoke`,{});
  await assert.rejects(f.runtime.publishTask(f.next,{confirmed:true}),{code:'consent_required'});
  const original=await f.runtime.getLocal('task-publication');assert.ok(original.preparedConsent);assert.ok(original.submission);
  assert.equal((await f.runtime.reconcilePublication()).state,'absent');
  const kept=await f.runtime.getLocal('task-publication');assert.equal(kept.payloadJson,original.payloadJson);assert.equal(kept.payloadHash,original.payloadHash);assert.equal(kept.payload.operationId,original.payload.operationId);
  assert.equal((await f.f.db.query('SELECT id FROM task_events WHERE id=$1',[original.payload.operationId])).rows.length,0);
  assert.deepEqual((await f.f.db.query('SELECT id,subject_id,payload_text,payload_hash FROM case_events WHERE case_id=$1 ORDER BY version',[f.caseId])).rows,f.sourceRows.rows);
 }finally{await f.close();}
});
