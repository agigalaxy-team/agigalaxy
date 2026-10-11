import {nativeData} from '../../packages/galaxy-edge-mcp/test/native-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {compactVerify,importSPKI} from 'jose';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {serviceFixture} from '../../packages/galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../packages/galaxy-official/src/http.mjs';
import {createBrowserClient,browserScopes} from '../../packages/galaxy-official/src/browser-client.mjs';
import {createIdentityDeviceHandoff} from '../../packages/galaxy-core/src/domain/identity-device-handoff.mjs';
import {createIdentityControlClient} from '../../packages/galaxy-core/src/domain/identity-control-client.mjs';
import {identityKeyId,signIdentityPayload} from '../../packages/galaxy-core/src/domain/identity-material.mjs';
import {createNativeRuntime} from '../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../../packages/galaxy-edge-mcp/src/native-v2/server.mjs';
import {webIdentityProofType,webIdentityProtocol,isWebIdentityTargetPath} from '../../packages/galaxy-edge-mcp/src/native-v2/web-identity-handoff.mjs';
import {webIdentityDefaultScopes} from './identity-web-connect-tools.mjs';

const connectName='galaxy_identity_web_connect',statusName='galaxy_identity_web_connect_status';
function memoryStore(){
 const records=new Map();
 return{get:async key=>structuredClone(records.get(key)),put:async(key,value)=>{records.set(key,structuredClone(value));}};
}
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'galaxy-native-web-connect-'));
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
 const api=createApi({...f,rateLimit:1000});
 await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const local='http://127.0.0.1:'+api.address().port,calls=[],opened=[],runtimes=[],webClients=[],attachments=[];
 let lostCommit=false,bridgeClockOffset=0;
 const fetcher=async(url,options={})=>{
  const target=new URL(url);assert.equal(target.origin,f.access.endpoint);
  assert.ok(!/PRIVATE KEY|galaxy-recovery-v1:/.test(options.body??''));
  const response=await fetch(local+target.pathname,options);
  calls.push({path:target.pathname,method:options.method??'GET',status:response.status,
   ...(target.pathname.endsWith('/commit')?{operationId:JSON.parse(options.body).operationId}:{})});
  if(lostCommit&&target.pathname==='/v2/identity/control/commit'){
   lostCommit=false;assert.equal(response.status,200);throw Error('Synthetic actual committed ACK lost');
  }
  return response;
 };
 const config={endpoint:f.access.endpoint,website:'https://selected.example',trustedKeys:f.access.trustedKeys,now:()=>f.now,fetch:fetcher,
  openBrowser:async url=>{opened.push(url);return{state:'synthetic-launch-captured',launched:false};}};
 async function native(name,initialize=false){
  const runtime=await createNativeRuntime({...config,dataDirectory:join(directory,name)});runtimes.push(runtime);
  if(initialize){await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});}
  return runtime;
 }
 const original=await native('original',true),subjectId=(await original.status()).identity;
 const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',
  workContext:{goal:'Synthetic original work',currentSituation:'Isolated local signed HTTP source',attemptRefs:[]},
  title:'Synthetic private original Task',summary:'SYNTHETIC_PRIVATE_TASK_BODY',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+3600};
 const auth=await original.authorize({requestId:randomUUID(),payloadJson:JSON.stringify(task),action:'assistance.publish',
  objectId:task.operationId,visibility:'Private',viewers:[],expiresAt:f.now+3600},{confirmed:true});
 await original.api.call('/v2/tasks',{consentId:auth.consentId,payloadJson:auth.payloadJson});
 const origin={host:'synthetic-original-native-host',workRef:'PRIVATE_ORIGINAL_WORK_REF'};
 async function attach(runtime){
  // Only the temporary bridge clock is injectable; signed API sessions and all
  // actual device authorization clocks stay at the fixture's service clock.
  const controlled=Object.freeze({...runtime,now:()=>f.now+bridgeClockOffset}),server=createNativeToolServer(controlled);
  const client=new Client({name:'synthetic-web-connect-mcp',version:'1'},{capabilities:{}});
  const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  const raw=(name,input)=>client.callTool({name,arguments:input});
  const call=async(name,input)=>{const result=await raw(name,input),value=nativeData(result);
   assert.equal(result.isError??false,false,JSON.stringify(value));return value;};
  let closed=false;const attachment={server,client,raw,call,async close(){if(closed)return;closed=true;await client.close();await server.close();}};
  attachments.push(attachment);return attachment;
 }
 const attached=await attach(original);
 async function prepare(options={}){
  const input={requestId:randomUUID(),object:{kind:'task',id:task.taskId},origin,scopes:[...webIdentityDefaultScopes],...options};
  const info=await attached.call(connectName,input);assert.equal(info.subjectId,subjectId);
  const targetPath=input.continueWith?.kind==='method-search'?'/app/search?'+new URLSearchParams({q:input.continueWith.query,sourceTask:task.taskId,returnTo:'/app/tasks/'+task.taskId+'?section=collaboration'}).toString()
   :input.continueWith?'/app/capsules/'+input.continueWith.id+'/versions/'+input.continueWith.versionId+'?'
   +new URLSearchParams({sourceTask:task.taskId,returnTo:'/app/tasks/'+task.taskId+'?section=collaboration'}).toString():'/app/tasks/'+task.taskId;
  assert.equal(info.targetPath,targetPath);assert.equal(info.publicPacketsOnly,true);
  assert.equal(info.originalWorkRef,'native-local-only');assert.equal(info.websiteConnectionIndependentlyVerified,false);
  assert.ok(!JSON.stringify(info).includes(origin.workRef));assert.ok(!info.url.includes(task.taskId));
  const bridgeOrigin=new URL(info.url).origin;
  const envelope=(kind,payload)=>({protocol:webIdentityProtocol,version:1,handoffId:info.handoffId,navigationId:info.navigationId,kind,payload});
  const post=async(path,body,headers={})=>{
   const response=await fetch(info.url+path,{method:'POST',headers:{Origin:bridgeOrigin,'Sec-Fetch-Site':'same-origin',
    'Content-Type':typeof body==='string'?'application/x-www-form-urlencoded':'application/json',...headers},
    body:typeof body==='string'?body:JSON.stringify(body)});
   return{status:response.status,value:await response.json()};
  };
  return{input,info,origin:bridgeOrigin,envelope,post,
   message:async(kind,payload)=>{const result=await post('/message',envelope(kind,payload));assert.equal(result.status,200,JSON.stringify(result.value));return result.value;},
   choose:async(action='approve')=>{const result=await post('/choice','action='+action);assert.equal(result.status,200,JSON.stringify(result.value));return result.value;}};
 }
 async function web(store=memoryStore()){
  let active=null;
  const client=createBrowserClient({endpoint:f.access.endpoint,trustedKeys:f.access.trustedKeys,fetch:fetcher,now:()=>f.now,
   sign:async(text,type)=>{const material=await store.get('device:'+active.subjectId+':'+active.deviceId);return signIdentityPayload(text,material.privateKey,{type});}});
  webClients.push(client);
  const handoff=createIdentityDeviceHandoff({endpoint:f.access.endpoint,send:client.send,store,getActive:()=>active,
   activate:async value=>{client.disconnect();active=value;},allowedScopes:browserScopes,now:()=>f.now});
  const read=()=>client.call('/v2/identity/'+subjectId+'/control',undefined,{method:'GET',authenticated:false});
  async function connect(){
   const state=await read(),device=state.devices.find(item=>item.device_id===active.deviceId);
   const material=await store.get('device:'+active.subjectId+':'+active.deviceId);
   assert.equal(device.public_key,material.publicKeyPem);assert.equal(device.status,'active');
   await client.connect({subjectId:active.subjectId,genesisProof:active.genesisProof,installationId:active.installationId,
    scopes:browserScopes.filter(scope=>device.scopes.includes(scope)||device.scopes.includes('*')),
    control:{deviceId:device.device_id,keyId:device.key_id,epoch:state.epoch}},{confirmed:true});
  }
  return{store,client,handoff,read,connect,getActive:()=>active,setActive:value=>active=value};
 }
 async function verifyProof(context,nonce,descriptor,targetPath='/app/tasks/'+task.taskId){
  const proof=context.proof,state=await original.api.call('/v2/identity/'+subjectId+'/control',undefined,{method:'GET',authenticated:false});
  const controller=state.devices.find(item=>item.device_id===context.controller.deviceId);
  assert.equal(controller.status,'active');assert.equal(context.controller.keyId,controller.key_id);
  assert.equal(context.controller.epoch,state.epoch);assert.equal(context.controller.chainHead,state.chainHead);
  const verified=await compactVerify(proof.signature,await importSPKI(controller.public_key,'Ed25519'));
  assert.deepEqual(verified.protectedHeader,{alg:'Ed25519',typ:webIdentityProofType});
  assert.equal(new TextDecoder().decode(verified.payload),proof.payloadJson);
  const body=JSON.parse(proof.payloadJson);assert.equal(body.nonce,nonce);
  assert.equal(body.context.subjectId,subjectId);assert.deepEqual(body.context.existingDevice,descriptor);
  assert.deepEqual(context.existingDevice,descriptor);assert.equal(body.bridgeOrigin,context.bridgeOrigin);
  assert.equal(body.context.website,'https://selected.example');assert.equal(body.context.targetPath,targetPath);
  assert.ok(!proof.payloadJson.includes(origin.workRef));return body;
 }
 async function revoke(runtime,deviceId){
  const state=await runtime.api.call('/v2/identity/'+subjectId+'/control',undefined,{method:'GET',authenticated:false});
  const activeDevice=runtime.api.snapshot().control.deviceId,material=await runtime.store.get('device:'+subjectId+':'+activeDevice);
  const control=createIdentityControlClient({endpoint:f.access.endpoint,send:runtime.api.call?((url,options)=>runtime.api.call(url.slice(f.access.endpoint.length),
   options.bodyJson===undefined?undefined:JSON.parse(options.bodyJson),{method:options.method,authenticated:false})):null,
   store:runtime.store,now:()=>f.now,signController:text=>signIdentityPayload(text,material.privateKey)});
  const request={version:2,kind:'revoke-device',operationId:randomUUID(),subjectId,expectedEpoch:state.epoch,previousEventHash:state.chainHead,
   signerKeyId:await identityKeyId(material.publicKeyPem),deviceId};
  return control.confirm(await control.prepare(request),{confirmed:true});
 }
 return{f,local,original,subjectId,task,auth,origin,calls,opened,...attached,prepare,web,native,attach,verifyProof,revoke,
  loseNextCommit:()=>lostCommit=true,expireBridgeClock:()=>bridgeClockOffset=181,
  async cleanup(){
   for(const attachment of attachments)await attachment.close();
   webClients.forEach(client=>client.close());runtimes.forEach(runtime=>runtime.close());
   api.closeAllConnections();if(api.listening)await new Promise(resolve=>api.close(resolve));await f.db.close();
   const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-native-web-connect-'));
   await rm(target,{recursive:true,force:true});
  }};
}

test('actual MCP/public signed bridge joins existing Native GUID, preserves unknown operation and original Task; same-device proof and refresh use current control',{timeout:90000},async()=>{
 const x=await fixture();
 try{
  const baselineCommits=x.calls.filter(call=>call.path.endsWith('/commit')).length,baselineSubjects=(await x.f.db.query('SELECT count(*)::int n FROM subjects')).rows[0].n;
  const bridge=await x.prepare();
  const listed=await x.client.listTools();assert.ok(listed.tools.some(tool=>tool.name===connectName));assert.ok(listed.tools.some(tool=>tool.name===statusName));
  const response=await fetch(bridge.info.url),html=await response.text();
  assert.equal(response.status,200);assert.equal(response.headers.get('x-frame-options'),'DENY');
  assert.match(response.headers.get('content-security-policy'),/connect-src 'self'/);assert.ok(html.includes('批准这次显示的设备与权限'));
  assert.ok(!html.includes(x.origin.workRef));assert.ok(!html.includes(x.task.summary));assert.ok(!/PRIVATE KEY|galaxy-recovery-v1:/.test(html));
  assert.equal(x.calls.filter(call=>call.path.endsWith('/commit')).length,baselineCommits,'preparation cannot grant a device');
  const nonce=randomUUID(),ready=await bridge.message('ready',{nonce,existingDevice:null});
  assert.equal(ready.state,'ready');await x.verifyProof(ready.context,nonce,null);
  const duplicateReady=await bridge.message('ready',{nonce,existingDevice:null});assert.deepEqual(duplicateReady.context,ready.context);
  assert.equal((await bridge.post('/message',bridge.envelope('ready',{nonce:randomUUID(),existingDevice:null}))).value.error,'web_identity_browser_changed');
  assert.equal((await bridge.post('/message',bridge.envelope('ready',{nonce,existingDevice:null,confirmed:true}))).status,409);
  assert.equal((await bridge.post('/message',{...bridge.envelope('ready',{nonce,existingDevice:null}),handoffId:randomUUID()})).value.error,'web_identity_message_invalid');
  assert.equal((await bridge.post('/message',bridge.envelope('ready',{nonce,existingDevice:null}),{Origin:'https://selected.example'})).status,403);
  assert.equal((await bridge.post('/message',bridge.envelope('ready',{nonce,existingDevice:null}),{'Sec-Fetch-Site':'cross-site'})).status,403);
  const website=await x.web(),offer=await website.handoff.createOffer(x.subjectId,{scopes:[...webIdentityDefaultScopes],confirmed:true});
  assert.equal(offer.subjectId,x.subjectId);assert.equal(website.getActive(),null);
  const offered=await bridge.message('offer',offer);assert.equal(offered.state,'offered');
  assert.equal(offered.fingerprint,await identityKeyId(offer.publicKeyPem));
  assert.equal((await bridge.message('offer',offer)).operationId,offer.operationId);
  assert.equal((await bridge.post('/message',bridge.envelope('offer',{...offer,operationId:randomUUID()}))).value.error,'web_identity_offer_changed');
  assert.equal((await bridge.post('/message',bridge.envelope('offer',{...offer,scopes:[...offer.scopes,'manage-identity']}))).value.error,'web_identity_offer_invalid');
  assert.equal((await bridge.post('/choice','action=approve',{Origin:'https://selected.example'})).status,403);
  assert.equal((await x.f.db.query('SELECT count(*)::int n FROM device_authorizations WHERE subject_id=$1',[x.subjectId])).rows[0].n,1);
  const approved=await bridge.choose();assert.equal(approved.state,'approved');
  assert.deepEqual(approved.approval.offer,offer);
  assert.equal((await bridge.choose()).approval.challenge,approved.approval.challenge,'repeat explicit choice preserves original challenge');
  await website.handoff.previewApproval(approved.approval);
  x.loseNextCommit();await assert.rejects(website.handoff.acceptApproval(approved.approval,{confirmed:true}),/committed ACK lost/);
  assert.equal(website.getActive(),null);assert.equal((await website.handoff.pending()).state,'awaiting-result');
  const originalOperation=offer.operationId;
  assert.equal((await website.handoff.createOffer(x.subjectId,{scopes:offer.scopes,confirmed:true})).operationId,originalOperation);
  const same=await bridge.message('offer',offer);assert.deepEqual(same.approval,approved.approval);
  const reconciled=await website.handoff.reconcile(originalOperation);assert.equal(reconciled.receipt.state,'committed');assert.equal(reconciled.activated,true);
  assert.equal(website.getActive().subjectId,x.subjectId);await website.connect();
  const control=await website.read(),device=control.devices.find(item=>item.device_id===offer.deviceId);
  assert.equal(device.source_event_id,originalOperation);assert.equal(device.key_id,await identityKeyId(offer.publicKeyPem));
  const report={operationId:originalOperation,subjectId:x.subjectId,deviceId:offer.deviceId,epoch:control.epoch,chainHead:control.chainHead,connected:true};
  const completed=await bridge.message('completed',report);assert.equal(completed.state,'completed');
  assert.equal(completed.deviceAuthorizationVerified,true);assert.equal(completed.completed.websiteConnectionIndependentlyVerified,false);
  assert.equal((await bridge.message('completed',report)).revision,completed.revision);
  assert.equal((await x.call(statusName,{handoffId:bridge.info.handoffId})).operationId,originalOperation);
  assert.equal(x.calls.filter(call=>call.path.endsWith('/commit')&&call.operationId===originalOperation).length,1);
  assert.equal((await x.f.db.query('SELECT count(*)::int n FROM subjects')).rows[0].n,baselineSubjects);
  assert.equal((await x.f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,1);
  const returned=await x.call('galaxy_return',{navigationId:bridge.info.navigationId});
  assert.deepEqual(returned.origin,x.origin);assert.equal(returned.object.id,x.task.taskId);
  assert.equal(returned.data.taskId,x.task.taskId);assert.equal(returned.data.request.summary,x.task.summary);
  const webTask=await website.client.call('/v2/tasks/'+x.task.taskId,undefined,{method:'GET'});assert.equal(webTask.taskId,x.task.taskId);
  // Same-GUID reuse is bound to this exact already owned website key, not just
  // a loopback subject label. Its proof still uses the current Native signer.
  const second=await x.prepare(),descriptor={subjectId:x.subjectId,deviceId:offer.deviceId,keyId:device.key_id},nextNonce=randomUUID();
  const noDescriptor=await second.message('ready',{nonce:nextNonce,existingDevice:null});
  assert.equal((await second.post('/message',second.envelope('completed',{...report,operationId:null}))).value.error,'web_identity_original_device_required');
  assert.equal(noDescriptor.context.existingDevice,null);
  await second.message('canceled',null);
  const third=await x.prepare(),reuse=await third.message('ready',{nonce:randomUUID(),existingDevice:descriptor});
  await x.verifyProof(reuse.context,reuse.context.nonce,descriptor);
  const reuseComplete=await third.message('completed',{...report,operationId:null});assert.equal(reuseComplete.state,'completed');
  assert.equal(x.calls.filter(call=>call.path.endsWith('/commit')&&call.operationId===originalOperation).length,1);
  const countsBefore=x.calls.filter(call=>call.path.endsWith('/commit')).length;
  x.expireBridgeClock();assert.equal((await fetch(third.info.url+'/state')).status,409);
  // Expiring/closing the short bridge does not revoke the actual website
  // device. A fresh API client restores its own held key and connects directly.
  const restored=await x.web(website.store);restored.setActive(website.getActive());await restored.connect();
  assert.equal((await restored.client.call('/v2/tasks/'+x.task.taskId,undefined,{method:'GET'})).taskId,x.task.taskId);
  assert.equal(x.calls.filter(call=>call.path.endsWith('/commit')).length,countsBefore);
  console.log(JSON.stringify({actualMcp:true,actualNativeLocalGenesis:true,actualSignedHttp:true,actualPGlite:true,actualNonExportableBrowserDeviceKey:true,
   publicNativeProofVerified:true,unknownCommittedAckSameOperation:true,exactExistingDeviceProof:true,bridgeOnlyClockExpiry:true,
   freshDeviceConnectionIndependentOfBridge:true,originalPrivateTaskReturn:true,browserPopupNotExercised:true,physicalHostAcceptance:false,modelCalls:0}));
 }finally{await x.cleanup();}
});

test('same-owner rebind, original Task withdrawal, invalid existing device, and close preserve journals and refuse late new-device approval',{timeout:90000},async()=>{
 const x=await fixture();
 try{
  const website=await x.web(),first=await x.prepare();
  const fake={subjectId:x.subjectId,deviceId:randomUUID(),keyId:'a'.repeat(64)},nonce=randomUUID();
  const invalid=await first.post('/message',first.envelope('ready',{nonce,existingDevice:fake}));
  assert.equal(invalid.value.error,'web_identity_existing_device_control_required');
  const valid=await first.message('ready',{nonce,existingDevice:null});await x.verifyProof(valid.context,nonce,null);
  const offer=await website.handoff.createOffer(x.subjectId,{scopes:[...webIdentityDefaultScopes],confirmed:true});
  await first.message('offer',offer);const before=x.calls.filter(call=>call.path.endsWith('/commit')).length;
  await x.original.connect({confirmed:true});
  assert.equal((await first.post('/choice','action=approve')).value.error,'receipt_status_authority_changed');
  assert.equal(x.calls.filter(call=>call.path.endsWith('/commit')).length,before);
  const second=await x.prepare();await second.message('ready',{nonce:randomUUID(),existingDevice:null});await second.message('offer',offer);
  await x.original.api.call('/v1/consents/'+x.auth.consentId+'/revoke',{});
  const withdrew=await second.post('/choice','action=approve');assert.equal(withdrew.value.error,'web_identity_original_target_unavailable');
  assert.equal(x.calls.filter(call=>call.path.endsWith('/commit')).length,before);
  assert.equal((await website.handoff.pending()).operationId,offer.operationId);
  await x.close();await assert.rejects(fetch(second.info.url));
  const journal=await x.original.store.get('web-identity-handoff:'+second.info.handoffId);
  assert.equal(journal.state,'stopped');assert.equal(journal.operationId,offer.operationId);assert.equal(journal.transportClosed,true);
  const restarted=await x.attach(x.original),restored=await restarted.call(connectName,second.input);
  assert.equal(restored.transportRestarted,false);assert.equal(restored.originalJournalPreserved,true);assert.equal(restored.url,null);
  assert.equal(restored.operationId,offer.operationId);assert.equal(restored.nextAction,'query-original-device-operation');
  assert.equal((await restarted.raw(connectName,{...second.input,confirmed:true})).isError,true);
  assert.equal(x.calls.filter(call=>call.path.endsWith('/commit')).length,before);
  console.log(JSON.stringify({actualCurrentNativeLease:true,actualConsentWithdrawal403:true,invalidExistingKeyRefused:true,
   failedProofRetryPreservesNonceIntent:true,noLateApproval:true,originalOperationRetained:true,closedListener:true,restoredJournalNoTransportRestart:true,modelCalls:0}));
 }finally{await x.cleanup();}
});

test('revoking the original Native stops its pending proof/approval; delegated website survives only until its own current grant is revoked',{timeout:90000},async()=>{
 const x=await fixture();
 try{
  const companion=await x.native('companion'),companionOffer=await companion.device.offer(x.subjectId,{confirmed:true});
  await companion.device.accept(await x.original.device.approve(companionOffer,{confirmed:true}),{confirmed:true});await companion.connect({confirmed:true});
  const website=await x.web(),bridge=await x.prepare();
  await bridge.message('ready',{nonce:randomUUID(),existingDevice:null});
  const offer=await website.handoff.createOffer(x.subjectId,{scopes:[...webIdentityDefaultScopes],confirmed:true});
  await bridge.message('offer',offer);const approved=await bridge.choose();await website.handoff.acceptApproval(approved.approval,{confirmed:true});await website.connect();
  const state=await website.read(),report={operationId:offer.operationId,subjectId:x.subjectId,deviceId:offer.deviceId,epoch:state.epoch,chainHead:state.chainHead,connected:true};
  await bridge.message('completed',report);
  const pending=await x.prepare(),other=await x.web(),otherOffer=await other.handoff.createOffer(x.subjectId,{scopes:[...webIdentityDefaultScopes],confirmed:true});
  await pending.message('ready',{nonce:randomUUID(),existingDevice:null});await pending.message('offer',otherOffer);
  const nativeDevice=x.original.api.snapshot().control.deviceId;await x.revoke(companion,nativeDevice);
  const before=x.calls.filter(call=>call.path.endsWith('/commit')).length;
  const rejected=await pending.post('/choice','action=approve');assert.equal(rejected.value.error,'web_identity_current_native_control_required');
  assert.equal(x.calls.filter(call=>call.path.endsWith('/commit')).length,before);
  await assert.rejects(x.original.connect({confirmed:true}),/current_device_control_required/);
  // Existing website authority is its own current device grant; revoking the
  // previous delegating Native does not implicitly revoke that separate grant.
  website.client.disconnect();await website.connect();
  const retainedConsent=await website.client.call('/v2/consents/receipt',{consentId:x.auth.consentId});
  assert.equal(retainedConsent.state,'recorded');assert.equal(retainedConsent.status,'revoked');
  await assert.rejects(website.client.call('/v2/tasks/'+x.task.taskId,undefined,{method:'GET'}),/consent_required/);
  await x.revoke(companion,offer.deviceId);
  await assert.rejects(website.client.call('/v2/consents/receipt',{consentId:x.auth.consentId}),/access_denied/);
  assert.equal((await website.read()).devices.find(item=>item.device_id===offer.deviceId).status,'revoked');
  const retained=await x.original.store.get('web-identity-handoff:'+pending.info.handoffId);
  assert.equal(retained.operationId,otherOffer.operationId);assert.equal(retained.deviceAuthorizationVerified,false);
  console.log(JSON.stringify({actualNativeDeviceRevocation:true,pendingApprovalDenied:true,delegatedWebsiteGrantIndependent:true,
   originalNativeBindingConsentRevoked:true,originalPrivateBodyWithheld:true,actualWebsiteDeviceRevocationDenied:true,
   originalPublicOperationPreserved:true,physicalHostAcceptance:false,modelCalls:0}));
 }finally{await x.cleanup();}
});

test('identity bridge target routes require known local app paths and exact UUID components',()=>{
 for(const path of ['/app/tasks/'+randomUUID(),'/app/rooms/'+randomUUID(),'/app/projects/'+randomUUID(),
  '/app/capsules/'+randomUUID()+'/versions/'+randomUUID(),'/app/publish','/app/settings/privacy'])assert.equal(isWebIdentityTargetPath(path),true,path);
 for(const path of ['//selected.example/app/publish','https://selected.example/app/publish','/app/settings/identity','/app/tasks/'+'-'.repeat(36),
  '/app/tasks/'+randomUUID()+'?returnTo=https://evil.example','/app/%70ublish','/app/../publish','/app/publish#work','/app/publish\\evil'])assert.equal(isWebIdentityTargetPath(path),false,path);
 const taskId=randomUUID(),capsuleId=randomUUID(),versionId=randomUUID(),base='/app/capsules/'+capsuleId+'/versions/'+versionId;
 const query=new URLSearchParams({sourceTask:taskId,returnTo:'/app/tasks/'+taskId+'?section=collaboration'}).toString(),path=base+'?'+query;
 assert.equal(isWebIdentityTargetPath(path),true,path);
 const methodPath='/app/search?'+new URLSearchParams({q:'原阅读检查：需要相关方法',sourceTask:taskId,returnTo:'/app/tasks/'+taskId+'?section=collaboration'}).toString();
 assert.equal(isWebIdentityTargetPath(methodPath),true,methodPath);
 for(const bad of [methodPath+'&q=other',methodPath+'&extra=true',methodPath.replace('q=','%71='),methodPath.replace('sourceTask='+taskId,'sourceTask='+randomUUID()),
  '/app/search?'+new URLSearchParams({q:'',sourceTask:taskId,returnTo:'/app/tasks/'+taskId+'?section=collaboration'}),
  '/app/search?'+new URLSearchParams({q:'current query',sourceTask:taskId,returnTo:'https://foreign.example/app/tasks/'+taskId})])assert.equal(isWebIdentityTargetPath(bad),false,bad);
 for(const bad of [path+'&extra=true',path+'&sourceTask='+taskId,path+'&returnTo='+encodeURIComponent('/app/tasks/'+taskId+'?section=collaboration'),
  base+'?'+new URLSearchParams({returnTo:'/app/tasks/'+taskId+'?section=collaboration',sourceTask:taskId}),
  base+'?'+new URLSearchParams({sourceTask:taskId,returnTo:'/app/tasks/'+randomUUID()+'?section=collaboration'}),
  base+'?'+new URLSearchParams({sourceTask:taskId,returnTo:'//selected.example/app/tasks/'+taskId}),
  base+'?'+new URLSearchParams({sourceTask:taskId,returnTo:'https://selected.example/app/tasks/'+taskId}),
  base+'?'+new URLSearchParams({sourceTask:taskId,returnTo:'/app/tasks/'+taskId+'?section=details'}),
  path.replaceAll('%2F','%2f'),path.replace('sourceTask','%73ourceTask'),path.replace('/app/capsules/','/app/%63apsules/'),path+'#work',
  '/app/tasks/'+taskId+'?'+query,base+'?'+query+'?extra=true'])assert.equal(isWebIdentityTargetPath(bad),false,bad);
});

test('method search signs the actual query and exact original Task return without creating a Capsule or transferring the private work reference',{timeout:60000},async()=>{
 const x=await fixture();
 try{
  const query='原页面说明 阅读方法',scopes=[...webIdentityDefaultScopes,'capsules'],before=x.calls.filter(row=>row.path.endsWith('/commit')).length;
  const bridge=await x.prepare({scopes,continueWith:{kind:'method-search',query}});
  const expected='/app/search?'+new URLSearchParams({q:query,sourceTask:x.task.taskId,returnTo:'/app/tasks/'+x.task.taskId+'?section=collaboration'}).toString();
  assert.equal(bridge.info.targetPath,expected);
  const html=await(await fetch(bridge.info.url)).text();
  assert.match(html,/围绕“原页面说明 阅读方法”查找方法，随后返回原求助/);
  assert.ok(html.includes('<details><summary>准确身份与原目标</summary>'));
  assert.equal(html.slice(0,html.indexOf('<details>')).includes(x.subjectId),false);
  const navigation=await x.original.store.get('navigation:'+bridge.info.navigationId);
  assert.deepEqual(navigation.object,{kind:'task',id:x.task.taskId});assert.deepEqual(navigation.origin,x.origin);
  const nonce=randomUUID(),ready=await bridge.message('ready',{nonce,existingDevice:null});
  assert.equal(ready.context.targetPath,expected);await x.verifyProof(ready.context,nonce,null,expected);
  assert.equal(JSON.stringify(ready.context).includes(x.origin.workRef),false,'private host input stays in the original local navigation');
  const changed=await x.raw(connectName,{...bridge.input,continueWith:{kind:'method-search',query:query+' altered'}});
  assert.equal(changed.isError,true);assert.equal(nativeData(changed).error,'web_identity_request_changed');
  const noScope=await x.raw(connectName,{requestId:randomUUID(),object:{kind:'task',id:x.task.taskId},continueWith:{kind:'method-search',query},scopes:[...webIdentityDefaultScopes]});
  assert.equal(noScope.isError,true);
  const back=await x.call('galaxy_return',{navigationId:bridge.info.navigationId});
  assert.equal(back.object.id,x.task.taskId);assert.deepEqual(back.origin,x.origin);assert.equal(back.data.request.summary,x.task.summary);
  assert.equal(x.calls.filter(row=>row.path.endsWith('/commit')).length,before);
  await Promise.all([x.server.close(),x.server.close()]);
  const retained=await x.original.store.get('web-identity-handoff:'+bridge.info.handoffId);
  assert.equal(retained.state,'stopped');assert.equal(retained.targetPath,expected);
  await assert.rejects(fetch(bridge.info.url+'/state'),/fetch failed/);
 }finally{await x.cleanup();}
});

test('tool entry lease rejects a real rebind held before retained-request lookup finishes',{timeout:60000},async()=>{
 const x=await fixture();let release;
 try{
  const input={requestId:randomUUID(),object:{kind:'task',id:x.task.taskId},origin:x.origin,scopes:[...webIdentityDefaultScopes]};
  let enter,held=true;const reached=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  const originalStore=x.original.store,delayedStore={...originalStore,get:async key=>{
   const value=await originalStore.get(key);
   if(held&&key==='web-identity-connect-request:'+x.f.access.endpoint+':'+input.requestId){held=false;enter();await gate;}
   return value;
  }};
  const delayed=await x.attach({...x.original,store:delayedStore}),before=x.original.api.snapshot(),waiting=delayed.raw(connectName,input);
  await reached;await x.original.connect({confirmed:true});assert.notEqual(x.original.api.snapshot().bindingId,before.bindingId);
  release();const result=await waiting,value=nativeData(result);
  assert.equal(result.isError,true,'an action begun on the old binding cannot prepare a new-binding bridge');
  assert.equal(value.error,'receipt_status_authority_changed');assert.equal(value.url,undefined);assert.equal(value.subjectId,undefined);
  assert.equal(await originalStore.get('web-identity-connect-request:'+x.f.access.endpoint+':'+input.requestId),null);
  const retained=await x.prepare();await x.close();
  let statusEnter,statusHeld=true;const statusReached=new Promise(resolve=>statusEnter=resolve),statusGate=new Promise(resolve=>release=resolve);
  const statusStore={...originalStore,get:async key=>{const stored=await originalStore.get(key);
   if(statusHeld&&key==='web-identity-connect-request:'+x.f.access.endpoint+':'+retained.info.handoffId){statusHeld=false;statusEnter();await statusGate;}
   return stored;
  }};
  const query=await x.attach({...x.original,store:statusStore}),beforeQuery=x.original.api.snapshot();
  const pendingQuery=query.raw(statusName,{handoffId:retained.info.handoffId});await statusReached;
  await x.original.connect({confirmed:true});assert.notEqual(x.original.api.snapshot().bindingId,beforeQuery.bindingId);release();
  const queryResult=await pendingQuery,queryValue=nativeData(queryResult);
  assert.equal(queryResult.isError,true);assert.equal(queryValue.error,'receipt_status_authority_changed');assert.equal(queryValue.subjectId,undefined);
  assert.equal((await originalStore.get('web-identity-handoff:'+retained.info.handoffId)).state,'stopped');
  console.log(JSON.stringify({actualHeldNativeStore:true,actualSameGuidRebind:true,oldEntryRefusedBeforeLocalRequestJournal:true,
   heldRetainedStatusRefusedAcrossNewBinding:true,noNewBridgeForOldEntry:true,noDeviceGrant:true,physicalHostAcceptance:false,modelCalls:0}));
 }finally{release?.();await x.cleanup();}
});

test('existing default-six website device can explicitly request capsules through a new same-GUID device; insufficient old key cannot null-complete',{timeout:90000},async()=>{
 const x=await fixture();
 try{
  const subjectsBefore=(await x.f.db.query('SELECT count(*)::int n FROM subjects')).rows[0].n;
  const website=await x.web(),initial=await x.prepare();
  await initial.message('ready',{nonce:randomUUID(),existingDevice:null});
  const oldOffer=await website.handoff.createOffer(x.subjectId,{scopes:[...webIdentityDefaultScopes],confirmed:true});
  await initial.message('offer',oldOffer);const firstApproval=await initial.choose();
  await website.handoff.acceptApproval(firstApproval.approval,{confirmed:true});await website.connect();
  const oldActive=website.getActive(),control=await website.read(),oldDevice=control.devices.find(d=>d.device_id===oldOffer.deviceId);
  assert.equal(oldDevice.status,'active');assert.equal(oldDevice.scopes.includes('capsules'),false);
  await initial.message('completed',{operationId:oldOffer.operationId,subjectId:x.subjectId,deviceId:oldOffer.deviceId,epoch:control.epoch,chainHead:control.chainHead,connected:true});
  const scopes=[...webIdentityDefaultScopes,'capsules'],continueWith={kind:'capsule',id:randomUUID(),versionId:randomUUID()};
  const wrongObject=await x.raw(connectName,{requestId:randomUUID(),object:{kind:'room',id:randomUUID()},continueWith,scopes});
  assert.equal(wrongObject.isError,true);
  const arbitraryReturn=await x.raw(connectName,{requestId:randomUUID(),object:{kind:'task',id:x.task.taskId},continueWith:{...continueWith,returnTo:'https://foreign.example'},scopes});
  assert.equal(arbitraryReturn.isError,true);
  const bridge=await x.prepare({scopes,continueWith});
  const originalNavigation=await x.original.store.get('navigation:'+bridge.info.navigationId);
  assert.deepEqual(originalNavigation.object,{kind:'task',id:x.task.taskId});assert.equal(originalNavigation.targetPath,'/app/tasks/'+x.task.taskId);
  assert.deepEqual(originalNavigation.origin,x.origin);
  const changedRequest=await x.raw(connectName,{...bridge.input,continueWith:{...continueWith,versionId:randomUUID()}});
  assert.equal(changedRequest.isError,true);assert.equal(nativeData(changedRequest).error,'web_identity_request_changed');
  const descriptor={subjectId:x.subjectId,deviceId:oldOffer.deviceId,keyId:oldDevice.key_id},nonce=randomUUID();
  const wrongKey=await bridge.post('/message',bridge.envelope('ready',{nonce,existingDevice:{...descriptor,keyId:'a'.repeat(64)}}));
  assert.equal(wrongKey.value.error,'web_identity_existing_device_control_required');
  const ready=await bridge.post('/message',bridge.envelope('ready',{nonce,existingDevice:descriptor}));
  console.log(JSON.stringify({counterexample:'active old default-six device requests explicit capsules offer',actualStatus:ready.status,actualError:ready.value.error??null,
   actualOldDeviceActive:true,oldDeviceHasCapsules:false,actualSourceNative:true}));
  assert.equal(ready.status,200,'descriptor identifies the existing active key; requested new scope is granted only by explicit new-device approval');
  assert.equal(ready.value.error,null,'a newly verified context clears the recoverable wrong-key notice');
  await x.verifyProof(ready.value.context,nonce,descriptor,bridge.info.targetPath);
  const tampered=JSON.parse(ready.value.context.proof.payloadJson);
  tampered.context.targetPath=tampered.context.targetPath.replace(continueWith.versionId,randomUUID());
  const controller=control.devices.find(d=>d.device_id===ready.value.context.controller.deviceId);
  const verified=await compactVerify(ready.value.context.proof.signature,await importSPKI(controller.public_key,'Ed25519'));
  assert.notEqual(new TextDecoder().decode(verified.payload),JSON.stringify(tampered),'a different Capsule version cannot reuse this signed intent');
  const parts=ready.value.context.proof.signature.split('.');
  await assert.rejects(compactVerify(parts[0]+'.'+Buffer.from(JSON.stringify(tampered)).toString('base64url')+'.'+parts[2],
   await importSPKI(controller.public_key,'Ed25519')),{code:'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'});
  const noGrant=await bridge.post('/message',bridge.envelope('completed',{operationId:null,subjectId:x.subjectId,deviceId:oldOffer.deviceId,epoch:control.epoch,chainHead:control.chainHead,connected:true}));
  assert.equal(noGrant.value.error,'web_identity_current_control_required');
  assert.deepEqual(website.getActive(),oldActive);
  const before=x.calls.filter(call=>call.path.endsWith('/commit')).length;
  const offer=await website.handoff.createOffer(x.subjectId,{scopes,confirmed:true});
  assert.equal(offer.subjectId,x.subjectId);assert.notEqual(offer.deviceId,oldOffer.deviceId);assert.notEqual(offer.operationId,oldOffer.operationId);
  assert.deepEqual(website.getActive(),oldActive);assert.ok(await website.store.get('device:'+x.subjectId+':'+oldOffer.deviceId));
  await bridge.message('offer',offer);assert.equal(x.calls.filter(call=>call.path.endsWith('/commit')).length,before);
  const approved=await bridge.choose();await website.handoff.previewApproval(approved.approval);
  x.loseNextCommit();await assert.rejects(website.handoff.acceptApproval(approved.approval,{confirmed:true}),/committed ACK lost/);
  assert.deepEqual(website.getActive(),oldActive);assert.equal((await website.handoff.pending()).state,'awaiting-result');
  assert.equal((await website.handoff.createOffer(x.subjectId,{scopes,confirmed:true})).operationId,offer.operationId);
  await assert.rejects(website.handoff.createOffer(x.subjectId,{scopes:[...webIdentityDefaultScopes],confirmed:true}),/device_pending_request_exists/);
  const bypass=await bridge.post('/message',bridge.envelope('completed',{operationId:null,subjectId:x.subjectId,deviceId:oldOffer.deviceId,epoch:control.epoch,chainHead:control.chainHead,connected:true}));
  assert.equal(bypass.value.error,'web_identity_original_operation_required');
  const recovered=await website.handoff.reconcile(offer.operationId);
  assert.equal(recovered.needsLocalDeviceSelection,true);
  assert.equal(recovered.activated,false);assert.deepEqual(website.getActive(),oldActive);
  assert.equal((await website.handoff.pending()).needsLocalDeviceSelection,true);
  assert.equal((await website.handoff.createOffer(x.subjectId,{scopes,confirmed:true})).operationId,offer.operationId);
  const selection=await website.handoff.previewLocalDeviceSelection(offer.operationId);
  assert.equal(selection.previousDeviceId,oldOffer.deviceId);assert.equal(selection.deviceId,offer.deviceId);
  assert.deepEqual(selection.scopes,scopes);assert.equal(selection.subjectId,x.subjectId);
  const selected=await website.handoff.selectLocalDevice(selection,{confirmed:true});
  assert.equal(selected.localDeviceSelected,true);assert.equal(selected.activated,true);await website.connect();
  const fresh=await website.read(),device=fresh.devices.find(d=>d.device_id===offer.deviceId);
  assert.equal(device.source_event_id,offer.operationId);assert.ok(device.scopes.includes('capsules'));
  assert.equal(fresh.devices.find(d=>d.device_id===oldOffer.deviceId).status,'active');
  assert.equal(fresh.devices.find(d=>d.device_id===oldOffer.deviceId).scopes.includes('capsules'),false);
  const done=await bridge.message('completed',{operationId:offer.operationId,subjectId:x.subjectId,deviceId:offer.deviceId,epoch:fresh.epoch,chainHead:fresh.chainHead,connected:true});
  assert.equal(done.state,'completed');assert.equal(done.deviceAuthorizationVerified,true);
  assert.equal(x.calls.filter(call=>call.path.endsWith('/commit')&&call.operationId===offer.operationId).length,1);
  const back=await x.call('galaxy_return',{navigationId:bridge.info.navigationId});
  assert.deepEqual(back.origin,x.origin);assert.equal(back.object.id,x.task.taskId);assert.equal(back.data.request.summary,x.task.summary);
  assert.equal((await x.f.db.query('SELECT count(*)::int n FROM subjects')).rows[0].n,subjectsBefore);
  assert.equal((await x.f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,1);
  await x.revoke(x.original,oldOffer.deviceId);
  const revoked=await x.prepare({scopes,continueWith});
  const revokedReady=await revoked.post('/message',revoked.envelope('ready',{nonce:randomUUID(),existingDevice:descriptor}));
  assert.equal(revokedReady.value.error,'web_identity_existing_device_control_required');
  console.log(JSON.stringify({actualSameGuidScopeAddition:true,actualUserNativeApproval:true,noImplicitScopeUpgrade:true,unknownAckOriginalOperation:true,
   actualOldKeyMaterialRetained:true,actualOriginalTaskReturn:true,exactCapsuleVersionSigned:true,wrongKeyAndRevokedExistingDeviceRefused:true,
   nullAndScopeChangeCannotBypassUnknownOperation:true,privateWorkRefOnlyOriginalNavigation:true,explicitLocalDeviceSelection:true,
   browserPopupNotExercised:true,actualCapsuleBodyNotLoaded:true,physicalHostAcceptance:false,modelCalls:0}));
 }finally{await x.cleanup();}
});
