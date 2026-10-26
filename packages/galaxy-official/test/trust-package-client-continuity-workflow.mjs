import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {publicationFixture} from './task-publication-continuity-fixture.mjs';
import {createNativeRecoveryWebFixture} from './native-recovery-web-fixture.mjs';
import {serviceFixture} from './service-fixture.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createApi} from '../src/http.mjs';

export async function ordinaryTrustFixture(){
 const x=await publicationFixture(),client=x.runtime.trustPackages;
 const marker='synthetic-private-ordinary-trust-claim';
 const input=()=>({claims:[{id:randomUUID(),text:marker,authority:'self-asserted',capabilityVerified:false}],selections:[],
  audience:{kind:'subjects',subjectIds:[x.runtime.api.snapshot()?.subjectId??x.originalSubject]},
  expiresAt:Math.floor(Date.now()/1000)+600});
 x.originalSubject=x.runtime.api.snapshot().subjectId;
 const prepare=()=>client.prepare(input());
 const saved=()=>[...x.values.entries()].filter(([key,value])=>key.endsWith(':trust-package:last-export')&&value);
 async function source(){
  const caseId=randomUUID(),payload={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,
   actorId:x.originalSubject,localRef:randomUUID(),title:'Synthetic current source',summary:'Private authored record',
   source:{kind:'local',reference:randomUUID()},synthetic:true};
  const prepared=await x.runtime.api.prepareAuthorization(JSON.stringify(payload),{objectId:caseId,
   action:'case.teaser.publish',visibility:'Private',viewers:[],confirmed:true});
  const submission=await x.runtime.api.submitAuthorization(prepared,{confirmed:true});
  await x.runtime.api.call('/v2/cases/events',{consentId:submission.consentId,payloadJson:prepared.payloadJson});
  return {ref:{endpoint:x.runtime.api.endpoint,kind:'case-event',id:caseId,caseId,version:1},consentId:submission.consentId};
 }
 function oncePut(predicate,run){x.hooks.put=async(key,value)=>{if(!predicate(key,value))return;x.hooks.put=null;await run(key,value);};}
 function onceGet(predicate,run){x.hooks.get=async(key,value)=>{if(!predicate(key,value))return;x.hooks.get=null;await run(key,value);};}
 function onceResponse(predicate,run){x.hooks.response=async(path,response)=>{if(!predicate(path,response))return;x.hooks.response=null;await run(path,response);};}
 return {...x,client,marker,input,prepare,saved,source,oncePut,onceGet,onceResponse};
}
const changed=e=>e?.code==='trust_identity_changed';
export async function verifyOrdinaryLateSave(){
 const x=await ordinaryTrustFixture();
 try{
  const before=x.runtime.api.snapshot(),preview=await x.prepare();
  x.oncePut(key=>key.endsWith(':trust-package:last-export'),()=>x.reconnect());
  await assert.rejects(x.client.exportPackage(preview,{confirmed:true}),changed);
  const after=x.runtime.api.snapshot();assert.equal(before.subjectId,after.subjectId);
  assert.notEqual(before.bindingId,after.bindingId);assert.notEqual(before.generation,after.generation);
  assert.equal(x.saved().length,1,'actual original local artifact is retained, not rolled back');
  const original=await x.client.lastExport();assert.equal(original.packageId,preview.packageId);
  assert.ok(JSON.stringify(original.container).includes(x.marker));
  assert.equal(x.counts.publications,0);assert.equal(x.counts.consents,0);
  return {savedOriginal:true,oldOutputWithheld:true,currentOwnerCanExplicitlyReadHistoricalExport:true};
 }finally{await x.close();}
}
export async function verifyOrdinaryEntryRead(){
 const x=await ordinaryTrustFixture();
 try{
  x.onceGet(key=>key.startsWith('device:'),()=>x.reconnect());
  await assert.rejects(x.prepare(),changed);assert.equal(x.saved().length,0);
  assert.equal(x.counts.publications,0);assert.equal(x.counts.consents,0);
  return {firstDeviceAwaitFenced:true,oldPreviewNotProduced:true};
 }finally{await x.close();}
}
export async function verifyOrdinaryOldPreview(){
 const x=await ordinaryTrustFixture();
 try{
  const preview=await x.prepare();await x.reconnect();
  await assert.rejects(x.client.exportPackage(preview,{confirmed:true}),changed);
  assert.equal(x.saved().length,0);
  const fresh=await x.prepare(),replies=await Promise.allSettled([
   x.client.exportPackage(fresh,{confirmed:true}),x.client.exportPackage(fresh,{confirmed:true})
  ]);
  assert.equal(replies.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(replies.filter(r=>r.status==='rejected'&&r.reason?.code==='trust_preview_required').length,1);
  assert.equal(x.saved().length,1);
  return {oldPreviewRejected:true,singlePreviewSingleExport:true};
 }finally{await x.close();}
}
export async function verifyOrdinaryLocalReadAba(){
 const x=await ordinaryTrustFixture();
 try{
  const preview=await x.prepare();await x.client.exportPackage(preview,{confirmed:true});
  await x.runtime.disconnect();assert.equal(x.runtime.api.snapshot(),null);
  x.onceGet(key=>key.endsWith(':trust-package:last-export'),async()=>{await x.runtime.connect({confirmed:true});await x.runtime.disconnect();});
  await assert.rejects(x.client.lastExport(),changed);assert.equal(x.runtime.api.snapshot(),null);
  // Current local disconnected export stays supported and never connects itself.
  const disconnected=await x.prepare(),before=x.counts.consents;
  const result=await x.client.exportPackage(disconnected,{confirmed:true});
  assert.equal(result.localSaved,true);assert.equal(x.runtime.api.snapshot(),null);assert.equal(x.counts.consents,before);
  return {nullBindingAbaWithheld:true,explicitDisconnectedExportSupported:true};
 }finally{await x.close();}
}
export async function verifyOrdinaryOwnerSwitch(){
 // Start from an empty owner journal so the existing Native fixture owns its
 // controller. Never infer a Native controller from another fixture's handoff.
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),values=new Map();
 const x={f,values,originalSubject:null,
  input:()=>({claims:[{id:randomUUID(),text:'synthetic-private-ordinary-trust-claim',authority:'self-asserted',capabilityVerified:false}],selections:[],
   audience:{kind:'subjects',subjectIds:[x.originalSubject]},expiresAt:Math.floor(Date.now()/1000)+600}),
  saved:()=>[...values.entries()].filter(([key,value])=>key.endsWith(':trust-package:last-export')&&value),
  close:()=>f.db.close()};
 let ownerRuntime,otherRuntime,server;
 try{
  // Real Native signed recovery is only a test stimulus for the consumer's
  // owner fence. This does not restore a production Web recovery coordinator.
  function recoveryStore(values,hook){
   const get=async key=>{const value=structuredClone(values.get(key));await hook?.(key,value);return value;};
   const put=async(key,value)=>{values.set(key,structuredClone(value));};
   return{get,put,async update(key,fn){const next=fn(structuredClone(values.get(key)));if(next&&typeof next.then==='function'){if(next instanceof Promise)void next.catch(()=>{});throw Error('local_update_async_callback');}const committed=structuredClone(next);values.set(key,committed);return structuredClone(committed);}};
  }
  server=createApi({...x.f,browserOrigins:['https://galaxy.example.org'],rateLimit:1000});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const local='http://127.0.0.1:'+server.address().port;
  const fetcher=(url,options)=>{const u=new URL(url);return fetch(local+u.pathname+u.search,{...options,
   headers:{...options.headers,Origin:'https://galaxy.example.org'}});};
  const config={endpoint:x.f.access.endpoint,trustedKeys:x.f.bindings.trustedKeys};let onRead=null;
  ownerRuntime=await createNativeRecoveryWebFixture(config,{store:recoveryStore(x.values,(...args)=>onRead?.(...args)),fetch:fetcher,now:()=>x.f.now});
  otherRuntime=await createNativeRecoveryWebFixture(config,{store:recoveryStore(new Map()),fetch:fetcher,now:()=>x.f.now});
  x.originalSubject=(await ownerRuntime.status()).identity.subjectId;
  await otherRuntime.connect({confirmed:true});
  const recovery=await otherRuntime.prepareRecovery();await otherRuntime.saveRecovery({operationId:recovery.operationId,confirmed:true});
  const preview=await ownerRuntime.trustPackages.prepare(x.input());await ownerRuntime.trustPackages.exportPackage(preview,{confirmed:true});
  onRead=async key=>{if(!key.endsWith(':trust-package:last-export'))return;onRead=null;await ownerRuntime.recover(recovery.code,{confirmed:true});};
  await assert.rejects(ownerRuntime.trustPackages.lastExport(),changed);
  const after=(await ownerRuntime.status()).identity.subjectId;assert.notEqual(after,x.originalSubject);
  assert.equal(x.saved().length,1);assert.ok(x.saved()[0][0].includes(':'+x.originalSubject+':'));
  assert.ok(!x.saved().some(([key])=>key.includes(':'+after+':')));
  return {oldPrivateReadWithheld:true,originalOwnerNamespaceRetained:true,noNewOwnerArtifact:true};
 }finally{ownerRuntime?.close();otherRuntime?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await x.close();}
}
export async function verifyOrdinarySourcesAwait(){
 const x=await ordinaryTrustFixture();
 try{
  const {ref}=await x.source(),input={...x.input(),selections:[{ref,mode:'reference'}]};
  const preview=await x.client.prepare(input);let sourceReads=0;
  x.onceResponse(path=>path==='/v2/trust-package/sources',async()=>{sourceReads++;await x.reconnect();});
  await assert.rejects(x.client.exportPackage(preview,{confirmed:true}),e=>changed(e)||e?.message==='Authorization changed during request.');
  assert.equal(sourceReads,1);assert.equal(x.saved().length,0);
  return {sourceReadRebindWithheld:true,noExportAfterOldSourceCheck:true};
 }finally{await x.close();}
}
export async function verifyOrdinaryPermissionReceipt(){
 const x=await ordinaryTrustFixture();
 try{
  const {ref}=await x.source(),id=randomUUID(),operationId=randomUUID();
  const preview=await x.client.permissionPreview({id,operationId,source:ref,grantee:x.originalSubject,
   audience:x.input().audience,expiresAt:Math.floor(Date.now()/1000)+600});
  let permissionWrites=0;
  x.onceResponse(path=>path==='/v2/trust-package/permissions/submit',async(_path,response)=>{
   permissionWrites++;assert.equal(response.status,200);await response.arrayBuffer();throw Error('synthetic lost permission ACK');
  });
  await assert.rejects(x.client.executePermission(preview,{confirmed:true}),/synthetic lost permission ACK/);
  await x.reconnect();const pending=await x.client.pending();assert.equal(pending.length,1);
  assert.equal(pending[0].operationId,operationId);
  let onlyReceipt=0;x.onceResponse(path=>path==='/v2/trust-package/permissions/receipt',()=>{onlyReceipt++;});
  const receipt=await x.client.reconcile(operationId);
  assert.equal(receipt.state,'recorded');assert.equal(receipt.operationId,operationId);
  assert.equal(onlyReceipt,1);assert.equal(permissionWrites,1);assert.equal((await x.client.pending()).length,0);
  const rows=[...x.values.entries()].filter(([key])=>key.endsWith(':trust-package:permission:'+operationId));
  assert.equal(rows.length,1);assert.ok(rows[0][0].includes(':'+x.originalSubject+':'));
  assert.equal(rows[0][1].state,'acknowledged');
  return {lostAckExactReceipt:true,oneBusinessSubmission:true,originalOwnerJournal:true};
 }finally{await x.close();}
}
