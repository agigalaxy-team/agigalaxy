import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTaskV2,applyTaskV2,proposeParticipationV2,applyParticipationV2} from '../src/domain/task-v2.mjs';
import {taskEventV2Schema,participationProposalV2Schema} from '../src/shared/task-schema-v2.mjs';
import {applicationFromDraft} from "../../galaxy-web/src/features/tasks/task-bounty-client.mjs";
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {digest} from '../src/shared/digest.mjs';

const request=now=>({operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'collaboration',title:'Read the explanation',
 summary:'A second reader can help identify ambiguous wording.',workContext:{goal:'Clear wording',currentSituation:'One paragraph needs another reader',attemptRefs:[]},
 visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:now+3600});

test('help-only input preserves the proposal without invented arrangements or participation',()=>{
 const owner='GUID'+'A'.repeat(28),helper='GUID'+'B'.repeat(28),now=2000000000;
 const original=createTaskV2(owner,request(now),now);
 const built=applicationFromDraft({proposal:' I can read the paragraph. ',scope:'  '},{taskId:original.request.taskId,version:1,request:original.request});
 assert.deepEqual(built,{kind:'apply',expectedTaskVersion:1,proposal:'I can read the paragraph.'});
 const event={...built,eventId:randomUUID()};
 const task=applyTaskV2(original,helper,event,now);
 assert.equal(Object.hasOwn(task.applications[0],'scope'),false);
 assert.deepEqual(task.participationIds,[]);assert.equal(task.request.caseId,null);
 assert.equal(original.version,1);
 assert.equal(taskEventV2Schema.safeParse({...event,scope:''}).success,false);
 assert.equal(taskEventV2Schema.safeParse({...event,proposal:''}).success,false);
 const old=applyTaskV2(original,helper,{...event,scope:'Only the marked paragraph.'},now);
 assert.equal(old.applications[0].scope,'Only the marked paragraph.');
});

test('joining retains both full original fields and uses a neutral role only after a real choice',()=>{
 const owner='GUID'+'A'.repeat(28),helper='GUID'+'B'.repeat(28),now=2000000000;
 const application={eventId:randomUUID(),kind:'apply',expectedTaskVersion:1,proposal:'P'.repeat(1500),scope:'S'.repeat(1500)};
 const task=applyTaskV2(createTaskV2(owner,request(now),now),helper,application,now);
 const event={eventId:randomUUID(),kind:'propose',expectedTaskVersion:2,participationId:randomUUID(),subjectId:helper,
  role:'contribution',scopeVersion:1,applicationId:application.eventId,agreedScope:application.proposal+'\n\n'+application.scope};
 const proposed=proposeParticipationV2(task,owner,event,now);
 assert.equal(proposed.participation.role,'contribution');assert.equal(proposed.participation.agreedScope,event.agreedScope);
 assert.equal(proposed.participation.confirmedAt,null);assert.equal(proposed.participation.state,'awaiting-counterparty');
 const confirmed=applyParticipationV2(proposed.task,proposed.participation,helper,
  {eventId:randomUUID(),expectedParticipationVersion:1,kind:'confirm',scopeVersion:1},now);
 assert.equal(confirmed.participation.state,'active');assert.deepEqual(confirmed.participation.deliveries,[]);
 assert.equal(confirmed.participation.contextAccessGranted,false);assert.equal(confirmed.participation.roomMembershipGranted,false);
 assert.equal(participationProposalV2Schema.safeParse({...event,agreedScope:event.agreedScope+'x'}).success,false);
 for(const role of ['diagnosis','advice','context','tool','patch','review','verification','takeover','main-responsible']){
  assert.equal(participationProposalV2Schema.parse({...event,role}).role,role);
 }
});

test('signed HTTP help-only application stays private and same-ID retries never create a second intent or participation',{timeout:60000},async()=>{
 const scopes=['binding','consent','case-teaser','assistance'];
 // No synthetic public-write verification: this test selects a private scope.
 const clock={now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false};
 const owner=await serviceFixture(scopes,null,clock);
 const helper=await serviceFixture(scopes,owner.db,clock);
 const outsider=await serviceFixture(scopes,owner.db,clock);
 const api=createApi(owner);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+api.address().port;
 const call=async(actor,path,body)=>{const response=await fetch(origin+path,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer '+actor.credential,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return{status:response.status,body:await response.json()};};
 try{
  const task=request(owner.now),root=await owner.authorize(task,'assistance.publish',{objectId:task.operationId,viewers:[helper.actor.subjectId]});
  assert.equal((await call(owner,'/v2/tasks',root)).status,200);
  const event={eventId:randomUUID(),kind:'apply',expectedTaskVersion:1,proposal:'I can read the paragraph and explain the ambiguity.'};
  const envelope={taskId:task.taskId,event},grant=await helper.authorize(envelope,'assistance.publish',{objectId:event.eventId,viewers:[owner.actor.subjectId]});
  const first=await call(helper,'/v2/tasks/'+task.taskId+'/events',grant),second=await call(helper,'/v2/tasks/'+task.taskId+'/events',grant);
  assert.equal(first.status,200);assert.equal(second.status,200);assert.equal(second.body.eventId,event.eventId);
  assert.equal((await owner.db.query('SELECT count(*)::int AS n FROM task_events WHERE id=$1',[event.eventId])).rows[0].n,1);
  const read=await call(owner,'/v2/tasks/'+task.taskId);
  assert.equal(read.status,200);assert.equal(read.body.contacts.responses.applications[0].proposal,event.proposal);
  assert.equal(Object.hasOwn(read.body.contacts.responses.applications[0],'scope'),false);assert.deepEqual(read.body.participations,[]);
  const denied=await call(outsider,'/v2/tasks/'+task.taskId);assert.notEqual(denied.status,200);assert.ok(!JSON.stringify(denied.body).includes(event.proposal));
  const receipt=await call(helper,'/v2/tasks/receipt',{taskId:task.taskId,eventId:event.eventId,payloadHash:digest(grant.payloadJson)});
  assert.equal(receipt.status,200);assert.equal(receipt.body.state,'acknowledged');
  const participation={eventId:randomUUID(),kind:'propose',expectedTaskVersion:2,participationId:randomUUID(),subjectId:helper.actor.subjectId,
   role:'contribution',scopeVersion:1,agreedScope:event.proposal,applicationId:event.eventId};
  const proposal=await owner.authorize(participation,'assistance.publish',{objectId:participation.eventId,viewers:[helper.actor.subjectId]});
  const joined=await call(owner,'/v2/tasks/'+task.taskId+'/participations',proposal);assert.equal(joined.status,200);assert.equal(joined.body.state,'awaiting-counterparty');
  const confirmation={eventId:randomUUID(),kind:'confirm',expectedParticipationVersion:1,scopeVersion:1};
  const choice=await helper.authorize(confirmation,'assistance.publish',{objectId:confirmation.eventId,viewers:[owner.actor.subjectId]});
  assert.equal((await call(helper,'/v2/participations/'+participation.participationId+'/events',choice)).status,200);
  const current=(await call(helper,'/v2/tasks/'+task.taskId)).body;
  assert.equal(current.participations[0].role,'contribution');assert.equal(current.participations[0].agreedScope,event.proposal);
  assert.equal(current.participations[0].state,'active');assert.deepEqual(current.participations[0].deliveries,[]);
  await helper.consents.revoke(helper.actor,grant.consentId);
  assert.equal((await call(owner,'/v2/tasks/'+task.taskId)).body.contacts.responses.applications.length,0);
  assert.equal((await owner.db.query('SELECT count(*)::int AS n FROM task_events WHERE id=$1',[event.eventId])).rows[0].n,1);
 }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await owner.db.close();}
});
