import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {ciSourceMetadata} from '../src/shared/ci-observation-v2-schema.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import {getFactClient} from '../../galaxy-web/src/fact-client.mjs';

test('a current Task discovers an unreferenced same-Case source without a local catalog and rereads its real permission',{timeout:60000},async()=>{
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000}),data=new Map(),writes=[];let runtime;
 const store={get:async key=>structuredClone(data.get(key)),put:async(key,value)=>data.set(key,structuredClone(value)),
  update:async(key,change)=>{const value=change(structuredClone(data.get(key)));data.set(key,structuredClone(value));return structuredClone(value);}};
 try{
  await new Promise(done=>api.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+api.address().port;
  runtime=await createExistingWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{store,now:()=>f.now,fetch:async(url,options)=>{
   const target=new URL(url);if(['/v1/consents','/v2/cases/events','/v2/verification-records/submit','/v2/tasks'].includes(target.pathname))writes.push(target.pathname);
   return fetch(origin+target.pathname+target.search,options);}});
  await runtime.connect({confirmed:true});const subjectId=(await runtime.status()).identity.subjectId;
  const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'collaboration',title:'[synthetic] Unreferenced source discovery',summary:'Private isolated read scenario',
   workContext:{goal:'Read existing sources across devices',currentSituation:'No local source index',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+3600};
  const write=async(path,payload,action,objectId)=>{const envelope=await runtime.api.authorizePayload(payload,{action,objectId,visibility:'Private',confirmed:true});await runtime.api.call(path,envelope);return envelope;};
  await write('/v2/tasks',task,'assistance.publish',task.operationId);
  const client=getFactClient(runtime,subjectId,{now:()=>f.now}),currentTask=await runtime.api.call('/v2/tasks/'+task.taskId,null,{method:'GET'});
  const first=await client.submitFact(currentTask,null,null,{kind:'intervention',types:['diagnosis'],affectsAttemptIds:[],description:'Synthetic reading',sourceRefs:[],observedEffect:'Limited fixture observation'},
   {confirmed:true,synthetic:true});
  const selectedTask=await runtime.api.call('/v2/tasks/'+task.taskId,null,{method:'GET'}),facts=await client.readCase(selectedTask),intervention=facts.interventions[0];
  await client.submitFact(selectedTask,facts,null,{kind:'result-recorded',origin:{kind:'intervention',id:intervention.id,version:intervention.version},scopeVersion:1,deliverableRefs:[],reportedOutcome:'partial',summary:'Synthetic limited result',limitations:'No real execution'}, {confirmed:true});
  const ciSource={provider:'github-actions',owner:'synthetic',repository:'discovery',runId:12,attempt:1,commit:'b'.repeat(40)},evidence={id:randomUUID(),operationId:randomUUID(),kind:'evidence',expectedVersion:0,
   caseId:first.caseId,taskId:task.taskId,reportedBy:subjectId,synthetic:true,evidenceType:'ci-result',source:{...ciSourceMetadata(ciSource),originalAt:new Date(f.now*1000).toISOString(),issuer:'GitHub Actions'},
   observedAt:new Date(f.now*1000).toISOString(),reportedSourceState:'available',summary:'Unreferenced synthetic source'};
  const original=await write('/v2/verification-records/submit',evidence,'evidence.submit',evidence.operationId);
  assert.equal((await runtime.getLocal('task-record-refs:'+task.taskId))??null,null,'no browser-local catalog was fabricated');
  assert.deepEqual((await client.readCase(selectedTask)).results[0].deliverableRefs,[],'the source is not silently added to an old result');
  const baseline=writes.length,discovered=await client.discoverRecordRefs(selectedTask);
  assert.deepEqual(discovered,{refs:[{type:'evidence',id:evidence.id}]});assert.equal(writes.length,baseline);
  const view=await client.readRecord(discovered.refs[0]);assert.equal(view.record.summary,evidence.summary);assert.equal(view.referenceStatus,'current');
  await runtime.api.call('/v1/consents/'+original.consentId+'/revoke',{});
  await assert.rejects(client.readRecord(discovered.refs[0]),/consent/);
  assert.deepEqual(await client.discoverRecordRefs(selectedTask),{refs:[]},'revoked original sources are no longer discovered');
  assert.equal(writes.length,baseline,'source discovery and current read do not write Consent or business data');
 }finally{runtime?.close();api.closeAllConnections();await new Promise(done=>api.close(done));await f.db.close();}
});

test('source discovery follows real continuation locators, deduplicates exact Case refs and rejects cursor loops or changed leases',async()=>{
 const subjectId='GUID'+'A'.repeat(28),caseId=randomUUID(),task={taskId:randomUUID(),caseId},id=randomUUID(),calls=[];
 const snapshot={subjectId,endpoint:'https://official.example.org',bindingId:randomUUID(),generation:1};let mode='pages';
 const runtime={api:{endpoint:snapshot.endpoint,snapshot:()=>snapshot,call:async(_path,input)=>{
  calls.push(input);if(mode==='lease'){snapshot.generation++;return{items:[],nextCursor:null};}
  if(mode==='loop')return{items:[],nextCursor:'same'};
  return input.after?{items:[{kind:'case-history',caseId,verificationRecords:[{type:'evidence',id},{type:'verification',id}]}],nextCursor:null}
   :{items:[{kind:'case-history',caseId:randomUUID(),verificationRecords:[{type:'evidence',id:randomUUID()}]},{kind:'case-history',caseId,verificationRecords:[{type:'evidence',id}]}],nextCursor:'next'};
 }}};
 const client=getFactClient(runtime,subjectId);assert.deepEqual((await client.discoverRecordRefs(task)).refs,[{type:'evidence',id},{type:'verification',id}]);
 assert.equal(calls[1].after,'next');assert.equal(calls[0].subjectId,subjectId);assert.equal(calls[0].query,caseId);
 mode='loop';await assert.rejects(client.discoverRecordRefs(task),error=>error.code==='fact_operation_invalid');
 mode='lease';await assert.rejects(client.discoverRecordRefs(task),error=>error.code==='fact_authority_changed');
});
