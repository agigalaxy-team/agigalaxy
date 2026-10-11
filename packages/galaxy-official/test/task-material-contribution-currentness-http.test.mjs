import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {materialTask} from './task-material-fixture.mjs';
import {digest} from '../src/shared/digest.mjs';
import {HonorService} from '../src/honor.mjs';
import {HonorV2Service} from '../src/honor-v2.mjs';
import {taskMaterialCaseContainerTitle,taskCaseContainerSummary} from '../src/shared/cases-schema.mjs';

// Actual signed HTTP/PGlite and the existing isolated OIDC provider. These
// checks do not assert a real browser, host deployment or model execution.
async function authorize(f,who,payload,action,{viewers=[],visibility='Private',expiresAt=f.clock.now+3600}={}){
 const payloadJson=JSON.stringify(payload),intent={version:1,id:randomUUID(),subjectId:who.actor.subjectId,
  bindingId:who.actor.bindingId,endpoint:who.access.endpoint,action,objectId:payload.eventId??payload.id,
  purpose:visibility==='Public'?'public-profile':'operational',recipient:who.access.endpoint,fields:Object.keys(payload),
  visibility,viewers,payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:f.clock.now,expiresAt};
 const signedIntent=await who.signForTest(JSON.stringify(intent),'galaxy-consent+jws');
 const consent=await f.ok('/v1/consents',{who,input:{signedIntent}});
 return {consentId:consent.consentId,payloadJson};
}
async function create(f,{viewers=[],capabilityId}={}){
 const p=await materialTask(f),request={...p.request,visibility:'Private',...(capabilityId?{capabilityId}:{})},payloadJson=JSON.stringify(request),
  intent={...p.intent,purpose:'operational',visibility:'Private',viewers,fields:Object.keys(request),payloadHash:digest(payloadJson)},
  input={...p.input,payloadJson,signedIntent:await f.owner.signForTest(JSON.stringify(intent),'galaxy-consent+jws')};
 await f.ok('/v2/tasks',{input});return {...p,request,input,intent};
}
const source=(p,fields)=>({kind:'task-event',id:p.request.operationId,eventVersion:1,payloadHash:digest(p.input.payloadJson),fields});
async function publish(f,who,sourceRefs,{expiresAt=f.clock.now+500}={}){
 const payload={id:randomUUID(),kind:'publish',sourceRefs,purposes:['honor','requester-history'],
  purpose:'public-contribution-projections-only',expiresAt:new Date(expiresAt*1000).toISOString(),redactionConfirmed:true,
  publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'},
  input=await authorize(f,who,payload,'contribution.publish',{visibility:'Public',expiresAt});
 await f.ok('/v2/contributions/publish',{who,input});return {payload,input};
}
const committedState=db=>db.query(`SELECT (SELECT count(*)::int FROM consents) AS consents,
 (SELECT count(*)::int FROM task_events) AS events,(SELECT count(*)::int FROM contribution_publications) AS publications,
 (SELECT jsonb_agg(jsonb_build_object('id',id,'payload',payload_text,'hash',payload_hash) ORDER BY id) FROM task_events) AS originals`);
const publicRead=(f,p,purpose='honor')=>f.ok('/v2/contributions/read',{authorization:false,input:{source:{
 kind:'task-event',id:p.request.operationId,eventVersion:1,payloadHash:digest(p.input.payloadJson)},purpose}});

test('selected contribution and requester-history fields use current material text without unselected content, locators or writes',async()=>{
 const f=await communityForumFixture();try{
  const p=await create(f),selected=source(p,['eventType','actorId','title']),preview=await f.ok('/v2/contributions/preview',
   {input:{sourceRefs:[selected],purposes:['honor','requester-history']}});
  assert.equal(preview.items[0].projection.title,p.post.title);
  assert.deepEqual(Object.keys(preview.items[0].projection.textView.fields),['title']);
  assert.equal(preview.items[0].projection.taskId,undefined);assert.equal(preview.items[0].projection.summary,undefined);
  for(const hidden of [p.post.body,p.request.taskId,p.prepared.descriptors[1].materialId])assert.equal(JSON.stringify(preview).includes(hidden),false);
  await publish(f,f.owner,[selected]);const before=(await committedState(f.db)).rows;
  const read=await publicRead(f,p),history=await f.ok('/v2/requester-history/query',
   {authorization:false,input:{subjectId:f.owner.actor.subjectId}});
  assert.equal(read.projection.title,p.post.title);assert.equal(read.originalTextAccessGranted,false);
  assert.equal(history.items[0].projection.title,p.post.title);
  assert.equal((await f.request('/v2/tasks/'+p.request.taskId,{authorization:false})).status,404);
  for(const hidden of [p.post.body,p.request.taskId,p.prepared.descriptors[1].materialId])assert.equal(JSON.stringify({read,history}).includes(hidden),false);
  assert.deepEqual((await committedState(f.db)).rows,before,'read-only projections preserve every original event and grant');
  await f.ok('/v1/consents/'+p.source.consentId+'/revoke',{input:{}});
  const withdrawn=await publicRead(f,p),own=await f.ok('/v2/requester-history/query',{input:{subjectId:f.owner.actor.subjectId}});
  assert.equal(withdrawn.projection.title,'');assert.equal(withdrawn.projection.textView.fields.title.state,'unavailable');
  assert.equal(own.items[0].projection.title,'');assert.equal(own.items[0].projection.summary,p.independent);
  assert.equal(JSON.stringify({withdrawn,own}).includes(p.post.title),false);assert.equal(JSON.stringify({withdrawn,own}).includes(p.post.body),false);
  assert.deepEqual((await f.db.query('SELECT payload_text,payload_hash FROM task_events WHERE id=$1',[p.request.operationId])).rows,
   [{payload_text:p.input.payloadJson,payload_hash:digest(p.input.payloadJson)}]);
 }finally{await f.close();}
});

test('each current selected material field retains its own bounded publication expiry; no unselected fields are inferred',async()=>{
 const f=await communityForumFixture();try{
  const p=await create(f),titleUntil=f.clock.now+20,summaryUntil=f.clock.now+40;
  await publish(f,f.owner,[source(p,['eventType','actorId','title'])],{expiresAt:titleUntil});
  await publish(f,f.owner,[source(p,['eventType','actorId','summary'])],{expiresAt:summaryUntil});
  const read=await publicRead(f,p);assert.equal(read.projection.textView.fields.title.availableUntil,titleUntil);
  assert.equal(read.projection.textView.fields.summary.availableUntil,summaryUntil);assert.equal(read.projection.taskId,undefined);
  f.clock.now=titleUntil+1;const shorterExpired=await publicRead(f,p);
  assert.equal(shorterExpired.projection.title,undefined);assert.equal(shorterExpired.projection.summary,p.independent+p.post.body);
  assert.deepEqual(Object.keys(shorterExpired.projection.textView.fields),['summary']);
  f.clock.now=summaryUntil+1;const expired=await f.request('/v2/contributions/read',{authorization:false,
   input:{source:{kind:'task-event',id:p.request.operationId,eventVersion:1,payloadHash:digest(p.input.payloadJson)},purpose:'honor'}});
  assert.equal(expired.status,404);assert.equal(JSON.stringify(expired.body).includes(p.post.body),false);
 }finally{await f.close();}
});

async function acceptedWork(f,p){
 const ownerId=f.owner.actor.subjectId,peerId=f.responder.actor.subjectId,caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',
  eventId:caseId,caseId,expectedVersion:0,actorId:ownerId,taskId:p.request.taskId,localRef:randomUUID(),title:taskMaterialCaseContainerTitle,
  summary:taskCaseContainerSummary,source:{kind:'active-task',reference:p.request.taskId},synthetic:true},
  first={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId,expectedVersion:1,actorId:ownerId,taskId:p.request.taskId,
   types:['diagnosis'],affectsAttemptIds:[],description:'[local synthetic] limited diagnosis',sourceRefs:[],observedEffect:'A test scope was identified'};
 const fact=(who,value,viewers)=>authorize(f,who,value,'case.teaser.publish',{viewers});
 await f.ok('/v2/tasks/'+p.request.taskId+'/case',{input:{operationId:randomUUID(),taskId:p.request.taskId,expectedTaskVersion:1,
  case:await fact(f.owner,root,[peerId]),initialFact:await fact(f.owner,first,[peerId])}});
 const proposal={eventId:randomUUID(),kind:'propose',expectedTaskVersion:1,participationId:randomUUID(),subjectId:peerId,
  role:'diagnosis',scopeVersion:1,agreedScope:'[local synthetic] limited diagnosis'};
 await f.ok('/v2/tasks/'+p.request.taskId+'/participations',{input:await authorize(f,f.owner,proposal,'assistance.publish',{viewers:[peerId]})});
 const confirmation={eventId:randomUUID(),kind:'confirm',expectedParticipationVersion:1,scopeVersion:1};
 await f.ok('/v2/participations/'+proposal.participationId+'/events',{who:f.responder,
  input:await authorize(f,f.responder,confirmation,'assistance.publish',{viewers:[ownerId]})});
 const intervention={...first,eventId:randomUUID(),actorId:peerId,expectedVersion:2,participationId:proposal.participationId};
 await f.ok('/v2/cases/events',{who:f.responder,input:await fact(f.responder,intervention,[ownerId])});
 const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId,expectedVersion:3,actorId:peerId,taskId:p.request.taskId,
  participationId:proposal.participationId,scopeVersion:1,origin:{kind:'intervention',id:intervention.eventId,version:1},deliverableRefs:[],
  reportedOutcome:'partial',summary:'[local synthetic] diagnosis complete; repair incomplete',limitations:'Only this test scope'};
 await f.ok('/v2/cases/events',{who:f.responder,input:await fact(f.responder,result,[ownerId])});
 const delivery={eventId:randomUUID(),kind:'deliver',expectedParticipationVersion:2,resultRef:{id:result.eventId,version:1},
  interventionRefs:[{id:intervention.eventId,version:1}],evidenceRefs:[],summary:'[local synthetic] diagnostic delivery'};
 await f.ok('/v2/participations/'+proposal.participationId+'/events',{who:f.responder,
  input:await authorize(f,f.responder,delivery,'assistance.publish',{viewers:[ownerId]})});
 const acceptance={eventId:randomUUID(),kind:'accept',expectedParticipationVersion:3,deliveryId:delivery.eventId,summary:'[local synthetic] accepted limited work'};
 await f.ok('/v2/participations/'+proposal.participationId+'/events',
  {input:await authorize(f,f.owner,acceptance,'assistance.publish',{viewers:[peerId]})});
 return {caseId};
}

test('Honor rechecks current selected material text without clock-only fingerprint changes; Hub still excludes narrative fields',async()=>{
 const f=await communityForumFixture();try{
  const p=await create(f,{capabilityId:'software-debugging',viewers:[f.responder.actor.subjectId]}),work=await acceptedWork(f,p),
   policy={id:'synthetic-material-contribution',version:'1',sourceProfile:'facts-v2',title:'Local synthetic rule',capabilityId:'software-debugging',
    communityId:'synthetic',kind:'open-contributor',members:[f.owner.actor.subjectId,f.responder.actor.subjectId],relatedPartyGroups:[],
    notBefore:f.clock.now-1,notAfter:f.clock.now+1000,windowFrom:f.clock.now-1000,windowUntil:f.clock.now+10,minAcceptedCases:1,minProofs:0,
    repositories:[],rankingEnabled:false,privacyReview:'pending',minimumCohort:5,minimumCasesPerMember:3};
  const legacy=new HonorService(f.owner.access,f.owner.assistance,f.owner.proofs,[policy]);
  f.owner.honor.v2=new HonorV2Service(legacy,{qualification:f.owner.qualification.v2,sharing:f.owner.contributionSharing});
  const query={ruleId:policy.id,ruleVersion:'1',subjectId:f.responder.actor.subjectId},allRows=[
   ...(await f.db.query('SELECT *,\'task-event\' AS source_kind FROM task_events WHERE task_id=$1',[p.request.taskId])).rows,
   ...(await f.db.query('SELECT *,\'case-event\' AS source_kind FROM case_events WHERE case_id=$1',[work.caseId])).rows];
  for(const who of [f.owner,f.responder])await publish(f,who,allRows.filter(row=>row.subject_id===who.actor.subjectId).map(row=>({
   kind:row.source_kind,id:row.id,eventVersion:1,payloadHash:row.payload_hash,fields:row.id===p.request.operationId?
    ['eventType','actorId','title']:['eventType','actorId']})));
  const before=(await committedState(f.db)).rows,read=await f.ok('/v2/honor/query',{authorization:false,input:query});
  assert.equal(read.items.length,1);const root=read.items[0].projections.find(item=>item.projection.eventType==='task-created');
  assert.equal(root.projection.title,p.post.title);assert.equal(root.projection.summary,undefined);assert.equal(root.projection.taskId,undefined);
  assert.equal(JSON.stringify(read).includes(p.post.body),false);assert.equal(JSON.stringify(read).includes(p.request.taskId),false);
  f.clock.now++;const fresh=await f.ok('/v2/honor/query',{authorization:false,input:{...query,expectedFingerprint:read.sourceFingerprint}});
  assert.equal(fresh.sourceFingerprint,read.sourceFingerprint);assert.deepEqual((await committedState(f.db)).rows,before);
  const limitedSource={kind:'contribution-summary',source:{kind:'task-event',id:p.request.operationId,eventVersion:1,payloadHash:digest(p.input.payloadJson)},
   fields:['eventType','actorId']},peerView=await f.db.transaction(db=>f.owner.peering.sourceWithin(db,{subjectId:f.responder.actor.subjectId},limitedSource,{authorId:f.owner.actor.subjectId}));
  assert.deepEqual(peerView.projection,{eventType:'task-created',actorId:f.owner.actor.subjectId});assert.equal(JSON.stringify(peerView).includes(p.post.title),false);
  await assert.rejects(f.db.transaction(db=>f.owner.peering.sourceWithin(db,{subjectId:f.responder.actor.subjectId},
   {...limitedSource,fields:['eventType','actorId','title']},{authorId:f.owner.actor.subjectId})),error=>error.code==='invalid_peering_request');
  await f.ok('/v1/consents/'+p.source.consentId+'/revoke',{input:{}});
  const revoked=await f.ok('/v2/honor/query',{authorization:false,input:query});assert.equal(JSON.stringify(revoked).includes(p.post.title),false);
  assert.notEqual(revoked.sourceFingerprint,read.sourceFingerprint);
  await f.ok('/v1/consents/'+p.intent.id+'/revoke',{input:{}});
  await assert.rejects(f.db.transaction(db=>f.owner.peering.sourceWithin(db,{subjectId:f.responder.actor.subjectId},limitedSource,{authorId:f.owner.actor.subjectId})),error=>error.code==='consent_required');
 }finally{await f.close();}
});
