import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {materialTask} from './task-material-fixture.mjs';
import {createBrowserClient} from '../src/browser-client.mjs';
import {getFactClient} from '../../galaxy-web/src/fact-client.mjs';
import {taskCaseContainerSummary,taskMaterialCaseContainerTitle} from '../src/shared/cases-schema.mjs';
import {digest} from '../src/shared/digest.mjs';

// Real browser protocol/signatures and HTTP/PGlite. The local journal is an
// explicit Map double; this is not a browser UI or production-host observation.
async function clientFor(f,who,t){
 const calls=[],hooks={loseCaseAck:false},values=new Map(),api=createBrowserClient({
  endpoint:who.access.endpoint,trustedKeys:who.bindings.trustedKeys,sign:who.signForTest,now:()=>f.clock.now,
  fetch:async(url,options)=>{
   assert.equal(new URL(url).origin,who.access.endpoint);
   const path=new URL(url).pathname;calls.push({path,method:options.method});
   const response=await fetch(f.origin+path,options);
   if(hooks.loseCaseAck&&path.endsWith('/case')&&response.status===200){
    hooks.loseCaseAck=false;throw Error('synthetic first material work ACK lost');
   }
   return response;
  },
 });t.after(()=>api.close());
 const deviceId=randomUUID(),keyId=digest(who.genesis.genesisProof.publicKeyPem),
  request={version:2,kind:'bootstrap',operationId:randomUUID(),subjectId:who.actor.subjectId,
   expectedEpoch:0,previousEventHash:null,signerKeyId:keyId,genesisProof:who.genesis.genesisProof,
   newDevice:{deviceId,publicKeyPem:who.genesis.genesisProof.publicKeyPem,scopes:['manage-identity',...who.actor.scopes]}};
 const challenge=await f.ok('/v2/identity/control/challenges',{authorization:false,input:request}),
  signature=await who.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws');
 const registered=await f.ok('/v2/identity/control/commit',{authorization:false,
  input:{operationId:request.operationId,controllerSignature:signature,newDeviceProof:signature}});
 assert.equal(registered.state,'committed');
 await api.connect({subjectId:who.actor.subjectId,genesisProof:who.genesis.genesisProof,
  installationId:randomUUID(),scopes:who.actor.scopes,control:{deviceId,keyId,epoch:registered.epoch}},{confirmed:true});
 const runtime={api,getLocal:async key=>structuredClone(values.get(key)),
  putLocal:async(key,value)=>{values.set(key,structuredClone(value));},
  updateLocal:async(key,change)=>{const value=change(structuredClone(values.get(key)));
   assert.equal(typeof value?.then,'undefined');values.set(key,structuredClone(value));return structuredClone(value);},
 };
 return{api,runtime,calls,hooks,facts:getFactClient(runtime,who.actor.subjectId,{now:()=>f.clock.now})};
}
const fields=()=>({kind:'intervention',types:['diagnosis'],affectsAttemptIds:[],
 description:'[local synthetic] Only the participant reports this diagnostic work.',
 sourceRefs:[],observedEffect:'A limited synthetic observation, not requester work.'});
const getTask=(api,taskId)=>api.call('/v2/tasks/'+taskId,undefined,{method:'GET'});
async function join(owner,peer,taskId){
 const current=await getTask(owner.api,taskId),participationId=randomUUID(),subjectId=peer.api.snapshot().subjectId;
 const proposal={kind:'propose',eventId:randomUUID(),expectedTaskVersion:current.version,participationId,
  subjectId,role:'diagnosis',scopeVersion:1,agreedScope:'Only my own limited diagnostic work.'};
 await owner.api.call('/v2/tasks/'+taskId+'/participations',await owner.api.authorizePayload(proposal,
  {action:'assistance.publish',objectId:proposal.eventId,visibility:'Private',viewers:[subjectId],confirmed:true}));
 const confirmation={kind:'confirm',eventId:randomUUID(),expectedParticipationVersion:1,scopeVersion:1};
 await peer.api.call('/v2/participations/'+participationId+'/events',await peer.api.authorizePayload(confirmation,
  {action:'assistance.publish',objectId:confirmation.eventId,visibility:'Private',viewers:[owner.api.snapshot().subjectId],confirmed:true}));
 const task=await getTask(peer.api,taskId);return{task,participant:task.participations.find(row=>row.participationId===participationId)};
}
async function fixture(t){const f=await communityForumFixture();t.after(()=>f.close());
 return{f,owner:await clientFor(f,f.owner,t),peer:await clientFor(f,f.responder,t)};}

test('typed Task first confirmed participant work has a neutral title; lost ACK preserves the original root and never creates requester work',async t=>{
 const {f,owner,peer}=await fixture(t),p=await materialTask(f);await f.ok('/v2/tasks',{input:p.input});
 const joined=await join(owner,peer,p.request.taskId),ownerId=owner.api.snapshot().subjectId,peerId=peer.api.snapshot().subjectId,
  rootBefore=(await f.db.query('SELECT payload_text,payload_hash FROM task_events WHERE id=$1',[p.request.operationId])).rows;
 assert.equal(joined.task.request.title,p.post.title);assert.equal(joined.task.textView.format,'task-text-view-v1');
 peer.hooks.loseCaseAck=true;
 await assert.rejects(peer.facts.submitFact(joined.task,null,joined.participant,fields(),
  {confirmed:true,viewers:[ownerId],synthetic:true}),/synthetic first material work ACK lost/);
 const pending=await peer.facts.pending(p.request.taskId),before=peer.calls.filter(call=>call.path.endsWith('/case')).length;
 assert.equal((await peer.facts.resumePending(p.request.taskId)).state,'acknowledged');
 assert.equal(peer.calls.filter(call=>call.path.endsWith('/case')).length,before);
 const rows=(await f.db.query('SELECT subject_id,payload FROM case_events WHERE case_id=$1 ORDER BY version',[pending.caseId])).rows;
 assert.equal(rows.length,2);assert.equal(rows[0].payload.title,taskMaterialCaseContainerTitle);
 assert.equal(rows[0].payload.summary,taskCaseContainerSummary);assert.equal(rows[1].payload.kind,'intervention');
 assert.ok(rows.every(row=>row.subject_id===peerId&&row.payload.actorId===peerId));
 assert.equal((await f.db.query('SELECT subject_id FROM cases WHERE id=$1',[pending.caseId])).rows[0].subject_id,ownerId);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM case_task_links WHERE task_id=$1',[p.request.taskId])).rows[0].n,1);
 assert.deepEqual((await f.db.query('SELECT payload_text,payload_hash FROM task_events WHERE id=$1',[p.request.operationId])).rows,rootBefore);
 await owner.api.call('/v1/consents/'+p.source.consentId+'/revoke',{});
 const task=await getTask(peer.api,p.request.taskId),facts=await peer.facts.readCase(task);
 assert.equal(task.request.title,'');assert.equal(task.request.summary,p.independent);
 assert.equal(task.textView.fields.title.state,'unavailable');assert.equal(facts.interventions[0].actorId,peerId);
 for(const text of [p.post.title,p.post.body])assert.equal(JSON.stringify({task,facts,rows}).includes(text),false);
 assert.deepEqual((await f.db.query('SELECT payload_text,payload_hash FROM task_events WHERE id=$1',[p.request.operationId])).rows,rootBefore);
});

test('withdrawn typed source cannot leak through a newly linked Case',async t=>{
 const {f,owner,peer}=await fixture(t),p=await materialTask(f);await f.ok('/v2/tasks',{input:p.input});
 const joined=await join(owner,peer,p.request.taskId);await owner.api.call('/v1/consents/'+p.source.consentId+'/revoke',{});
 const current=await getTask(peer.api,p.request.taskId);assert.equal(current.request.title,'');
 const receipt=await peer.facts.submitFact(current,null,joined.participant,fields(),
  {confirmed:true,viewers:[owner.api.snapshot().subjectId],synthetic:true});
 const facts=await peer.facts.readCase(await getTask(peer.api,p.request.taskId));
 assert.equal(facts.events[0].title,taskMaterialCaseContainerTitle);
 for(const text of [p.post.title,p.post.body])assert.equal(JSON.stringify(facts).includes(text),false);
 assert.equal(receipt.failedAttemptsCreated,0);

});

test('revoked original typed Task authorization still rejects first work and creates no Case',async t=>{
 const {f,owner,peer}=await fixture(t),p=await materialTask(f);await f.ok('/v2/tasks',{input:p.input});
 const next=await join(owner,peer,p.request.taskId),before=(await f.db.query('SELECT count(*)::int n FROM cases')).rows[0].n;
 await owner.api.call('/v1/consents/'+p.intent.id+'/revoke',{});
 await assert.rejects(peer.facts.submitFact(next.task,null,next.participant,fields(),
  {confirmed:true,viewers:[owner.api.snapshot().subjectId],synthetic:true}),error=>error.code==='consent_required');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM cases')).rows[0].n,before);
 assert.equal((await f.db.query('SELECT case_id FROM task_requests WHERE id=$1',[p.request.taskId])).rows[0].case_id,null);
});

test('typed requester first work also uses the neutral container without replacing an explicitly supplied summary',async t=>{
 const {f,owner}=await fixture(t),p=await materialTask(f);await f.ok('/v2/tasks',{input:p.input});
 const summary='[local synthetic] An explicitly supplied previous requester summary.';
 const receipt=await owner.facts.submitFact(await getTask(owner.api,p.request.taskId),null,null,fields(),
  {confirmed:true,synthetic:true,caseSummary:summary});
 const rows=(await f.db.query('SELECT payload FROM case_events WHERE case_id=$1 ORDER BY version',[receipt.caseId])).rows;
 assert.equal(rows[0].payload.title,taskMaterialCaseContainerTitle);assert.equal(rows[0].payload.summary,summary);
 for(const text of [p.post.title,p.post.body])assert.equal(JSON.stringify(rows).includes(text),false);
});
