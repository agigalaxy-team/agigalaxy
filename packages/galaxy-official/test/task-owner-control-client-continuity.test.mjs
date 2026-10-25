import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createNativeRecoveryWebFixture as createExistingWebRuntime} from './native-recovery-web-fixture.mjs';
import {createTaskOwnerReadClient} from '../../galaxy-web/src/task-owner-read-client.mjs';
import {createTaskOwnerControlClient} from '../../galaxy-web/src/task-owner-control-client.mjs';
import {createRecoveryMaterial} from '../../galaxy-core/src/domain/identity-material.mjs';

const changed=error=>error.code==='task_owner_control_connection_changed',deferred=()=>{let resolve;return{promise:new Promise(r=>{resolve=r;}),resolve:()=>resolve()};};
async function fixture({legacyFault=null,legacyKind='cancel',legacySpaced=false}={}){
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000}),keys=new Map(),files=new Map(),runtimes=[];
 const directory=await mkdtemp(join(tmpdir(),'galaxy-owner-control-journal-'));let runtime,onGet,onPut,loseAck=false,offline=false,legacyArmed=false,legacyRecord;
 const writes=[];
 // Real filesystem persists the exact control journal across runtime reloads.
 // Device key material stays only in the Map contract fixture, never on disk.
 const isJournal=key=>key.includes(':task-owner-control:'),filename=key=>join(directory,createHash('sha256').update(key).digest('hex')+'.json');
 const get=async key=>{let value;if(isJournal(key)){try{value=JSON.parse(await readFile(filename(key),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}}
  else value=structuredClone(keys.get(key));await onGet?.(key,value);return value;};
 const put=async(key,value)=>{if(isJournal(key)){const file=filename(key);await writeFile(file+'.tmp',JSON.stringify(value));await rename(file+'.tmp',file);files.set(key,file);}
  else keys.set(key,structuredClone(value));await onPut?.(key,value);};
 const store={get,put,async update(key,fn){const next=fn(structuredClone(keys.get(key)));if(next&&typeof next.then==='function'){if(next instanceof Promise)void next.catch(()=>{});throw Error('local_update_async_callback');}const committed=structuredClone(next);keys.set(key,committed);return structuredClone(committed);},async prepareRecovery(subjectId,operationId){const key=`pending-recovery:${subjectId}:${operationId}`;
  let v=await get(key);if(!v){v={...await createRecoveryMaterial(subjectId),operationId};await put(key,v);}return v;},
  async declareSaved(subjectId,id){const key=`pending-recovery:${subjectId}:${id}`;await put(key,{...await get(key),saveDeclared:true});},
  async recordReceipt(subjectId,id,receipt){const key=`pending-recovery:${subjectId}:${id}`;await put(key,{...await get(key),receipt});}};
 let origin;
 const start=async()=>{const r=await createExistingWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{store,now:()=>f.now,
  fetch:async(url,options)=>{const path=new URL(url).pathname;if(offline&&path==='/v2/tasks/receipt')throw new Error('synthetic receipt offline');
   if(legacyArmed&&path.endsWith('/events')&&legacyFault==='absent'){legacyArmed=false;throw new Error('synthetic legacy dispatch unavailable');}
   if(path==='/v1/consents'||path.endsWith('/owner-control'))writes.push(path);const response=await fetch(origin+path,options);
   if(legacyArmed&&path.endsWith('/events')&&response.ok){legacyArmed=false;await response.text();throw new Error('synthetic legacy committed ACK lost');}
   if(loseAck&&path.endsWith('/owner-control')&&response.ok){loseAck=false;await response.text();throw new Error('synthetic committed ACK lost');}return response;}});
  runtimes.push(r);return r;};
 try{
  await new Promise(r=>api.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${api.address().port}`;runtime=await start();
  await runtime.connect({confirmed:true});const recovery=await runtime.prepareRecovery();await runtime.saveRecovery({operationId:recovery.operationId,confirmed:true});
  const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'Synthetic original private work',
   summary:'Do not transform the partial projection into a complete Task',workContext:{goal:'Keep original facts',currentSituation:'Same-ID device recovery',attemptRefs:[]},
   visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+10000};
  const original=await runtime.api.authorizePayload(task,{action:'assistance.publish',objectId:task.operationId,visibility:'Private',expiresAt:f.now+7200,confirmed:true});
  await runtime.api.call('/v2/tasks',original);
  if(legacyFault){legacyArmed=true;const event=legacyKind==='cancel'?{kind:'cancel',eventId:randomUUID(),expectedTaskVersion:1,reason:input.reason}:
   {kind:'invite',eventId:randomUUID(),expectedTaskVersion:1,recipientId:f.actor.subjectId,note:'Synthetic original distinct invitation',expiresAt:f.now+600};
   await assert.rejects(runtime.taskEvent(task.taskId,event,{viewers:legacyKind==='cancel'?[]:[f.actor.subjectId],confirmed:true}));
   legacyRecord=await runtime.getLocal('task-event:'+task.taskId);assert.equal(legacyRecord.state,'result-unknown');
   if(legacySpaced){legacyRecord.payloadJson='\n'+legacyRecord.payloadJson;legacyRecord.payloadHash=createHash('sha256').update(legacyRecord.payloadJson).digest('hex');
    legacyRecord.preparedConsent=await runtime.api.prepareAuthorization(legacyRecord.payloadJson,{action:'assistance.publish',objectId:legacyRecord.eventId,
     visibility:'Private',expiresAt:f.now+3600,confirmed:true});legacyRecord.submission=await runtime.api.submitAuthorization(legacyRecord.preparedConsent,{confirmed:true});
    await runtime.putLocal('task-event:'+task.taskId,legacyRecord);}
  }
  const recoveredMaterial=await runtime.recover(recovery.code,{confirmed:true});await runtime.confirmRecoveredCode({operationId:recoveredMaterial.operationId,confirmed:true});await runtime.connect({confirmed:true});writes.length=0;
  const switchOwner=async()=>{const data=new Map(),getOther=async k=>structuredClone(data.get(k)),putOther=async(k,v)=>data.set(k,structuredClone(v));
   const otherStore={get:getOther,put:putOther,async update(key,fn){const next=fn(structuredClone(data.get(key)));if(next&&typeof next.then==='function'){if(next instanceof Promise)void next.catch(()=>{});throw Error('local_update_async_callback');}const committed=structuredClone(next);data.set(key,committed);return structuredClone(committed);},async prepareRecovery(subjectId,operationId){const key=`pending-recovery:${subjectId}:${operationId}`;
    let v=await getOther(key);if(!v){v={...await createRecoveryMaterial(subjectId),operationId};await putOther(key,v);}return v;},
    async declareSaved(subjectId,id){const key=`pending-recovery:${subjectId}:${id}`;await putOther(key,{...await getOther(key),saveDeclared:true});},
    async recordReceipt(subjectId,id,receipt){const key=`pending-recovery:${subjectId}:${id}`;await putOther(key,{...await getOther(key),receipt});}};
   const other=await createExistingWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{store:otherStore,now:()=>f.now,
    fetch:(url,options)=>fetch(origin+new URL(url).pathname,options)});runtimes.push(other);
   await other.connect({confirmed:true});const material=await other.prepareRecovery();await other.saveRecovery({operationId:material.operationId,confirmed:true});
   const recoveredOther=await runtime.recover(material.code,{confirmed:true});await runtime.confirmRecoveredCode({operationId:recoveredOther.operationId,confirmed:true});await runtime.connect({confirmed:true});
  };
  return{f,task,original,legacyRecord,writes,subjectId:runtime.api.snapshot().subjectId,get runtime(){return runtime;},store,directory,
   switchOwner,
   setGet:fn=>{onGet=fn;},setPut:fn=>{onPut=fn;},loseAck:()=>{loseAck=true;},offline:value=>{offline=value;},
   reload:async()=>{runtime.close();runtime=await start();await runtime.connect({confirmed:true});return runtime;},
   journal:async()=>{const result=[];for(const file of files.values())result.push(JSON.parse(await readFile(file,'utf8')));return result;},
   count:async()=>Number((await f.db.query("SELECT count(*) FROM task_events WHERE task_id=$1 AND kind IN ('cancel','close')",[task.taskId])).rows[0].count),
   close:async()=>{runtimes.forEach(r=>r.close());api.closeAllConnections();await new Promise(r=>api.close(r));await f.db.close();
    if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('galaxy-owner-control-journal-'))throw new Error('fixture cleanup path invalid');
    await rm(directory,{recursive:true,force:true});}};
 }catch(error){runtimes.forEach(r=>r.close());api.closeAllConnections();await new Promise(r=>api.close(r));await f.db.close();
  if(dirname(resolve(directory))===resolve(tmpdir())&&basename(directory).startsWith('galaxy-owner-control-journal-'))await rm(directory,{recursive:true,force:true});throw error;}
}
const input={kind:'cancel',reason:'Explicit synthetic original work cancellation'};

test('an absent legacy close remains exact and cannot obtain a fresh Consent or silently become enrollment stop',async()=>{
 const h=await fixture();try{
  const event={kind:'close',eventId:randomUUID(),expectedTaskVersion:1,reason:'Historical ambiguous close'},payloadJson=JSON.stringify({taskId:h.task.taskId,event});
  const original={taskId:h.task.taskId,eventId:event.eventId,payloadJson,payloadHash:createHash('sha256').update(payloadJson).digest('hex'),viewers:[],state:'result-unknown',authorizationExpiresAt:h.f.now+3600};
  await h.runtime.putLocal('task-event:'+h.task.taskId,original);const writes=h.writes.length;
  await assert.rejects(h.runtime.resumeTaskEvent(h.task.taskId),error=>error.code==='task_termination_intent_required');
  assert.deepEqual(await h.runtime.getLocal('task-event:'+h.task.taskId),original);assert.equal(h.writes.length,writes);assert.equal(await h.count(),0);
 }finally{await h.close();}
});

test('receipt kind/participation metadata and unknown fields cannot falsely acknowledge the retained original control',async()=>{
 const h=await fixture();try{
  const client=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now}),preview=await client.prepare(input);h.loseAck();
  await assert.rejects(client.confirm(preview,{confirmed:true}));const writes=h.writes.length;
  for(const change of [{kind:'close'},{participationId:randomUUID()},{participationVersion:-1},{contentReturned:true}]){
   const r={...h.runtime,api:{...h.runtime.api,call:async(path,...args)=>{const value=await h.runtime.api.call(path,...args);
    return path==='/v2/tasks/receipt'?{...value,...change}:value;}}};
   const corrupt=createTaskOwnerControlClient(r,h.task.taskId,{now:()=>h.f.now});
   await assert.rejects(corrupt.reconcile(),error=>error.code==='task_owner_control_record_invalid');corrupt.close();
   assert.equal((await h.journal())[0].pending.operationId,preview.operationId);assert.equal(h.writes.length,writes);assert.equal(await h.count(),1);
  }
  assert.equal((await client.reconcile()).state,'acknowledged');assert.equal((await h.journal())[0].pending,null);assert.equal(h.writes.length,writes);
 }finally{await h.close();}
});

test('same-ID recovery reads partial original facts then separately confirms the durable precise control intent',async()=>{
 const h=await fixture();try{const reader=createTaskOwnerReadClient(h.runtime,h.task.taskId,{now:()=>h.f.now}),p=await reader.prepare();
  const partial=await reader.read(p,{confirmed:true});assert.equal(partial.taskWriteGranted,false);assert.equal(partial.events[0].payloadJson,h.original.payloadJson);
  const client=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now}),preview=await client.prepare(input);
  assert.deepEqual(h.writes.filter(p=>p.endsWith('/owner-control')),[]);
  const priorWrites=h.writes.length;await assert.rejects(client.confirm(preview),error=>error.code==='task_owner_control_confirmation_required');assert.equal(h.writes.length,priorWrites);
  const result=await client.confirm(preview,{confirmed:true});assert.equal(result.state,'canceled');assert.equal(result.currentAccessGranted,false);assert.equal(await h.count(),1);
  const journal=(await h.journal())[0];assert.equal(journal.pending,null);assert.equal(journal.receipts[0].eventId,preview.operationId);
  assert.equal(JSON.stringify(journal).includes(input.reason),false);assert.equal(JSON.stringify(journal).includes('signedIntent'),false);
  assert.equal((await client.pending()).pending,null);assert.equal((await h.f.db.query('SELECT payload_text FROM task_events WHERE id=$1',[h.task.operationId])).rows[0].payload_text,h.original.payloadJson);
 }finally{await h.close();}
});

test('committed ACK loss survives a real journal reload and rebind and only reads the original receipt',async()=>{
 const h=await fixture();try{let client=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now});const p=await client.prepare(input);h.loseAck();
  await assert.rejects(client.confirm(p,{confirmed:true}));assert.equal(await h.count(),1);const before=(await h.journal())[0].pending;
  assert.equal(before.state,'unknown');const writes=h.writes.length;await h.reload();client=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now});
  const restored=(await client.pending()).pending;assert.equal(restored.operationId,p.operationId);assert.equal(restored.payloadHash,p.payloadHash);
  assert.equal((await client.reconcile()).state,'acknowledged');assert.equal(h.writes.length,writes);assert.equal(await h.count(),1);
  assert.equal((await h.journal())[0].pending,null);
 }finally{await h.close();}
});

test('new binding after signing withholds the old control and requires absent plus a newly reviewed exact original preview',async()=>{
 const h=await fixture();try{let switched=false;const r={...h.runtime,api:{...h.runtime.api,submitAuthorization:async(...args)=>{
   const result=await h.runtime.api.submitAuthorization(...args);if(!switched){switched=true;await h.runtime.connect({confirmed:true});}return result;}}};
  const client=createTaskOwnerControlClient(r,h.task.taskId,{now:()=>h.f.now}),p=await client.prepare(input);
  await assert.rejects(client.confirm(p,{confirmed:true}),changed);assert.equal(await h.count(),0);assert.equal(h.writes.filter(p=>p.endsWith('/owner-control')).length,0);
  const retained=(await h.journal())[0].pending;assert.equal(retained.operationId,p.operationId);assert.equal(retained.payloadJson,p.payloadJson);
  assert.equal((await client.reconcile()).state,'absent');await assert.rejects(client.confirm(p,{confirmed:true}));
  const renewed=await client.prepare(input);assert.equal(renewed.operationId,p.operationId);assert.equal(renewed.payloadJson,p.payloadJson);assert.equal(renewed.payloadHash,p.payloadHash);
  assert.equal((await client.confirm(renewed,{confirmed:true})).state,'canceled');assert.equal(await h.count(),1);
 }finally{await h.close();}
});

test('storage, hash and queued waits cannot move old confirmations onto the replacement connection',async()=>{
 for(const stage of ['storage','hash','queue']){const h=await fixture(),entered=deferred(),release=deferred(),originalDigest=Reflect.get(crypto.subtle,'digest');try{
   let fired=false;const client=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now});
   if(stage==='storage')h.setPut(async(key,value)=>{if(!fired&&key.includes(':task-owner-control:')&&value.pending){fired=true;await h.runtime.connect({confirmed:true});}});
   if(stage==='hash')crypto.subtle.digest=async function(...args){const result=await originalDigest.apply(this,args);
    if(!fired&&new TextDecoder().decode(args[1]).includes(input.reason)){fired=true;await h.runtime.connect({confirmed:true});}return result;};
   if(stage==='queue'){h.setGet(async key=>{if(!fired&&key.includes(':task-owner-control:')){fired=true;entered.resolve();await release.promise;}});
    const first=client.pending();await entered.promise;const second=client.prepare(input),settled=Promise.allSettled([first,second]);
    await h.runtime.connect({confirmed:true});release.resolve();const results=await settled;assert.deepEqual(results.map(r=>r.status),['rejected','rejected']);
    results.forEach(r=>assert.equal(changed(r.reason),true));
   }else await assert.rejects(client.prepare(input),changed);
   assert.equal(await h.count(),0);assert.deepEqual(h.writes,[]);
   if(stage==='storage')assert.ok((await client.pending()).pending.payloadHash,'the durable original record remains queryable');
  }finally{crypto.subtle.digest=originalDigest;release.resolve();await h.close();}}
});

test('stop while the original receipt is offline keeps only its durable locator and cannot dispatch a stopped unknown operation',async()=>{
 const h=await fixture();try{const client=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now}),p=await client.prepare(input);h.loseAck();
  await assert.rejects(client.confirm(p,{confirmed:true}));h.offline(true);const stopped=await client.stopRetry(p,{confirmed:true});
  assert.equal(stopped.receiptState,'unknown');assert.equal(stopped.serverCancellationConfirmed,false);const journal=(await h.journal())[0];
  assert.equal(journal.pending,null);assert.equal(journal.stopped[0].eventId,p.operationId);assert.equal(JSON.stringify(journal).includes(input.reason),false);
  assert.equal(JSON.stringify(journal).includes('payloadJson'),false);assert.equal(JSON.stringify(journal).includes('signedIntent'),false);
  await assert.rejects(client.prepare(input),error=>error.code==='task_owner_control_pending');const writes=h.writes.length;
  h.offline(false);await h.reload();const resumed=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now});
  assert.equal((await resumed.reconcile({operationId:p.operationId})).state,'acknowledged');assert.equal(h.writes.length,writes);assert.equal(await h.count(),1);
 }finally{await h.close();}
});

test('late original journal completion or ACK cannot disclose an old owner’s control preview to a new identity',async()=>{
 for(const stage of ['read','write','ack']){const h=await fixture();try{const client=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now}),p=await client.prepare(input);
   let switched=false;if(stage==='read')h.setGet(async key=>{if(!switched&&key.includes(':task-owner-control:')){switched=true;await h.switchOwner();}});
   if(stage==='write')h.setPut(async(key,value)=>{if(!switched&&key.includes(':task-owner-control:')&&value.pending?.state==='unknown'){
    switched=true;await h.switchOwner();}});
   const r=stage==='ack'?{...h.runtime,api:{...h.runtime.api,call:async(...args)=>{const result=await h.runtime.api.call(...args);
    if(args[0].endsWith('/owner-control')){switched=true;await h.switchOwner();}return result;}}}:h.runtime;
   const target=stage==='ack'?createTaskOwnerControlClient(r,h.task.taskId,{now:()=>h.f.now}):client;
   let action;if(stage==='read')action=()=>client.pending();else if(stage==='write')action=()=>client.confirm(p,{confirmed:true});
   else{const fresh=await target.prepare(input);action=()=>target.confirm(fresh,{confirmed:true});}
   await assert.rejects(action(),changed);assert.equal(switched,true);assert.equal(await h.count(),stage==='ack'?1:0);
   const other=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now});assert.equal((await other.pending()).pending,null);
   await assert.rejects(client.pending(),changed);const journal=(await h.journal())[0];assert.equal(journal.owner.subjectId,h.subjectId);
   assert.notEqual(h.runtime.api.snapshot().subjectId,h.subjectId);
   assert.equal(journal.pending.operationId,p.operationId,'original owner journal remains under the original exact operation');
  }finally{await h.close();}}
});

test('legacy unknown cancellation is queried first and explicitly resumes only its original event ID and literal bytes',async()=>{
 const h=await fixture({legacyFault:'absent'});try{const client=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now}),old=h.legacyRecord;
  const pending=await client.pending();assert.equal(pending.pending,null);assert.equal(pending.legacy.length,1);
  assert.equal(pending.legacy[0].eventId,old.eventId);assert.equal(JSON.stringify(pending.legacy).includes(input.reason),false);
  assert.equal(JSON.stringify(pending.legacy).includes('payloadJson'),false);assert.equal((await client.reconcile({operationId:old.eventId})).state,'absent');
  const p=await client.prepare(input);assert.equal(p.operationId,old.eventId);assert.equal(p.payloadJson,old.payloadJson);assert.equal(p.payloadHash,old.payloadHash);
  assert.equal((await client.confirm(p,{confirmed:true})).eventId,old.eventId);assert.equal(await h.count(),1);
  assert.deepEqual(await h.runtime.getLocal('task-event:'+h.task.taskId),old,'the new consumer never rewrites or clears the old queue');
  assert.equal((await client.reconcile({operationId:old.eventId})).state,'acknowledged');assert.equal(h.writes.filter(p=>p.endsWith('/owner-control')).length,1);
 }finally{await h.close();}
});

test('legacy accepted cancellation returns only its original metadata ACK without another Consent or mutation',async()=>{
 const h=await fixture({legacyFault:'accepted'});try{const client=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now});
  const ack=await client.prepare(input);assert.equal(ack.state,'acknowledged');assert.equal(ack.eventId,h.legacyRecord.eventId);
  assert.equal(ack.payloadHash,h.legacyRecord.payloadHash);assert.equal(JSON.stringify(ack).includes(input.reason),false);
  assert.equal(await h.count(),1);assert.deepEqual(h.writes,[]);assert.deepEqual(await h.runtime.getLocal('task-event:'+h.task.taskId),h.legacyRecord);
 }finally{await h.close();}
});

test('legacy receipt unknown, conflict, non-control intent or changed literal bytes fail closed without a fresh signature',async()=>{
 for(const boundary of ['offline','conflict','invite','spaced','stopped']){const h=await fixture({legacyFault:'absent',legacyKind:boundary==='invite'?'invite':'cancel',legacySpaced:boundary==='spaced'});try{
   if(boundary==='offline')h.offline(true);
   if(boundary==='conflict'){const other=await h.runtime.api.authorizePayload({taskId:h.task.taskId,event:{eventId:h.legacyRecord.eventId,expectedTaskVersion:1,
     kind:'cancel',reason:'A distinct accepted precise event'}},{action:'assistance.publish',objectId:h.legacyRecord.eventId,visibility:'Private',expiresAt:h.f.now+3600,confirmed:true});
    await h.runtime.api.call(`/v2/tasks/${h.task.taskId}/owner-control`,other);h.writes.length=0;}
   if(boundary==='stopped'){h.offline(true);const p=await h.runtime.reviewTaskStop(h.task.taskId);
    await h.runtime.stopTaskOperation(p,{taskId:h.task.taskId,confirmed:true});assert.equal(await h.runtime.getLocal('task-event:'+h.task.taskId),null);}
   const client=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now});await assert.rejects(client.prepare(input));
   assert.deepEqual(h.writes,[]);assert.equal((await client.pending()).pending,null);
   if(boundary==='stopped'){assert.equal((await client.pending()).legacy[0].localRetryStopped,true);h.offline(false);
    const ref=(await client.pending()).legacy[0];assert.equal((await client.reconcile({operationId:ref.operationId})).state,'absent');
    const next=await client.prepare(input);assert.notEqual(next.operationId,h.legacyRecord.eventId,'only an independent completed local stop and exact absent receipt permit a new reviewed intent');}
  }finally{await h.close();}}
});

test('a legacy queue appearing during preview or changing the connection while it is read prevents control signing',async()=>{
 for(const boundary of ['appears','lease']){const h=await fixture();try{
   const old={taskId:h.task.taskId,eventId:randomUUID(),payloadJson:JSON.stringify({taskId:h.task.taskId,event:{kind:'invite',eventId:randomUUID(),expectedTaskVersion:1,
    recipientId:h.f.actor.subjectId,note:'Synthetic old pending invitation',expiresAt:h.f.now+100}}),state:'prepared'};
   const payload=JSON.parse(old.payloadJson);payload.event.eventId=old.eventId;old.payloadJson=JSON.stringify(payload);old.payloadHash=createHash('sha256').update(old.payloadJson).digest('hex');
   const client=createTaskOwnerControlClient(h.runtime,h.task.taskId,{now:()=>h.f.now});
   if(boundary==='appears'){const preview=await client.prepare(input);await h.runtime.putLocal('task-event:'+h.task.taskId,old);
    await assert.rejects(client.confirm(preview,{confirmed:true}),error=>error.code==='task_owner_control_legacy_pending');}
   else{await h.runtime.putLocal('task-event:'+h.task.taskId,old);let changedOnce=false;h.setGet(async key=>{if(!changedOnce&&key.endsWith(':task-event:'+h.task.taskId)){
     changedOnce=true;await h.runtime.connect({confirmed:true});}});await assert.rejects(client.prepare(input),changed);}
   assert.deepEqual(h.writes,[]);assert.equal(await h.count(),0);
  }finally{await h.close();}}
});
