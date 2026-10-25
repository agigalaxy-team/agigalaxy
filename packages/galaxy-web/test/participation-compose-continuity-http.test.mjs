import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {privacyConsumerFixture} from "../../galaxy-official/test/privacy-consumer-continuity-workflow.mjs";
import {getFactClient,exactFactRef} from "../src/features/work-records/client.mjs";

// Actual signed HTTP, current Task/Case permissions and PGlite. The local Map
// journal controls await boundaries; these checks do not replace browser IDB.
async function signed(runtime,path,payload,viewers=[]){
 return runtime.api.call(path,await runtime.api.authorizePayload(payload,{
  action:'assistance.publish',objectId:payload.operationId??payload.eventId,visibility:'Private',viewers,confirmed:true,
 }));
}
async function work(f){
 const {runtime:peer,journal}=await f.makeOther(),subjectId=(await peer.status()).identity.subjectId,taskId=randomUUID(),participationId=randomUUID();
 await signed(f.runtime,'/v2/tasks',{operationId:randomUUID(),taskId,caseId:null,intent:'collaboration',title:'[合成] 交付草稿接续',
  summary:'只有隔离测试的实际工作',workContext:{goal:'关联实际本人交付',currentSituation:'先记录真实复核与结果',attemptRefs:[]},
  visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now()+86400},[subjectId]);
 await signed(f.runtime,`/v2/tasks/${taskId}/participations`,{kind:'propose',eventId:randomUUID(),expectedTaskVersion:1,participationId,
  subjectId,role:'review',scopeVersion:1,agreedScope:'本地合成的有限复核'},[subjectId]);
 await signed(peer,`/v2/participations/${participationId}/events`,{kind:'confirm',eventId:randomUUID(),expectedParticipationVersion:1,scopeVersion:1},[f.original.subjectId]);
 let task=await peer.api.call('/v2/tasks/'+taskId,undefined,{method:'GET'});const participant=task.participations.find(x=>x.participationId===participationId);
 const client=getFactClient(peer,subjectId,{now:f.now});
 await client.submitFact(task,null,participant,{kind:'intervention',types:['review'],affectsAttemptIds:[],description:'本人合成复核',
  sourceRefs:[],observedEffect:'只观察隔离样例'},{confirmed:true,viewers:[f.original.subjectId],synthetic:true});
 task=await peer.api.call('/v2/tasks/'+taskId,undefined,{method:'GET'});let facts=await client.readCase(task);const intervention=facts.interventions[0];
 await client.submitFact(task,facts,participant,{kind:'result-recorded',origin:{kind:'intervention',...exactFactRef(intervention)},scopeVersion:intervention.scopeVersion,
  deliverableRefs:[],reportedOutcome:'partial',summary:'本人合成复核得到有限结果',limitations:'没有生产或外部运行证据',supersedes:null},{confirmed:true,viewers:[f.original.subjectId]});
 facts=await client.readCase(task);const result=facts.results[0],delivery={kind:'deliver',expectedParticipationVersion:participant.version,
  resultRef:exactFactRef(result),interventionRefs:[exactFactRef(intervention)],evidenceRefs:[],summary:'这次明确交付有限复核结果'},
  editing={kind:'deliver',participationId,form:{summary:delivery.summary,sourceChoice:result.id+':'+result.version},selected:[],related:[intervention.id+':'+intervention.version],resultRef:delivery.resultRef};
 return{peer,journal,taskId,participationId,subjectId,client,delivery,editing,path:`/v2/participations/${participationId}/events`,viewers:[f.original.subjectId]};
}
const writes=(f,path)=>f.requests.filter(row=>row.path===path).length;

test('delivery editing survives close and conflict; exact Task ACK clears only its explicit revision, with no Fact ACK association',async t=>{
 const f=await privacyConsumerFixture();t.after(()=>f.close());const w=await work(f),{peer,taskId,participationId}=w;
 const before=f.requests.length,saved=await peer.saveParticipationComposeDraft(taskId,participationId,w.editing,{expectedRevision:null});
 assert.equal(f.requests.length,before,'editing performs no network action');
 assert.equal(saved.eventId,null);assert.equal((await peer.readParticipationComposeDraft(taskId,participationId)).submission,'draft');
 await peer.disconnect();assert.equal((await peer.readParticipationComposeDraft(taskId,participationId)).revision,saved.revision);await peer.connect({confirmed:true});
 await assert.rejects(peer.saveParticipationComposeDraft(taskId,participationId,{...w.editing,form:{summary:'older page input'}},{expectedRevision:null}),error=>error.code==='participation_compose_changed');
 assert.deepEqual((await peer.readParticipationComposeDraft(taskId,participationId)).value,w.editing);
 await assert.rejects(peer.participationEvent(taskId,participationId,w.delivery,{confirmed:true,viewers:w.viewers,composeRevision:randomUUID()}),error=>error.code==='participation_compose_revision_mismatch');
 const factsDraft=await w.client.saveComposeDraft(taskId,{kind:'intervention',form:{description:'另一份尚未提交的事实编写'}});
 let lose=true;f.wireHooks.after=(path,response)=>{if(lose&&path===w.path){lose=false;assert.equal(response.status,200);throw Error('synthetic delivery ACK lost');}};
 await assert.rejects(peer.participationEvent(taskId,participationId,w.delivery,{confirmed:true,viewers:w.viewers,composeRevision:saved.revision}),/delivery ACK lost/);
 const journal=await peer.getLocal('task-event:'+taskId),retained=await peer.readParticipationComposeDraft(taskId,participationId);
 assert.equal(retained.eventId,journal.eventId);assert.equal(retained.submission,'result-unknown');assert.equal(journal.composeRevision,saved.revision);
 assert.equal(journal.participationId,participationId);assert.equal((await w.client.readComposeDraft(taskId)).revision,factsDraft.revision);
 const calls=writes(f,w.path);
 await assert.rejects(peer.participationEvent(taskId,participationId,w.delivery,{confirmed:true,viewers:w.viewers,composeRevision:saved.revision}),/上一次操作/);
 assert.equal(writes(f,w.path),calls);
 const recovered=await peer.resumeTaskEvent(taskId);assert.equal(recovered.eventId,journal.eventId);assert.equal(recovered.localDraftCleanup.state,'cleared');
 assert.equal(writes(f,w.path),calls);assert.equal(await peer.readParticipationComposeDraft(taskId,participationId),null);
 assert.equal((await w.client.readComposeDraft(taskId)).revision,factsDraft.revision);
 const locator=await peer.getLocal('task-event-receipt:'+journal.eventId);
 assert.equal(locator.state,'acknowledged');assert.equal(locator.payloadHash,journal.payloadHash);assert.equal(locator.currentAccessGranted,false);
 assert.equal(locator.payloadJson,undefined);assert.equal(locator.summary,undefined);
 assert.equal((await f.f.db.query("SELECT count(*)::int n FROM task_events WHERE task_id=$1 AND kind='deliver'",[taskId])).rows[0].n,1);
 const {runtime:other}=await f.makeOther();assert.equal(await other.readParticipationComposeDraft(taskId,participationId),null);
});

test('late delivery ACK and stopped original queries preserve later editing; stale clears and unrelated participation events cannot take its revision',async t=>{
 const f=await privacyConsumerFixture();t.after(()=>f.close());const w=await work(f),{peer,taskId,participationId}=w,
  first=await peer.saveParticipationComposeDraft(taskId,participationId,w.editing,{expectedRevision:null});
 let reached,release,hold=true;const entered=new Promise(resolve=>{reached=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
 f.wireHooks.after=async(path,response)=>{if(hold&&path===w.path){hold=false;assert.equal(response.status,200);reached();await barrier;}};
 const sending=peer.participationEvent(taskId,participationId,w.delivery,{confirmed:true,viewers:w.viewers,composeRevision:first.revision});await entered;
 const next=await peer.saveParticipationComposeDraft(taskId,participationId,{...w.editing,form:{summary:'确认之后另写的交付编辑'}},{expectedRevision:first.revision});
 assert.notEqual(next.revision,first.revision);release();assert.equal((await sending).localDraftCleanup.state,'retained');
 assert.equal((await peer.readParticipationComposeDraft(taskId,participationId)).revision,next.revision);
 assert.equal((await peer.clearParticipationComposeDraft(taskId,participationId,{revision:first.revision})).revision,next.revision);
 const current=await peer.api.call('/v2/tasks/'+taskId,undefined,{method:'GET'}),participant=current.participations.find(x=>x.participationId===participationId);
 await assert.rejects(peer.participationEvent(taskId,participationId,{kind:'withdraw',expectedParticipationVersion:participant.version,reason:'本地明确退出'},
  {confirmed:true,viewers:w.viewers,composeRevision:next.revision}),error=>error.code==='participation_compose_revision_mismatch');
 let drop=true;f.wireHooks.before=path=>{if(drop&&path===w.path){drop=false;throw Error('synthetic original delivery before service');}};
 const delivery={...w.delivery,expectedParticipationVersion:participant.version,summary:'第二次明确选择的交付'};
 await assert.rejects(peer.participationEvent(taskId,participationId,delivery,{confirmed:true,viewers:w.viewers,composeRevision:next.revision}),/before service/);
 const original=await peer.getLocal('task-event:'+taskId),stop=await peer.reviewTaskStop(taskId);
 await peer.stopTaskOperation(stop,{taskId,confirmed:true});
 assert.equal((await peer.readParticipationComposeDraft(taskId,participationId)).submission,'stopped-local');
 let calls=writes(f,w.path);assert.equal((await peer.resumeTaskEvent(taskId)).state,'none');
 assert.equal((await peer.queryStoppedTaskOperation(original.eventId,{taskId})).receipt.state,'absent');assert.equal(writes(f,w.path),calls);
 // A response already handed to another sender may still arrive. Read only
 // its exact receipt, rather than reviving the local stopped operation.
 await peer.api.call(w.path,original.submission);calls=writes(f,w.path);
 const acknowledged=await peer.queryStoppedTaskOperation(original.eventId,{taskId});assert.equal(acknowledged.receipt.state,'acknowledged');
 assert.equal(acknowledged.localDraftCleanup.state,'cleared');assert.equal(writes(f,w.path),calls);
 assert.equal(await peer.readParticipationComposeDraft(taskId,participationId),null);
 assert.equal((await peer.stoppedTaskOperations(taskId))[0].payloadJson,undefined);
});

test('delivery editing is withheld after a same-subject binding changes during its local read',async t=>{
 const f=await privacyConsumerFixture();t.after(()=>f.close());const taskId=randomUUID(),participationId=randomUUID(),
  saved=await f.runtime.saveParticipationComposeDraft(taskId,participationId,{kind:'deliver',form:{summary:'只属于原本机读取的交付编辑'}},{expectedRevision:null});
 let reached,release,hold=true;const entered=new Promise(resolve=>{reached=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
 f.journal.hooks.get=async key=>{if(hold&&key.endsWith(`:participation-compose:${taskId}:${participationId}`)){hold=false;reached();await barrier;}};
 const reading=f.runtime.readParticipationComposeDraft(taskId,participationId),rejected=assert.rejects(reading,error=>error.code==='task_draft_scope_changed');
 await entered;await f.runtime.connect({confirmed:true});release();await rejected;f.journal.hooks.get=null;
 assert.equal((await f.runtime.readParticipationComposeDraft(taskId,participationId)).revision,saved.revision);
 assert.equal(f.requests.some(row=>row.path===`/v2/participations/${participationId}/events`),false);
});
