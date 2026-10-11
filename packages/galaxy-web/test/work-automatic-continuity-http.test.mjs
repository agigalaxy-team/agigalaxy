import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {privacyConsumerFixture} from '../../galaxy-official/test/privacy-consumer-continuity-workflow.mjs';
import {getFactClient} from '../src/fact-client.mjs';
import {createCapsuleWebClient} from '../src/capsule-workspace-client.mjs';
import {taskCaseContainerSummary} from '../../galaxy-official/src/shared/cases-schema.mjs';

async function fixture(t){const f=await privacyConsumerFixture();t.after(()=>f.close());return f;}
const fields=()=>({kind:'intervention',types:['diagnosis'],affectsAttemptIds:[],description:'本地合成参与者的本人诊断',sourceRefs:[],observedEffect:'只有合成范围观察，没有请求者尝试'});
const writes=(f,path)=>f.requests.filter(item=>item.path===path).length;
async function write(runtime,path,payload,viewers=[],action='assistance.publish'){
 return runtime.api.call(path,await runtime.api.authorizePayload(payload,{action,objectId:payload.operationId??payload.eventId??payload.id,
  visibility:'Private',viewers,confirmed:true}));
}
async function task(f,peers=[]){const input={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'collaboration',title:'[合成] 实际工作接续',summary:'隔离接口权限与本人事实',
 workContext:{goal:'记录真实本人工作',currentSituation:'任务尚无协作记录容器',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now()+86400};
 await write(f.runtime,'/v2/tasks',input,peers);return f.runtime.api.call('/v2/tasks/'+input.taskId,{}, {method:'GET'});
}
async function participate(f,current,peer){const id=randomUUID(),peerId=(await peer.status()).identity.subjectId;
 await write(f.runtime,`/v2/tasks/${current.taskId}/participations`,{kind:'propose',eventId:randomUUID(),expectedTaskVersion:current.version,participationId:id,
  subjectId:peerId,role:'diagnosis',scopeVersion:1,agreedScope:'本人有限诊断'},[peerId]);
 await write(peer,`/v2/participations/${id}/events`,{kind:'confirm',eventId:randomUUID(),expectedParticipationVersion:1,scopeVersion:1},[f.original.subjectId]);
 const selected=await peer.api.call('/v2/tasks/'+current.taskId,{}, {method:'GET'});return{task:selected,participant:selected.participations.find(item=>item.participationId===id)};
}

test('confirmed participant starts the neutral Task container with only their own signed work; exact recovery creates one Case and preserves the Task root',async t=>{
 const f=await fixture(t),{runtime:peer}=await f.makeOther(),peerId=(await peer.status()).identity.subjectId,current=await task(f,[peerId]),joined=await participate(f,current,peer),
  client=getFactClient(peer,peerId,{now:f.now}),rootBefore=(await f.f.db.query('SELECT payload_text,payload_hash FROM task_events WHERE task_id=$1 AND kind=$2',[current.taskId,'task-created'])).rows;
 assert.equal(rootBefore.length,1);
 assert.equal(joined.task.caseId,null);assert.equal(joined.participant.state,'active');let lose=true;
 f.wireHooks.after=(path,response)=>{if(lose&&path===`/v2/tasks/${current.taskId}/case`){lose=false;assert.equal(response.status,200);throw Error('synthetic first work ACK lost');}};
 await assert.rejects(client.submitFact(joined.task,null,joined.participant,fields(),{confirmed:true,viewers:[f.original.subjectId],synthetic:true}),/synthetic first work ACK lost/);
 const pending=await peer.getLocal(`task-fact-pending:${peerId}:${current.taskId}`),before=writes(f,`/v2/tasks/${current.taskId}/case`);
 assert.equal((await client.resumePending(current.taskId)).state,'acknowledged');assert.equal(writes(f,`/v2/tasks/${current.taskId}/case`),before);
 const parent=(await f.f.db.query('SELECT subject_id FROM cases WHERE id=$1',[pending.caseId])).rows[0],rows=(await f.f.db.query('SELECT subject_id,payload,consent_id FROM case_events WHERE case_id=$1 ORDER BY version',[pending.caseId])).rows;
 assert.equal(parent.subject_id,f.original.subjectId);assert.equal(rows.length,2);assert.ok(rows.every(row=>row.subject_id===peerId&&row.payload.actorId===peerId));
 assert.equal(rows[0].payload.summary,taskCaseContainerSummary);assert.equal(rows[0].payload.participationId,joined.participant.participationId);
 assert.equal(rows[1].payload.kind,'intervention');assert.equal(rows.filter(row=>row.payload.kind==='attempt-start').length,0);
 const grants=(await f.f.db.query('SELECT intent FROM consents WHERE id=ANY($1::uuid[])',[rows.map(row=>row.consent_id)])).rows.map(row=>row.intent);
 assert.ok(grants.every(grant=>grant.visibility==='Private'));assert.deepEqual(grants[0].viewers,grants[1].viewers);
 assert.deepEqual((await f.f.db.query('SELECT payload_text,payload_hash FROM task_events WHERE task_id=$1 AND kind=$2',[current.taskId,'task-created'])).rows,rootBefore);
 const requesterView=await f.runtime.api.call('/v2/cases/'+pending.caseId+'/read',{taskId:current.taskId});assert.equal(requesterView.interventions[0].actorId,peerId);
 assert.equal((await f.f.db.query('SELECT count(*)::int n FROM case_task_links WHERE task_id=$1',[current.taskId])).rows[0].n,1);
});

test('first participant work rejects outsider, withdrawn participation, changed scope and revoked scope authorization without creating a Case',async t=>{
 const f=await fixture(t),{runtime:peer}=await f.makeOther(),peerId=(await peer.status()).identity.subjectId,{runtime:outsider}=await f.makeOther(),outsiderId=(await outsider.status()).identity.subjectId;
 for(const mode of ['outsider','withdrawn','scope-changed','revoked']){
  const current=await task(f,[peerId,outsiderId]),joined=await participate(f,current,peer);let runtime=peer,actorId=peerId,participant=joined.participant;
  if(mode==='outsider'){runtime=outsider;actorId=outsiderId;participant={...participant,subjectId:outsiderId};}
  if(mode==='withdrawn')await write(peer,`/v2/participations/${participant.participationId}/events`,{kind:'withdraw',eventId:randomUUID(),expectedParticipationVersion:participant.version,reason:'本人结束参与'},[f.original.subjectId]);
  if(mode==='scope-changed'){
   const proposal=await write(f.runtime,`/v2/participations/${participant.participationId}/events`,{kind:'propose-scope',eventId:randomUUID(),expectedParticipationVersion:participant.version,scopeVersion:2,agreedScope:'新的有限范围',reason:'实际约定变化'},[peerId]);
   await write(peer,`/v2/participations/${participant.participationId}/events`,{kind:'confirm-scope',eventId:randomUUID(),expectedParticipationVersion:proposal.participationVersion,proposalId:proposal.eventId},[f.original.subjectId]);
  }
  if(mode==='revoked'){const event=(await f.f.db.query('SELECT consent_id,subject_id FROM task_events WHERE id=$1',[participant.scopeEventId])).rows[0];
   await (event.subject_id===peerId?peer:f.runtime).api.call('/v1/consents/'+event.consent_id+'/revoke',{});}
  const before=(await f.f.db.query('SELECT count(*)::int n FROM cases')).rows[0].n;
  const currentTask=await f.runtime.api.call('/v2/tasks/'+current.taskId,{}, {method:'GET'});
  await assert.rejects(getFactClient(runtime,actorId,{now:f.now}).submitFact({...joined.task,version:currentTask.version},null,participant,fields(),{confirmed:true,viewers:[f.original.subjectId],synthetic:true}),error=>['participation_not_authorized','participation_required','participation_scope_changed','consent_required'].includes(error.code),mode);
  assert.equal((await f.f.db.query('SELECT count(*)::int n FROM cases')).rows[0].n,before,mode);
  assert.equal((await f.f.db.query('SELECT case_id FROM task_requests WHERE id=$1',[current.taskId])).rows[0].case_id,null);
 }
});

test('Fact recovery only reads stale original authorization until a fresh exact preview is explicitly confirmed, and preserves stopped or expired work',async t=>{
 const f=await fixture(t),current=await task(f),client=getFactClient(f.runtime,f.original.subjectId,{now:f.now});let drop=true;
 f.wireHooks.before=path=>{if(drop&&path==='/v1/consents'){drop=false;throw Error('synthetic original work before consent');}};
 await assert.rejects(client.submitFact(current,null,null,fields(),{confirmed:true,viewers:[],synthetic:true,caseSummary:'合成工作'}),/synthetic original work/);
 const key=`task-fact-pending:${f.original.subjectId}:${current.taskId}`,original=await f.runtime.getLocal(key),deadline=original.authorizationExpiresAt;
 const oldSignature=original.items[0].authorization.signedIntent;f.setTime(f.now()+301);await f.runtime.connect({confirmed:true});
 let start=f.requests.length;
 const [a,b]=await Promise.all([client.resumePending(current.taskId),client.resumePending(current.taskId)]);assert.equal(a.reason,'original-binding-changed');assert.equal(b.reason,'original-binding-changed');
 assert.equal(f.requests.slice(start).some(row=>row.path==='/v1/consents'||row.path.endsWith('/case')),false);
 assert.equal((await f.runtime.getLocal(key)).items[0].authorization.signedIntent,oldSignature);
 const preview=await client.prepareRetry(current.taskId);assert.equal(preview.items[0].payloadJson,original.items[0].payloadJson);
 assert.deepEqual(preview.viewers,original.viewers);assert.equal((await client.confirmRetry(preview,{confirmed:true})).caseId,original.caseId);
 assert.equal((await client.resumePending(current.taskId)).state,'acknowledged');
 const grants=(await f.f.db.query('SELECT intent FROM consents WHERE intent->>\'objectId\'=ANY($1::text[])',[original.items.map(item=>item.payload.eventId)])).rows;
 assert.equal(grants.length,2);assert.ok(grants.every(row=>row.intent.expiresAt>deadline&&row.intent.viewers.length===0));
 const second=await task(f);drop=true;await assert.rejects(client.submitFact(second,null,null,fields(),{confirmed:true,viewers:[],synthetic:true,caseSummary:'合成停止'}));
 await client.stopRetry(second.taskId,{confirmed:true});const writesBefore=f.requests.filter(row=>row.path==='/v1/consents'||row.path.endsWith('/case')).length;
 assert.equal((await client.resumePending(second.taskId)).localRetryStopped,true);assert.equal(f.requests.filter(row=>row.path==='/v1/consents'||row.path.endsWith('/case')).length,writesBefore);
 const third=await task(f);drop=true;await assert.rejects(client.submitFact(third,null,null,fields(),{confirmed:true,viewers:[],synthetic:true,caseSummary:'合成到期'}));
 const thirdKey=`task-fact-pending:${f.original.subjectId}:${third.taskId}`;await f.runtime.getLocal(thirdKey);
 for(const pin of f.services.bindings.trustedKeys.values())pin.notAfter+=4000000;
 f.setTime(f.now()+2591901);await f.runtime.connect({confirmed:true});
 start=f.requests.length;assert.equal((await client.resumePending(third.taskId)).reason,'authorization-expired');assert.equal(f.requests.slice(start).some(row=>row.path==='/v1/consents'||row.path.endsWith('/case')),false);
});

test('Fact resumes same-binding aged transport without changing the fixed choice or replacing an already accepted bundle Consent',async t=>{
 const f=await fixture(t),current=await task(f),client=getFactClient(f.runtime,f.original.subjectId,{now:f.now});let seen=0;
 f.wireHooks.before=path=>{if(path==='/v1/consents'&&++seen===2)throw Error('synthetic second work signature before receipt');};
 await assert.rejects(client.submitFact(current,null,null,fields(),{confirmed:true,synthetic:true}),/synthetic second work signature/);
 const key=`task-fact-pending:${f.original.subjectId}:${current.taskId}`,original=await f.runtime.getLocal(key);
 assert.ok(original.items[0].submission);assert.equal(original.items[1].submission,undefined);
 f.setTime(f.now()+301);const accepted=await client.resumePending(current.taskId);assert.equal(accepted.caseId,original.caseId);
 const events=(await f.f.db.query('SELECT payload_text,consent_id FROM case_events WHERE case_id=$1 ORDER BY version',[original.caseId])).rows;
 assert.equal(events[0].consent_id,original.items[0].authorization.intent.id);assert.notEqual(events[1].consent_id,original.items[1].authorization.intent.id);
 assert.deepEqual(events.map(row=>row.payload_text),original.items.map(item=>item.payloadJson));
 const renewed=(await f.f.db.query('SELECT intent FROM consents WHERE id=$1',[events[1].consent_id])).rows[0].intent;
 assert.equal(renewed.bindingId,original.items[1].authorization.intent.bindingId);assert.equal(renewed.expiresAt,original.authorizationExpiresAt);assert.deepEqual(renewed.viewers,original.viewers);
 const legacyTask=await task(f);seen=0;f.wireHooks.before=path=>{if(path==='/v1/consents'&&++seen===1)throw Error('synthetic legacy before consent');};
 await assert.rejects(client.submitFact(legacyTask,null,null,fields(),{confirmed:true,synthetic:true}));
 await f.runtime.updateLocal(`task-fact-pending:${f.original.subjectId}:${legacyTask.taskId}`,record=>{delete record.authorizationBindingId;delete record.items[0].authorization;return record;});
 const start=f.requests.length;assert.equal((await client.resumePending(legacyTask.taskId)).reason,'original-binding-unavailable');
 assert.ok(f.requests.slice(start).every(item=>item.path!=='/v1/consents'&&!item.path.endsWith('/case')));
});

test('requester first work needs no container description; a confirmed compose revision survives lost ACK and clears only the original editing draft',async t=>{
 const f=await fixture(t),current=await task(f),client=getFactClient(f.runtime,f.original.subjectId,{now:f.now}),
  editing={kind:'intervention',form:{description:fields().description,observedEffect:fields().observedEffect},participationId:null,viewers:[],selected:[]},
  saved=await client.saveComposeDraft(current.taskId,editing,{expectedRevision:null});let lose=true;
 f.wireHooks.after=(path,response)=>{if(lose&&path===`/v2/tasks/${current.taskId}/case`){lose=false;assert.equal(response.status,200);throw Error('synthetic composed fact ACK lost');}};
 await assert.rejects(client.submitFact(current,null,null,fields(),{confirmed:true,viewers:[],synthetic:true,composeRevision:saved.revision}),/synthetic composed fact ACK lost/);
 const journal=await f.runtime.getLocal(`task-fact-pending:${f.original.subjectId}:${current.taskId}`),other=getFactClient({...f.runtime},f.original.subjectId,{now:f.now}),
  retained=await other.readComposeDraft(current.taskId);assert.deepEqual(retained.value,editing);
 assert.equal(retained.revision,saved.revision);assert.equal(retained.operationId,journal.operationId);assert.equal(retained.submission,'result-unknown');
 assert.equal(journal.items[0].payload.summary,taskCaseContainerSummary);
 const before=writes(f,`/v2/tasks/${current.taskId}/case`);assert.equal((await other.resumePending(current.taskId)).state,'acknowledged');
 assert.equal(writes(f,`/v2/tasks/${current.taskId}/case`),before);assert.equal(await other.readComposeDraft(current.taskId),null);
 assert.equal((await f.f.db.query('SELECT count(*)::int n FROM case_events WHERE case_id=$1',[journal.caseId])).rows[0].n,2);
 const actual=await f.runtime.api.call('/v2/tasks/'+current.taskId,undefined,{method:'GET'}),facts=await other.readCase(actual),
  evidence={kind:'evidence',expectedVersion:0,evidenceType:'self-assertion',source:{originSystem:'isolated-local-fixture',externalStableId:'local:'+randomUUID(),
   contentVersion:'1',originalAt:new Date(f.now()*1000).toISOString(),issuer:'合成测试者'},observedAt:new Date(f.now()*1000).toISOString(),
   reportedSourceState:'unknown',summary:'只记录这一项本人合成来源'},
  evidenceDraft=await other.saveComposeDraft(current.taskId,{kind:'evidence',form:{summary:evidence.summary}});let loseEvidence=true;
 f.wireHooks.after=(path,response)=>{if(loseEvidence&&path==='/v2/verification-records/submit'){loseEvidence=false;assert.equal(response.status,200);throw Error('synthetic composed evidence ACK lost');}};
 await assert.rejects(other.submitRecord(actual,facts,null,evidence,{confirmed:true,composeRevision:evidenceDraft.revision}),/synthetic composed evidence ACK lost/);
 assert.equal((await other.readComposeDraft(current.taskId)).submission,'result-unknown');
 assert.equal((await other.resumePending(current.taskId)).state,'acknowledged');assert.equal(await other.readComposeDraft(current.taskId),null);

 const second=await task(f),prior=await client.saveComposeDraft(second.taskId,editing,{expectedRevision:null}),
  newer=await other.saveComposeDraft(second.taskId,{...editing,form:{description:'第二页面的新编辑'}},{expectedRevision:prior.revision});
 await assert.rejects(client.saveComposeDraft(second.taskId,{...editing,form:{description:'较早页面尚未保存的输入'}},{expectedRevision:prior.revision}),error=>error.code==='fact_compose_draft_changed');
 await assert.rejects(client.saveComposeDraft(second.taskId,{...editing,form:{description:'不能将旧页面当首次空稿'}},{expectedRevision:null}),error=>error.code==='fact_compose_draft_changed');
 assert.equal((await client.readComposeDraft(second.taskId)).value.form.description,'第二页面的新编辑');
 const start=f.requests.length;await assert.rejects(client.submitFact(second,null,null,fields(),{confirmed:true,composeRevision:prior.revision}),error=>error.code==='fact_compose_draft_changed');
 assert.equal(f.requests.length,start);assert.equal(await client.pending(second.taskId),null);
 assert.equal((await client.readComposeDraft(second.taskId)).revision,newer.revision);
 const deliver=await client.saveComposeDraft(second.taskId,{kind:'deliver',form:{summary:'这是Task交付，不是Fact'}});
 await assert.rejects(client.submitFact(second,null,null,fields(),{confirmed:true,composeRevision:deliver.revision}),error=>error.code==='fact_compose_draft_changed');
 assert.equal((await client.readComposeDraft(second.taskId)).operationId,null);
});

test('an original Fact acknowledgement cannot clear later editing or silently bind a draft from another page',async t=>{
 const f=await fixture(t),current=await task(f),client=getFactClient(f.runtime,f.original.subjectId,{now:f.now}),other=getFactClient({...f.runtime},f.original.subjectId,{now:f.now}),
  editing={kind:'intervention',form:{description:'本次确认的编辑'}},saved=await client.saveComposeDraft(current.taskId,editing);
 let entered,release;const reached=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});let hold=true;
 f.wireHooks.after=async(path,response)=>{if(hold&&path===`/v2/tasks/${current.taskId}/case`){hold=false;assert.equal(response.status,200);entered();await barrier;}};
 const first=client.submitFact(current,null,null,fields(),{confirmed:true,synthetic:true,composeRevision:saved.revision});await reached;
 const next=await other.saveComposeDraft(current.taskId,{...editing,form:{description:'原确认之后的新编辑'}});assert.notEqual(next.revision,saved.revision);
 release();await first;let retained=await client.readComposeDraft(current.taskId);assert.equal(retained.revision,next.revision);
 assert.equal(retained.operationId,null);assert.equal(retained.submission,'draft');
 const second=await task(f),unbound=await client.saveComposeDraft(second.taskId,editing);
 await client.submitFact(second,null,null,fields(),{confirmed:true,synthetic:true,caseSummary:'请求者显式输入的旧背景'});
 retained=await client.readComposeDraft(second.taskId);assert.equal(retained.revision,unbound.revision);assert.equal(retained.operationId,null);
 const actual=await f.runtime.api.call('/v2/tasks/'+second.taskId,undefined,{method:'GET'}),facts=await client.readCase(actual);
 assert.equal(facts.events[0].summary,'请求者显式输入的旧背景');
});

test('Capsule original permissions resume same bytes and deadline; accepted unknown or stopped operations never repeat writes',async t=>{
 const f=await fixture(t),subjectId=f.original.subjectId,id=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:subjectId,localRef:randomUUID(),title:'合成方法来源',summary:'只有本地材料',synthetic:true,source:{kind:'local',reference:randomUUID()}};
 await write(f.runtime,'/v2/cases/events',root,[],'case.teaser.publish');
 const client=createCapsuleWebClient({api:f.runtime.api,subjectId,now:f.now,getLocal:key=>f.runtime.getLocal(key,subjectId),putLocal:(key,value)=>f.runtime.putLocal(key,value,subjectId)}),
  payload=()=>({schemaVersion:2,kind:'grant',id:randomUUID(),sources:[{kind:'case-root',id,version:1,caseId:id}],grantees:[subjectId],license:'MIT',scope:'仅合成方法来源',basis:'authored-content',attribution:'本人合成来源',allowPublic:false});
 let drop=true;f.wireHooks.before=path=>{if(drop&&path==='/v1/consents'){drop=false;throw Error('synthetic capsule before consent');}};
 const p=await client.prepare('permission',payload());await assert.rejects(client.execute(p,{confirmed:true}),/synthetic capsule before consent/);
 const original=await f.runtime.getLocal(`capsule-operations:${f.runtime.api.endpoint}:${subjectId}`),deadline=original.active.authorizationExpiresAt;f.setTime(f.now()+301);
 assert.equal((await client.resumePending()).state,'acknowledged');const stored=(await f.f.db.query('SELECT intent FROM consents WHERE intent->>\'objectId\'=$1',[p.operationId])).rows[0].intent;
 assert.equal(stored.expiresAt,deadline);assert.equal(stored.payloadHash,p.payloadHash);assert.equal(await f.runtime.getLocal('capsule-draft:'+f.runtime.api.endpoint+':'+subjectId),undefined);
 assert.equal(stored.bindingId,original.active.prepared.intent.bindingId);assert.notEqual(stored.id,original.active.prepared.intent.id);
 drop=true;const changed=await client.prepare('permission',payload());await assert.rejects(client.execute(changed,{confirmed:true}));
 const changedOriginal=(await f.runtime.getLocal(`capsule-operations:${f.runtime.api.endpoint}:${subjectId}`)).active;
 await f.runtime.connect({confirmed:true});const start=f.requests.length;
 assert.equal((await client.resumePending()).reason,'original-binding-changed');
 assert.ok(f.requests.slice(start).every(item=>item.path!=='/v1/consents'&&item.path!=='/v2/capsules/permissions'));
 assert.equal((await f.runtime.getLocal(`capsule-operations:${f.runtime.api.endpoint}:${subjectId}`)).active.prepared.signedIntent,changedOriginal.prepared.signedIntent);
 const review=await client.reviewAuthorization(changed.operationId);assert.equal(review.state,'reauthorization-required');assert.equal(review.expiresAt,changedOriginal.authorizationExpiresAt);
 assert.deepEqual(review.payload,changedOriginal.payload);assert.equal((await client.reauthorize(changed.operationId,review,{confirmed:true})).state,'acknowledged');
 let lose=true;f.wireHooks.after=(path,response)=>{if(lose&&path==='/v2/capsules/permissions'){lose=false;assert.equal(response.status,200);throw Error('synthetic capsule ACK lost');}};
 const p2=await client.prepare('permission',payload());await assert.rejects(client.execute(p2,{confirmed:true}),/synthetic capsule ACK lost/);
 let before=writes(f,'/v2/capsules/permissions');assert.equal((await client.resumePending()).state,'acknowledged');assert.equal(writes(f,'/v2/capsules/permissions'),before);
 let stop=true;f.wireHooks.before=path=>{if(stop&&path==='/v2/capsules/permissions'){stop=false;throw Error('synthetic capsule before business');}};
 const p3=await client.prepare('permission',payload());await assert.rejects(client.execute(p3,{confirmed:true}));await client.stopLocalRetry(p3.operationId,{confirmed:true});
 before=writes(f,'/v2/capsules/permissions');assert.equal((await client.resumePending()).stopped[0].localRetryStopped,true);assert.equal(writes(f,'/v2/capsules/permissions'),before);
 drop=true;f.wireHooks.before=path=>{if(drop&&path==='/v1/consents'){drop=false;throw Error('synthetic short Capsule permission');}};
 const short=await client.prepare('permission',{...payload(),expiresAt:new Date((f.now()+10)*1000).toISOString()});await assert.rejects(client.execute(short,{confirmed:true}));
 f.setTime(f.now()+11);before=writes(f,'/v1/consents');assert.equal((await client.resumePending()).reason,'authorization-expired');assert.equal(writes(f,'/v1/consents'),before);
 const originalShort=(await f.runtime.getLocal(`capsule-operations:${f.runtime.api.endpoint}:${subjectId}`)).active,
  renewal=await client.reviewAuthorization(short.operationId);assert.equal(renewal.state,'reauthorization-required');assert.equal(renewal.payloadHash,originalShort.payloadHash);
 assert.deepEqual(renewal.payload,originalShort.payload);assert.deepEqual(renewal.viewers,originalShort.viewers);
 await assert.rejects(client.reauthorize(short.operationId,renewal,{confirmed:true}),error=>error.code==='capsule_permission_expired','new Consent cannot extend the original payload license deadline');
 await client.stopLocalRetry(short.operationId,{confirmed:true});
 let freeze=true;const blockedApi={...f.runtime.api,prepareAuthorization:async(...args)=>{if(freeze){freeze=false;throw Error('synthetic before signing');}return f.runtime.api.prepareAuthorization(...args);}},
  unsigned=createCapsuleWebClient({api:blockedApi,subjectId,operationFamily:'configuration',now:f.now,getLocal:key=>f.runtime.getLocal(key,subjectId),putLocal:(key,value)=>f.runtime.putLocal(key,value,subjectId)}),
  unsignedPayload={schemaVersion:2,kind:'record',id:randomUUID(),operationId:randomUUID(),expectedVersion:0,actorId:subjectId,title:'本人合成选定条件',summary:'没有自动发现环境',
   conditions:{model:{name:null,version:null},runtime:{name:'Node',version:'24'},environment:{name:'isolated-fixture',version:'1'},tools:[],skills:[],mcp:[],
    promptPolicyVersion:null,rulesVersion:null,operationScope:['read-selected'],inputScopeSummary:'本地合成条件',limitations:'只记录选定测试条件'},
   observedAt:new Date(f.now()*1000).toISOString(),synthetic:true,selectedFieldsOnly:true},
  unsignedPreview=await unsigned.prepare('configuration',unsignedPayload);await assert.rejects(unsigned.execute(unsignedPreview,{confirmed:true}),/synthetic before signing/);
 const unsignedOriginal=(await f.runtime.getLocal(`configuration-operations:${f.runtime.api.endpoint}:${subjectId}`)).active;assert.equal(unsignedOriginal.prepared,undefined);
 for(const pin of f.services.bindings.trustedKeys.values())pin.notAfter+=4000000;f.setTime(f.now()+2591901);await f.runtime.connect({confirmed:true});
 assert.equal((await unsigned.resumePending()).reason,'authorization-expired');const unsignedReview=await unsigned.reviewAuthorization(unsignedPreview.operationId);
 assert.equal(unsignedReview.state,'reauthorization-required');assert.equal(unsignedReview.consentId,null);assert.deepEqual(unsignedReview.payload,unsignedOriginal.payload);
 assert.equal((await unsigned.reauthorize(unsignedPreview.operationId,unsignedReview,{confirmed:true})).state,'acknowledged');
});
