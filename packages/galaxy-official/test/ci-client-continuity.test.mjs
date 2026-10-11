import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {getCiClient} from '../../galaxy-web/src/ci-client.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
// Contract doubles cover clocks and interrupted awaits; ci-browser-v2.test
// separately exercises real WebRuntime/signatures/HTTP/PGlite and proof bytes.
function fixture(options={}){
 const subjectId='GUID'+'A'.repeat(28),endpoint='https://official.example.org',store=new Map(),calls=[],prepared=[],accepted=new Map(),consents=new Set();
 const state={now:2000000000,bindingId:randomUUID(),generation:1,marker:{},failSign:false,failConsent:false,failBusiness:false,loseAck:false,unknownReceipt:false,onGet:null};
 const request={id:randomUUID(),schemaVersion:2,kind:'observe',purpose:'observe-selected-ci-source-and-prepare-bounded-proof',caseId:randomUUID(),
  evidenceRef:{id:randomUUID(),version:1},resultRef:{id:randomUUID(),version:1},source:{provider:'github-actions',owner:'synthetic',repository:'scope',runId:12,attempt:1,commit:'b'.repeat(40)}};
 const proof={version:2,type:'ci-execution-observation',sourceProfile:'facts-v2',id:randomUUID(),subject:subjectId,issuer:endpoint,bindingId:request.id,observationId:randomUUID(),
  scope:'referenced-ci-run-only',strength:'ci-execution-fact',independence:'repository-controlled',attribution:'submitter-asserted',
  source:{...request.source,repositoryId:123,sourceUpdatedAt:new Date(state.now*1000).toISOString()},conclusion:'success',synthetic:true,
  taskOutcomeVerification:'not-independently-verified',capabilityVerified:false,preparedAt:state.now,observedAt:state.now,expiresAt:state.now+3600,
  limitations:['Synthetic contract observation only.'],statusPath:'/v2/ci/proofs/synthetic/status'};
 const api={endpoint,snapshot:()=>({endpoint,subjectId,bindingId:state.bindingId,generation:state.generation}),
  prepareAuthorization:async(payloadJson,scope)=>{calls.push('sign');if(state.failSign)throw Error('synthetic signing interrupted');
   const value={version:1,endpoint,payloadJson,signedIntent:'synthetic-contract-envelope',intent:{version:1,id:randomUUID(),subjectId,bindingId:state.bindingId,endpoint,
    action:scope.action,objectId:scope.objectId,visibility:scope.visibility,viewers:scope.viewers,purpose:scope.visibility==='Public'?'public-profile':'operational',
    recipient:endpoint,fields:Object.keys(JSON.parse(payloadJson)),payloadHash:hash(payloadJson),issuedAt:state.now,expiresAt:scope.expiresAt}};prepared.push(structuredClone(value));return value;},
  submitAuthorization:async original=>{calls.push('consent');if(state.failConsent)throw Error('synthetic Consent interrupted');consents.add(original.intent.id);return{consentId:original.intent.id,payloadJson:original.payloadJson};},
  reconcileAuthorization:async original=>{calls.push('consent-receipt');return consents.has(original.intent.id)?{state:'acknowledged',consentId:original.intent.id,payloadJson:original.payloadJson}:{state:'absent',consentId:original.intent.id};},
  call:async(path,input)=>{calls.push(path);
   if(path==='/v2/ci/receipts'){if(state.unknownReceipt)throw Error('synthetic offline');const found=accepted.get(input.type+':'+input.id);return found?{...input,state:'recorded',...found}:{...input,state:'absent'};}
   if(state.failBusiness)throw Error('synthetic business interrupted');
   const payload=JSON.parse(input.payloadJson),type=path==='/v2/ci/requests'?'request':'proof';
   accepted.set(type+':'+payload.id,{payloadHash:hash(input.payloadJson),consentId:input.consentId});if(state.loseAck)throw Error('synthetic lost ACK');
   return type==='request'?{requestId:payload.id,state:'pending'}:{proofId:payload.id,signed:'synthetic-business-proof'};
  }};
 const runtime={api,receiptStatus:{captureLease(){const marker=state.marker;return{endpoint,subjectId,assertCurrent(){if(marker!==state.marker)throw Error('runtime_reference_changed');}};}},
  getLocal:async key=>{const value=structuredClone(store.get(key));await state.onGet?.(key);return value;},putLocal:async(key,value)=>store.set(key,structuredClone(value))};
 const client=getCiClient(runtime,subjectId,{now:()=>state.now,...options});
 return{runtime,client,state,store,calls,prepared,accepted,consents,request,proof,subjectId};
}

test('CI automatic recovery preserves original bytes/range/deadline and only renews aging same-binding transport',async()=>{
 for(const stage of ['first-signature','same-binding-aged','accepted-consent-new-binding','absent-consent-new-binding','expired']){
  const f=fixture();f.state.failSign=stage==='first-signature';f.state.failConsent=stage!=='first-signature'&&stage!=='accepted-consent-new-binding';f.state.failBusiness=stage==='accepted-consent-new-binding';
  await assert.rejects(f.client.submit('request',f.request,{confirmed:true}),/synthetic/);const original=structuredClone((await f.client.local()).pending);
  f.state.failSign=false;f.state.failConsent=false;f.state.failBusiness=false;
  if(stage==='same-binding-aged')f.state.now+=301;
  if(stage.endsWith('new-binding')){f.state.bindingId=randomUUID();f.state.generation++;f.state.marker={};}
  if(stage==='expired')f.state.now=original.expiresAt;
  f.calls.length=0;const result=await f.client.resumePending();
  if(['absent-consent-new-binding','expired'].includes(stage)){
   assert.equal(result.reason,stage==='expired'?'authorization-expired':'original-binding-changed');
   assert.equal(f.calls.some(call=>call==='sign'||call==='consent'||call==='/v2/ci/requests'),false);
   const preview=await f.client.reviewAuthorization();assert.equal(preview.state,'reauthorization-required');assert.deepEqual(preview.payload,original.payload);assert.equal(preview.payloadHash,original.payloadHash);
   if(stage!=='expired')assert.equal(preview.expiresAt,original.expiresAt);
   f.calls.length=0;assert.equal((await f.client.reauthorize(preview,{confirmed:true})).state,'recorded');
   assert.equal(f.calls.filter(call=>call==='sign').length,1);
  }else{
   assert.equal(result.state,'recorded');assert.equal(f.calls.filter(call=>call==='sign').length,stage==='accepted-consent-new-binding'?0:1);
  }
  assert.equal(f.calls.filter(call=>call==='/v2/ci/requests').length,1);
  const exact=f.accepted.get('request:'+original.payload.id);assert.equal(exact.payloadHash,original.payloadHash);
  const used=f.prepared.find(item=>item.intent.id===exact.consentId);assert.equal(used.payloadJson,original.payloadJson);
  assert.equal(used.intent.expiresAt,stage==='expired'?f.state.now+2591900:original.expiresAt);
  assert.deepEqual(used.intent.viewers,original.viewers);assert.equal(used.intent.visibility,original.visibility);assert.equal((await f.client.local()).pending,null);
 }
});

test('CI original preview is exact and connection-bound; replacement records and older queued leases cannot sign',async()=>{
 const f=fixture();f.state.failConsent=true;await assert.rejects(f.client.submit('request',f.request,{confirmed:true}));f.state.failConsent=false;
 const preview=await f.client.reviewAuthorization();f.calls.length=0;f.state.bindingId=randomUUID();f.state.generation++;f.state.marker={};
 await assert.rejects(f.client.reauthorize(preview,{confirmed:true}),/reference_changed|连接已变化/);assert.equal(f.calls.some(call=>call==='sign'||call==='consent'||call==='/v2/ci/requests'),false);
 const current=await f.client.reviewAuthorization(),key='ci-operations:'+f.subjectId,old=structuredClone(f.store.get(key));
 f.store.set(key,{...old,pending:{...old.pending,payloadHash:'0'.repeat(64)}});f.calls.length=0;
 await assert.rejects(f.client.reauthorize(current,{confirmed:true}),/已改变/);assert.equal(f.calls.length,0);f.store.set(key,old);
 const selected=await f.client.reviewAuthorization();selected.viewers.push('GUID'+'B'.repeat(28));f.calls.length=0;
 await assert.rejects(f.client.reauthorize(selected,{confirmed:true}),/确认原 CI/);assert.equal(f.calls.length,0);
 let release,entered;const ready=new Promise(done=>{entered=done;}),locked=fixture({locks:{request:async(_key,_options,fn)=>{entered();await new Promise(done=>{release=done;});return fn();}}});
 const queued=locked.client.submit('request',locked.request,{confirmed:true});await ready;locked.state.generation++;release();
 await assert.rejects(queued,/连接已变化/);assert.equal(locked.calls.length,0);assert.equal(locked.store.size,0);
 f.state.onGet=async()=>{f.state.onGet=null;f.state.marker={};};await assert.rejects(async()=>f.client.local(),/runtime_reference_changed/);
});

test('expired original proof can only be checked or explicitly stopped locally; old receipt remains queryable and new selection is free',async()=>{
 const f=fixture();f.state.failConsent=true;await assert.rejects(f.client.submit('proof',f.proof,{visibility:'Public',confirmed:true}));f.state.failConsent=false;
 const original=structuredClone((await f.client.local()).pending);f.state.now+=301;f.calls.length=0;
 assert.equal((await f.client.resumePending()).reason,'proof-preview-expired');assert.equal(f.calls.some(call=>call==='sign'||call==='consent'||call==='/v2/ci/proofs/publish'),false);
 assert.equal((await f.client.reviewAuthorization()).state,'proof-preview-expired');
 f.state.unknownReceipt=true;await assert.rejects(f.client.stopPending({id:original.payload.id,payloadHash:original.payloadHash},{confirmed:true}),/offline/);
 assert.equal((await f.client.local()).pending.payload.id,original.payload.id);f.state.unknownReceipt=false;
 f.calls.length=0;const stopped=await f.client.stopPending({id:original.payload.id,payloadHash:original.payloadHash},{confirmed:true});
 assert.equal(stopped.serverCancellationConfirmed,false);assert.equal(stopped.state,'stopped-local');const saved=await f.client.local();assert.equal(saved.pending,null);
 assert.equal(JSON.stringify(saved.stopped).includes('source'),false);assert.equal(JSON.stringify(saved.stopped).includes('synthetic-contract-envelope'),false);
 assert.equal((await f.client.reconcileStopped(stopped)).state,'absent');assert.equal(f.calls.some(call=>call==='sign'||call==='consent'||call==='/v2/ci/proofs/publish'),false);
 await f.client.submit('request',f.request,{confirmed:true});assert.equal((await f.client.local()).requests[0].id,f.request.id);
});

test('a recorded expired proof is read back before any new Consent or local stopping',async()=>{
 const f=fixture();f.state.loseAck=true;await assert.rejects(f.client.submit('proof',f.proof,{visibility:'Public',confirmed:true}),/lost ACK/);
 const original=(await f.client.local()).pending;f.state.now+=301;f.calls.length=0;
 const result=await f.client.stopPending({id:original.payload.id,payloadHash:original.payloadHash},{confirmed:true});assert.equal(result.state,'recorded');
 assert.deepEqual(f.calls,['/v2/ci/receipts']);assert.equal((await f.client.local()).pending,null);assert.equal((await f.client.local()).stopped,undefined);
});
