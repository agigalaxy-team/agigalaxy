import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { taskParticipationMigrationSql } from '../src/infrastructure/task-participation-schema-v2.mjs';
import { TaskRepository } from '../src/infrastructure/task-repository.mjs';
import { createTaskV2, applyTaskV2, proposeParticipationV2, applyParticipationV2 } from '../src/domain/task-v2.mjs';
import { taskRequestV2Schema } from '../src/shared/task-schema-v2.mjs';
import { assistanceRequestSchema } from '../src/shared/assistance-schema.mjs';
import { digest } from '../src/shared/digest.mjs';
import { transaction } from "../src/infrastructure/database.mjs";
import { createApi } from '../src/http.mjs';

const id = () => randomUUID();
const subject = char => 'GUID' + char.repeat(28);
const request = (now, fields = {}) => ({ operationId: id(), taskId: id(), caseId: null, intent: 'proactive-review',
  workContext: { goal: 'Review a working parser', currentSituation: 'No failure observed; look for missed boundaries', attemptRefs: [] },
  title: 'Review merged cells', summary: 'Diagnose edge cases; a patch is optional', visibility: 'Private',
  collaboration: 'open-assistance', enrollmentExpiresAt: now + 3600, ...fields });

test('v2 task does not fabricate Case/Attempt; independent scopes, delivery and withdrawal keep contribution', () => {
  const owner = subject('A'), a = subject('B'), b = subject('C'); let task = createTaskV2(owner, request(100), 100);
  assert.equal(task.request.caseId, null); assert.deepEqual(task.request.workContext.attemptRefs, []);
  const propose = (who, role) => {
    const next = proposeParticipationV2(task, owner, { eventId: id(), expectedTaskVersion: task.version,
      kind: 'propose', participationId: id(), subjectId: who, role, scopeVersion: 1, agreedScope: role }, 100);
    task = next.task; return next.participation;
  };
  let pa = propose(a, 'diagnosis'), pb = propose(b, 'patch');
  const act = (p, actor, kind, extra = {}) => {
    const next = applyParticipationV2(task, p, actor, { eventId: id(), expectedParticipationVersion: p.version, kind, ...extra }, 100);
    task = next.task; return next.participation;
  };
  pa = act(pa, a, 'confirm', { scopeVersion: 1 }); pb = act(pb, b, 'confirm', { scopeVersion: 1 });
  const changed = act(pa, owner, 'propose-scope', { scopeVersion: 2, agreedScope: 'extra analysis', reason: 'new request' });
  assert.equal(changed.agreedScope, 'diagnosis'); assert.equal(changed.scopeVersion, 1);
  pa = act(changed, a, 'decline-scope', { proposalId: changed.pendingScope.eventId, reason: 'outside scope' });
  task.request.caseId = id();
  const diagnosis = { resultRef: { id: id(), version: 1 }, interventionRefs: [{ id: id(), version: 1 }], evidenceRefs: [], summary: 'Located limitation, not fixed' };
  pa = act(pa, a, 'deliver', diagnosis);
  pa = act(pa, a, 'withdraw', { reason: 'available work finished' });
  assert.equal(pb.state, 'active'); assert.equal(task.state, 'open');
  pa = act(pa, owner, 'accept', { deliveryId: pa.deliveries[0].deliveryId, summary: 'Useful diagnosis accepted' });
  assert.equal(pa.state, 'withdrawn'); assert.equal(pa.deliveries[0].authorId, a);
  assert.equal(pa.deliveries[0].resolution, 'unresolved'); assert.equal(pa.deliveries[0].verification, 'not-provided');
  assert.equal(pa.deliveries[0].acceptance.actorId, owner); assert.equal(task.selected, null);
  assert.equal(task.participationIds.length, 2);
});

test('a declined invitation cannot be reissued for the same Task and invitations expire within seven days', () => {
  const owner=subject('A'), recipient=subject('B');
  let task=createTaskV2(owner,request(100,{enrollmentExpiresAt:100+20*86400}),100);
  const invite={eventId:id(),expectedTaskVersion:1,kind:'invite',recipientId:recipient,note:'Review?',expiresAt:100+8*86400};
  assert.throws(()=>applyTaskV2(task,owner,invite,100),{code:'task_invitation_expiry'});
  task=applyTaskV2(task,owner,{...invite,expiresAt:100+7*86400},100);
  task=applyTaskV2(task,recipient,{eventId:id(),expectedTaskVersion:2,kind:'invitation-reply',invitationId:invite.eventId,response:'declined',message:'Not this task'},100);
  assert.throws(()=>applyTaskV2(task,owner,{...invite,eventId:id(),expectedTaskVersion:3,expiresAt:200},100),{code:'task_invitation_declined'});
});

test('legacy request limits are preserved while v2 is explicit and bounty keeps eligibility', () => {
  const v1 = { id:id(),caseId:id(),title:'a'.repeat(160),problem:'p',attemptedApproaches:[],scope:'s',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:200 };
  assert.equal(assistanceRequestSchema.safeParse(v1).success,true);
  assert.equal(taskRequestV2Schema.safeParse(request(100,{title:'a'.repeat(121)})).success,false);
  assert.equal(taskRequestV2Schema.safeParse(request(100,{collaboration:'basic-bounty',budget:{mode:'quote',unit:'USD'}})).success,false);
});

test('real persisted Task and Participation flow hides competing data, supports retries, distinct invitation replies and local anonymous discovery', { timeout: 60000 }, async () => {
  const scopes = ['binding','consent','case-teaser','assistance'];
  const clock={now:Math.floor(Date.now()/1000)};
  const f = await serviceFixture(scopes,null,clock), p = await serviceFixture(scopes, f.db,clock), q = await serviceFixture(scopes, f.db,clock);
  const api = createApi(f); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`;
  const http = async (path, who, body) => {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET',
      headers: { ...(who ? { Authorization: `Bearer ${who.credential}` } : {}), ...(body ? {'Content-Type':'application/json'} : {}) },
      ...(body ? {body:JSON.stringify(body)} : {}) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  try {
    if (!(await f.db.query("SELECT to_regclass('task_requests') AS n")).rows[0].n) await f.db.exec(taskParticipationMigrationSql);
    const calls = [], responses = [];
    // Isolated injection proves transaction placement. Real Account validation is
    // tested by public-writes/oidc suites; this fixture is never a verified user.
    f.assistance.publicWrites = { consumeWithin: async (_db, _actor, op) => { calls.push(op); return { used: calls.length }; },
      markInvitationRespondedWithin: async (_db, value) => responses.push(value) };
    const input = request(f.now, { visibility: 'Public' });
    const root = await f.authorize(input, 'assistance.publish', { objectId: input.operationId, visibility: 'Public', purpose: 'public-profile' });
    const created = await http('/v2/tasks', f, root);
    assert.equal(created.caseId, null); assert.equal(calls.length, 1);
    assert.equal((await f.assistance.createTask(f.actor, root)).version, 1); assert.equal(calls.length, 1);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cases')).rows[0].n, 0);
    assert.equal((await http(`/v2/tasks/${input.taskId}`)).contacts, undefined);
    assert.equal((await http('/v2/tasks')).items.length, 1);
    let version = 1;
    const taskAct = async (who, kind, fields, viewers = []) => {
      const event = { eventId:id(),expectedTaskVersion:version,kind,...fields }, envelope = { taskId:input.taskId,event };
      const grant = await who.authorize(envelope,'assistance.publish',{objectId:event.eventId,viewers});
      const receipt = await f.assistance.submitTaskEvent(who.actor,input.taskId,grant); version=receipt.version;
      return {event,grant,receipt};
    };
    await taskAct(f,'suggest-contacts',{state:'ready',items:[{subjectId:p.actor.subjectId,help:'Diagnosis',basis:'Unknown work history; offering relevant scope',sourceRefs:[]}]});
    const pi = await taskAct(f,'invite',{recipientId:p.actor.subjectId,note:'Could you diagnose?',expiresAt:f.now+1200},[p.actor.subjectId]);
    const qi = await taskAct(f,'invite',{recipientId:q.actor.subjectId,note:'Could you review?',expiresAt:f.now+1200},[q.actor.subjectId]);
    assert.equal((await f.assistance.queryTasks(p.actor,{view:'participating'})).items.length,1,'pending invitation appears before a response');
    await taskAct(p,'invitation-reply',{invitationId:pi.event.eventId,response:'question',message:'Which version?'},[f.actor.subjectId]);
    await taskAct(q,'invitation-reply',{invitationId:qi.event.eventId,response:'declined',message:'Unavailable'},[f.actor.subjectId]);
    const contact = await f.assistance.getTask(f.actor,input.taskId);
    assert.equal(contact.contacts.suggestions.items.length,1);
    assert.deepEqual(contact.contacts.responses.invitations.map(i=>i.state),['question','declined']);
    assert.equal(contact.participations.length,0); assert.equal(responses.length,2);
    const own = await f.assistance.getTask(p.actor,input.taskId);
    assert.equal(own.contacts.suggestions.items.length,0); assert.equal(own.contacts.responses.invitations.length,1);
    assert.ok(!JSON.stringify(own).includes('Unavailable'));
    const papp=await taskAct(p,'apply',{proposal:'Private p proposal',scope:'diagnose'},[f.actor.subjectId]);
    await taskAct(q,'apply',{proposal:'Secret competing q proposal',scope:'review'},[f.actor.subjectId]);
    assert.ok(!JSON.stringify(await f.assistance.getTask(p.actor,input.taskId)).includes('Secret competing'));
    const pid=id(), proposal={eventId:id(),expectedTaskVersion:version,kind:'propose',participationId:pid,subjectId:p.actor.subjectId,
      role:'diagnosis',scopeVersion:1,agreedScope:'Only the edge cases',applicationId:papp.event.eventId};
    const propGrant=await f.authorize(proposal,'assistance.publish',{objectId:proposal.eventId,viewers:[p.actor.subjectId]});
    const proposed=await f.assistance.proposeParticipation(f.actor,input.taskId,propGrant); version=proposed.version;
    assert.equal(proposed.state,'awaiting-counterparty');
    const confirmation={eventId:id(),expectedParticipationVersion:1,kind:'confirm',scopeVersion:1};
    const confGrant=await p.authorize(confirmation,'assistance.publish',{objectId:confirmation.eventId,viewers:[f.actor.subjectId]});
    const confirmed=await http(`/v2/participations/${pid}/events`,p,confGrant); version=confirmed.version;
    assert.equal(confirmed.state,'active'); assert.equal(confirmed.participationVersion,2);
    assert.deepEqual(await f.assistance.submitParticipationEvent(p.actor,pid,confGrant),{
      taskId:input.taskId,eventId:confirmation.eventId,version,participationId:pid,participationVersion:2});
    const collision={...confirmation,eventId:id()};
    await assert.rejects(f.assistance.submitParticipationEvent(p.actor,pid,await p.authorize(collision,'assistance.publish',
      {objectId:collision.eventId,viewers:[f.actor.subjectId]})),{code:'participation_version_conflict'});
    assert.equal((await f.assistance.getTask(q.actor,input.taskId)).participations.length,0);
    const reader=await f.assistance.getTask(p.actor,input.taskId); assert.equal(reader.participations[0].subjectId,p.actor.subjectId);
    assert.equal(reader.participations[0].contextAccessGranted,false);
    const withdrawn={eventId:id(),expectedParticipationVersion:2,kind:'withdraw',reason:'Cannot continue'};
    await f.assistance.submitParticipationEvent(p.actor,pid,await p.authorize(withdrawn,'assistance.publish',{objectId:withdrawn.eventId,viewers:[f.actor.subjectId]}));
    assert.equal((await f.assistance.getTask(f.actor,input.taskId)).state,'open');
    const receipt=await f.assistance.taskReceipt(p.actor,{taskId:input.taskId,eventId:confirmation.eventId,payloadHash:digest(confGrant.payloadJson)});
    assert.equal(receipt.state,'acknowledged');
    await assert.rejects(f.assistance.taskReceipt(q.actor,{taskId:input.taskId,eventId:confirmation.eventId,payloadHash:digest(confGrant.payloadJson)}),{code:'not_found'});
    await p.consents.revoke(p.actor,papp.grant.consentId);
    assert.equal((await f.assistance.getTask(f.actor,input.taskId)).contacts.responses.applications.some(a=>a.applicationId===papp.event.eventId),false);
    await f.consents.revoke(f.actor,root.consentId);
    await assert.rejects(f.assistance.getPublicTask(input.taskId),{code:'consent_required'});
    assert.equal((await f.assistance.queryPublicTasks()).items.length,0);
  } finally { api.closeAllConnections(); await new Promise(resolve=>api.close(resolve)); await f.db.close(); }
});

test('public writes fail closed without verification hook and same-ID Task conflicts cannot replace existing data', {timeout:60000}, async () => {
  const f=await serviceFixture(['binding','consent','case-teaser','assistance']);
  try {
    if (!(await f.db.query("SELECT to_regclass('task_requests') AS n")).rows[0].n) await f.db.exec(taskParticipationMigrationSql);
    const input=request(f.now,{visibility:'Public'}), grant=await f.authorize(input,'assistance.publish',
      {objectId:input.operationId,visibility:'Public',purpose:'public-profile'});
    f.assistance.publicWrites=null;
    await assert.rejects(f.assistance.createTask(f.actor,grant),{code:'public_write_verification_unavailable'});
    assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,0);
    const privateInput={...input,visibility:'Private'}, privateGrant=await f.authorize(privateInput,'assistance.publish',{objectId:input.operationId});
    await f.assistance.createTask(f.actor,privateGrant);
    const conflict={...privateInput,operationId:id(),summary:'replacement'};
    await assert.rejects(f.assistance.createTask(f.actor,await f.authorize(conflict,'assistance.publish',{objectId:conflict.operationId})),{code:'task_conflict'});
    assert.equal((await f.assistance.getTask(f.actor,input.taskId)).request.summary,privateInput.summary);
    const repo=new TaskRepository();
    await assert.rejects(transaction(f.db,db=>repo.attachCase(db,{taskId:input.taskId,caseId:id(),requesterId:subject('X')})),{code:'task_case_link_denied'});
  } finally { await f.db.close(); }
});
