import {nativeData} from './native-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../src/native-v2/server.mjs';
import {createNativeNavigation} from '../src/native-v2/interaction/navigation.mjs';

test('direct MCP return preserves original work through real source503/Task403 and refuses a held old connection',{timeout:60000},async()=>{
 const f=await serviceFixture(browserScopes),directory=await mkdtemp(join(tmpdir(),'galaxy-direct-return-')),calls=[];
 let api,runtime,server,client,otherRuntime,otherServer,otherClient,sourceFailure=false,holdDenied=false,arrived,release;
 try{
  api=createApi({...f,rateLimit:1000});const handler=api.listeners('request')[0];api.removeAllListeners('request');
  api.on('request',(req,res)=>{if(sourceFailure&&req.method==='GET'&&/^\/v2\/tasks\/[^/]+$/.test(req.url)){
   res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'synthetic_source_unavailable'}));
  }else handler(req,res);});await new Promise(r=>api.listen(0,'127.0.0.1',r));const local='http://127.0.0.1:'+api.address().port;
  runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
   fetch:async(url,options)=>{const path=new URL(url).pathname,response=await fetch(local+path,options);calls.push({path,method:options?.method??'GET',status:response.status});
    if(holdDenied&&response.status===403&&/^\/v2\/tasks\/[^/]+$/.test(path)){holdDenied=false;arrived();await new Promise(r=>release=r);}return response;},openBrowser:async()=>({launched:true})});
  await runtime.initialize({profile:'minimal'},{confirmed:true});
  const identity=(await runtime.status()).identity;
  const preBinding=await runtime.navigation.open({object:{kind:'privacy'},origin:{host:'synthetic-host',workRef:'same-local-genesis-work'}});
  assert.equal((await runtime.status()).connected,false);await runtime.connect({confirmed:true});
  const connectedReturn=await runtime.navigation.resume(preBinding.navigationId);
  assert.equal(connectedReturn.origin.workRef,'same-local-genesis-work');assert.equal((await runtime.status()).identity,identity);
  server=createNativeToolServer(runtime);client=new Client({name:'synthetic-direct-return-client',version:'1'},{capabilities:{}});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  const invoke=async(name,input)=>{const r=await client.callTool({name,arguments:input});return{result:r,value:nativeData(r)};};
  const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',workContext:{goal:'Synthetic direct original return',currentSituation:'Isolated signed fixture',attemptRefs:[]},title:'Synthetic original Task',summary:'SYNTHETIC_CURRENT_BODY',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+3600};
  const auth=await runtime.authorize({requestId:randomUUID(),payloadJson:JSON.stringify(task),action:'assistance.publish',objectId:task.operationId,visibility:'Private',viewers:[],expiresAt:f.now+3600},{confirmed:true});
  await runtime.api.call('/v2/tasks',{consentId:auth.consentId,payloadJson:auth.payloadJson});
  const origin={host:'synthetic-original-host',workRef:'original-local-work'},opened=await invoke('galaxy_open',{object:{kind:'task',id:task.taskId},origin});
  assert.equal(opened.result.isError,undefined);const input={navigationId:opened.value.navigationId};
  const current=await invoke('galaxy_return',input);assert.equal(current.value.current,true);assert.equal(current.value.data.taskId,task.taskId);
  const before=calls.length;sourceFailure=true;
  const unavailable=await invoke('galaxy_return',input);
  assert.equal(unavailable.result.isError,undefined);assert.equal(unavailable.value.state,'unavailable');assert.equal(unavailable.value.current,false);
  assert.equal(unavailable.value.data,null);assert.equal(unavailable.value.sourceError,'synthetic_source_unavailable');assert.deepEqual(unavailable.value.origin,origin);
  assert.deepEqual(unavailable.value.object,{kind:'task',id:task.taskId});assert.equal(unavailable.value.navigationId,input.navigationId);
  assert.ok(!JSON.stringify(unavailable.result).includes(task.summary));
  sourceFailure=false;const restored=await invoke('galaxy_return',input);assert.equal(restored.value.current,true);assert.equal(restored.value.sourceError,null);
  await runtime.api.call('/v1/consents/'+auth.consentId+'/revoke',{});
  const denied=await invoke('galaxy_return',input);assert.equal(denied.result.isError,undefined);assert.equal(denied.value.current,false);
  assert.equal(denied.value.data,null);assert.equal(denied.value.sourceError,'consent_required');assert.deepEqual(denied.value.origin,origin);
  assert.equal(denied.value.businessMutation,false);assert.ok(!JSON.stringify(denied.result).includes(task.summary));
  const arrivedAt=new Promise(r=>arrived=r),oldBinding=(await runtime.status()).connection.bindingId;holdDenied=true;
  const old=invoke('galaxy_return',input);await arrivedAt;await runtime.connect({confirmed:true});
  assert.notEqual((await runtime.status()).connection.bindingId,oldBinding);release();const late=await old;
  assert.equal(late.result.isError,true);assert.equal(late.value.error,'receipt_status_authority_changed');assert.equal(late.value.origin,undefined);assert.equal(late.value.data,undefined);
  const refreshed=await invoke('galaxy_return',input);assert.deepEqual(refreshed.value.origin,origin);assert.equal(refreshed.value.current,false);
  assert.ok(calls.slice(before).some(c=>c.status===503));assert.ok(calls.slice(before).some(c=>c.status===403));
  assert.equal(calls.slice(before).filter(c=>c.method==='POST'&&['/v1/consents','/v2/tasks','/v2/cases/events','/v2/verification-records/submit'].includes(c.path)).length,0);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,1);
  // A copied body-free locator is not authorization for another real device
  // owner. Both identities use actual genesis, control and signed bindings.
  otherRuntime=await createNativeRuntime({dataDirectory:join(directory,'other-owner'),endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
   fetch:async(url,options)=>{const path=new URL(url).pathname,response=await fetch(local+path,options);calls.push({path,method:options?.method??'GET',status:response.status});return response;},openBrowser:async()=>({launched:true})});
  await otherRuntime.initialize({profile:'minimal'},{confirmed:true});await otherRuntime.connect({confirmed:true});
  assert.notEqual((await otherRuntime.status()).identity,identity);
  await otherRuntime.store.put('navigation:'+input.navigationId,await runtime.store.get('navigation:'+input.navigationId));
  otherServer=createNativeToolServer(otherRuntime);otherClient=new Client({name:'synthetic-other-owner-return-client',version:'1'},{capabilities:{}});
  const [c,d]=InMemoryTransport.createLinkedPair();await otherServer.connect(c);await otherClient.connect(d);
  const beforeOtherReturn=calls.length,foreign=await otherClient.callTool({name:'galaxy_return',arguments:input}),foreignValue=nativeData(foreign);
  assert.equal(foreign.isError,true);assert.equal(foreignValue.error,'navigation_scope_changed');assert.equal(foreignValue.origin,undefined);assert.equal(foreignValue.data,undefined);
  assert.ok(!JSON.stringify(foreign).includes(origin.workRef));assert.equal(calls.length,beforeOtherReturn,'foreign owner is refused before any remote source read');
  console.log(JSON.stringify({actualMcpClient:true,actualSignedHttp:true,actualSource503:true,actualConsent403:true,actualHeldRebindRejected:true,actualOtherIdentityCopiedLocatorRejected:true,sameNavigation:true,sameOriginalWork:true,existingUnboundGenesisPreserved:true,newBusinessWrites:0,newConsents:0,modelCalls:0,physicalHostAcceptance:false}));
 }finally{
  await otherClient?.close();await otherServer?.close();await otherRuntime?.close();await client?.close();await server?.close();await runtime?.close();if(api?.listening)await new Promise(r=>api.close(r));await f.db.close();
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-direct-return-'));await rm(target,{recursive:true,force:true});
 }
});

test('real anonymous navigation held during local initialize refuses late completion and requires an explicit new open',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-direct-return-initialize-'));
 let runtime,release,enter,held=true,networkCalls=0;
 const arrived=new Promise(r=>enter=r),origin={host:'synthetic',workRef:'ANONYMOUS_PRIVATE_ORIGINAL_REF'};
 try{
  const publicKeyPem=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  runtime=await createNativeRuntime({dataDirectory:directory,endpoint:'https://api.example',website:'https://selected.example',
   trustedKeys:new Map([['synthetic-unused-pin',{publicKeyPem,notBefore:0,notAfter:4000000000,revoked:false}]]),
   fetch:async()=>{networkCalls++;throw Error('unexpected_network');},
   openBrowser:async()=>{if(held){held=false;enter();await new Promise(r=>release=r);}return{launched:true};}});
  assert.equal((await runtime.status()).identity,null);
  const old=runtime.navigation.open({object:{kind:'privacy'},origin});await arrived;
  await runtime.initialize({profile:'minimal'},{confirmed:true});assert.match((await runtime.status()).identity,/^GUID/);
  release();await assert.rejects(old,/receipt_status_authority_changed/);
  const recordsDirectory=join(directory,'native-v2','records'),files=await readdir(recordsDirectory);
  assert.equal(files.length,1);const original=JSON.parse(await readFile(join(recordsDirectory,files[0]),'utf8'));
  assert.equal(original.owner.subjectId,null);
  await assert.rejects(runtime.navigation.resume(original.navigationId),/navigation_scope_changed/);
  const reopened=await runtime.navigation.open({object:{kind:'privacy'},origin});
  assert.deepEqual((await runtime.navigation.resume(reopened.navigationId)).origin,origin);
  assert.equal(networkCalls,0);
 }finally{
  release?.();await runtime?.close();const target=resolve(directory);
  assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-direct-return-initialize-'));
  await rm(target,{recursive:true,force:true});
 }
});

function scoped(){
 const records=new Map();let subjectId='GUID'+'1'.repeat(28),endpoint='https://api.example',bindingId='first',generation=1,readError=null;
 const calls=[],opened=[];const captureLease=async()=>{const captured=JSON.stringify([subjectId,endpoint,bindingId,generation]);return{subjectId,endpoint,bindingId,generation,
  assertCurrent(){if(JSON.stringify([subjectId,endpoint,bindingId,generation])!==captured)throw Object.assign(Error('receipt_status_authority_changed'),{code:'receipt_status_authority_changed'});}};};
 const store={put:async(k,v)=>records.set(k,v),get:async k=>records.get(k)};
 const create=(website='https://selected.example',refresh=async object=>{calls.push(object);if(readError)throw readError;return{[object.kind+'Id']:object.id,...(object.versionId?{versionId:object.versionId}:{})};})=>createNativeNavigation({website,store,captureLease,refresh,openBrowser:async url=>{opened.push(url);return{launched:true};}});
 return{records,calls,opened,create,setError:e=>readError=e,change:kind=>{if(kind==='subject')subjectId='GUID'+'2'.repeat(28);if(kind==='endpoint')endpoint='https://other-api.example';if(kind==='anonymous')subjectId=null;if(kind==='binding'){bindingId='second';generation++;}if(kind==='generation')generation++;},restore:()=>subjectId='GUID'+'1'.repeat(28)};
}

test('original navigation is bound to subject/API/website while explicit same-owner rebinding remains valid',async()=>{
 const s=scoped(),nav=s.create(),object={kind:'privacy'},origin={host:'synthetic',workRef:'PRIVATE_ORIGINAL_REF'};
 const opened=await nav.open({object,origin});s.change('binding');assert.deepEqual((await nav.resume(opened.navigationId)).origin,origin);
 s.change('subject');await assert.rejects(nav.resume(opened.navigationId),/navigation_scope_changed/);assert.equal(s.calls.length,0);
 s.restore();s.change('endpoint');await assert.rejects(nav.resume(opened.navigationId),/navigation_scope_changed/);
 await assert.rejects(s.create('https://other-site.example').resume(opened.navigationId),/navigation_scope_changed/);
 const anonymous=scoped();anonymous.change('anonymous');const anonNav=anonymous.create(),anon=await anonNav.open({object,origin});anonymous.restore();
 await assert.rejects(anonNav.resume(anon.navigationId),/navigation_scope_changed/);
 const legacy=scoped(),legacyId=randomUUID();legacy.records.set('navigation:'+legacyId,{navigationId:legacyId,object,origin,createdAt:1,targetPath:'/app/settings/privacy'});
 await assert.rejects(legacy.create().resume(legacyId),/navigation_owner_unconfirmed/);assert.equal(legacy.calls.length,0);
});

test('current Room/Project/Capsule source failures preserve exact original locators without cached bodies or retry',async()=>{
 const s=scoped(),nav=s.create(),origin={host:'synthetic',workRef:'original-work'};
 for(const object of [{kind:'room',id:randomUUID()},{kind:'project',id:randomUUID()},{kind:'capsule',id:randomUUID(),versionId:randomUUID()}]){
  s.setError(null);const opened=await nav.open({object,origin}),first=await nav.resume(opened.navigationId);assert.equal(first.current,true);
  for(const status of [403,404,410,429,503]){
   s.setError(Object.assign(Error('synthetic_source_unavailable'),{code:'synthetic_source_unavailable',status}));
   const returned=await nav.resume(opened.navigationId);assert.equal(returned.current,false);assert.equal(returned.data,null);
   assert.equal(returned.sourceError,'synthetic_source_unavailable');assert.deepEqual(returned.object,object);assert.deepEqual(returned.origin,origin);
  }
 }
 for(const e of [Object.assign(Error('unauthorized'),{code:'unauthorized',status:401}),Object.assign(Error('binding_revoked'),{code:'binding_revoked',status:403}),Error('internal_failure')]){
  s.setError(e);const opened=await nav.open({object:{kind:'task',id:randomUUID()}});await assert.rejects(nav.resume(opened.navigationId),reason=>reason===e);
 }
});

for(const stage of ['stored-read','source-success','source403','open-store','open-browser'])test('original operation lease rejects late '+stage+' across a new generation',async()=>{
 const s=scoped();let enter,release;const arrived=new Promise(r=>enter=r),gate=()=>{enter();return new Promise(r=>release=r);};
 const object={kind:'task',id:randomUUID()},origin={host:'synthetic',workRef:'PRIVATE_ORIGINAL_REF'};
 let hold=false;
 const normal=s.create(),opened=await normal.open({object,origin});
 const runtimeStore={put:async(k,v)=>{s.records.set(k,v);if(hold&&stage==='open-store')await gate();},get:async k=>{const row=s.records.get(k);if(hold&&stage==='stored-read')await gate();return row;}};
 let context={subjectId:'GUID'+'1'.repeat(28),endpoint:'https://api.example',generation:1};
 const captureLease=async()=>{const old=context;return{...old,assertCurrent(){if(old!==context)throw Object.assign(Error('receipt_status_authority_changed'),{code:'receipt_status_authority_changed'});}};};
 const nav=createNativeNavigation({website:'https://selected.example',store:runtimeStore,captureLease,
  openBrowser:async()=>{if(hold&&stage==='open-browser')await gate();return{launched:true};},
  refresh:async target=>{if(hold&&stage.startsWith('source'))await gate();if(stage==='source403')throw Object.assign(Error('consent_required'),{code:'consent_required',status:403});return{taskId:target.id,request:{summary:'OLD_SCOPE_BODY'}};}});
 hold=true;const result=stage.startsWith('open')?nav.open({object,origin}):nav.resume(opened.navigationId);
 await arrived;context={...context,generation:2};release();await assert.rejects(result,/receipt_status_authority_changed/);
});
