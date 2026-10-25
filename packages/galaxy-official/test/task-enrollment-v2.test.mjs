import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTaskV2,applyTaskV2,proposeParticipationV2,applyParticipationV2,taskEnrollmentOpen} from '../src/domain/task-v2.mjs';

const id=()=>randomUUID(),owner='GUID'+'A'.repeat(28),provider='GUID'+'B'.repeat(28),other='GUID'+'C'.repeat(28);
function fixture(){
 let task=createTaskV2(owner,{operationId:id(),taskId:id(),caseId:id(),intent:'collaboration',title:'Review together',summary:'Keep the agreed work',
  workContext:{goal:'Review',currentSituation:'Working',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:1000},100);
 const proposed=proposeParticipationV2(task,owner,{kind:'propose',eventId:id(),expectedTaskVersion:task.version,participationId:id(),subjectId:provider,
  role:'review',scopeVersion:1,agreedScope:'Review the existing material'},100);
 task=proposed.task;let participation=proposed.participation;
 return{get task(){return task;},get participation(){return participation;},
  taskEvent(kind,extra={},actor=owner){task=applyTaskV2(task,actor,{kind,eventId:id(),expectedTaskVersion:task.version,...extra},100);return task;},
  participationEvent(kind,extra={},actor=provider){const next=applyParticipationV2(task,participation,actor,{kind,eventId:id(),expectedParticipationVersion:participation.version,...extra},100);task=next.task;participation=next.participation;return participation;}};
}

test('stopping enrollment preserves pending confirmation, scope agreement, delivery and requester acceptance',()=>{
 const f=fixture();f.taskEvent('stop-enrollment',{reason:'Enough participants'});
 assert.equal(f.task.state,'open');assert.equal(taskEnrollmentOpen(f.task,100),false);
 const stoppedAt=f.task.enrollment.stoppedAt;
 f.taskEvent('stop-enrollment',{reason:'Repeated click'});assert.equal(f.task.enrollment.stoppedAt,stoppedAt);
 f.participationEvent('confirm',{scopeVersion:1});
 const scope=f.participationEvent('propose-scope',{scopeVersion:2,agreedScope:'Review and explain',reason:'Agreed adjustment'},owner);
 f.participationEvent('confirm-scope',{proposalId:scope.pendingScope.eventId});
 const delivered=f.participationEvent('deliver',{resultRef:{id:id(),version:1},interventionRefs:[],evidenceRefs:[],summary:'Review completed'});
 f.participationEvent('accept',{deliveryId:delivered.deliveries[0].deliveryId,summary:'Useful review'},owner);
 assert.equal(f.participation.state,'accepted');assert.equal(f.task.state,'open');
 for(const [kind,extra,actor] of [['apply',{proposal:'Late applicant'},other],['invite',{recipientId:other,note:'Join',expiresAt:500},owner],['extend-enrollment',{enrollmentExpiresAt:2000},owner]])
  assert.throws(()=>f.taskEvent(kind,extra,actor),{code:'task_transition_denied'});
 assert.throws(()=>proposeParticipationV2(f.task,owner,{kind:'propose',eventId:id(),expectedTaskVersion:f.task.version,participationId:id(),subjectId:other,
  role:'advice',scopeVersion:1,agreedScope:'New work'},100),{code:'task_transition_denied'});
});

test('legacy close cannot mean stop-enrollment; explicit termination and historical closed records keep their original effect',()=>{
 const f=fixture();f.participationEvent('confirm',{scopeVersion:1});
 assert.throws(()=>f.taskEvent('close',{reason:'Legacy stop text'}),{code:'task_termination_intent_required'});
 assert.equal(f.task.state,'open');
 f.taskEvent('close',{reason:'Terminate the entire task',terminationIntent:'terminate-task'});
 assert.equal(f.task.state,'closed');
 assert.throws(()=>f.participationEvent('deliver',{resultRef:{id:id(),version:1},interventionRefs:[],evidenceRefs:[],summary:'Late delivery'}),{code:'task_closed'});
 assert.throws(()=>f.taskEvent('stop-enrollment',{reason:'Do not resurrect'}),{code:'task_transition_denied'});
 const historical=structuredClone(f.task);delete historical.enrollment;
 assert.equal(taskEnrollmentOpen(historical,100),false);
});

test('stale concurrent applications are rejected; an application committed first remains a fact after stopping',()=>{
 const f=fixture(),before=structuredClone(f.task);
 f.taskEvent('apply',{proposal:'Application committed first'},other);
 f.taskEvent('stop-enrollment',{reason:'Enough people'});
 assert.equal(f.task.applications.length,1);
 assert.throws(()=>applyTaskV2(f.task,other,{kind:'apply',eventId:id(),expectedTaskVersion:before.version,proposal:'Stale page'},100),{code:'task_version_conflict'});
 assert.throws(()=>f.taskEvent('apply',{proposal:'Fresh but closed enrollment'},other),{code:'task_transition_denied'});
});
