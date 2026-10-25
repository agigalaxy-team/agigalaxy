import {nativeData} from '../../packages/galaxy-edge-mcp/test/native-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/server';
import {serviceFixture} from '../../packages/galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createNativeChoice} from '../../packages/galaxy-edge-mcp/src/native-v2/interaction/choice.mjs';
import {registerNativeDeviceManagementTools} from './device-management-tools.mjs';

const require=createRequire(new URL('../../packages/galaxy-official/package.json',import.meta.url));
const {Client,StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const {NodeStreamableHTTPServerTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/node')).href);
const names={read:'galaxy_identity_device_native_read',prepare:'galaxy_identity_device_native_prepare_revoke',
 confirm:'galaxy_identity_device_native_confirm',stop:'galaxy_identity_device_native_stop_retry'};

async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'galaxy-native-device-tools-'));
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
 f.identityControl.now=()=>f.now;
 const api=createApi({...f,rateLimit:1000});await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+api.address().port,commits=[],paths=[],statusRequests=[],runtimes=[],bridges=[];
 let lostAck=false,neverDispatched=false,statusOffline=false,reviewHook=null;
 const wire=async(url,options={})=>{
  const u=new URL(url);assert.equal(u.origin,f.access.endpoint);
  if(options.body)assert.ok(!/PRIVATE KEY|galaxy-recovery-v1:/.test(options.body));
  if(u.pathname.endsWith('/status')&&statusOffline)throw Error('Synthetic status offline');
  if(u.pathname==='/v2/identity/control/status')statusRequests.push(JSON.parse(options.body));
  if(u.pathname.endsWith('/commit')&&neverDispatched){neverDispatched=false;throw Error('Synthetic commit not dispatched');}
  const response=await fetch(origin+u.pathname+u.search,options);paths.push(u.pathname);
  if(u.pathname.endsWith('/commit')){commits.push({operationId:JSON.parse(options.body).operationId,status:response.status});
   if(lostAck){lostAck=false;assert.equal(response.status,200);throw Error('Synthetic actual committed ACK lost');}}
  return response;
 };
 const config={endpoint:f.access.endpoint,website:'https://synthetic-device-choice.example',trustedKeys:f.access.trustedKeys,now:()=>f.now,fetch:wire};
 const native=async(name,initialize=false)=>{const runtime=await createNativeRuntime({...config,dataDirectory:join(directory,name)});runtimes.push(runtime);
  if(initialize){await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});}return runtime;};
 const old=await native('old',true),subjectId=(await old.status()).identity,oldDeviceId=old.api.snapshot().control.deviceId;
 const newer=await native('new'),offer=await newer.device.offer(subjectId,{confirmed:true});
 await newer.device.accept(await old.device.approve(offer,{confirmed:true}),{confirmed:true});await newer.connect({confirmed:true});
 async function attach(runtime){
  const choice=createNativeChoice({identity:()=>runtime.api.snapshot()?.subjectId??subjectId,website:runtime.website,store:runtime.store});
  const server=new McpServer({name:'synthetic-device-management-tools',version:'1'},{requestState:{verify:choice.verify}});
  const tools=registerNativeDeviceManagementTools(server,{runtime,now:()=>f.now*1000,
   review:async(name,input,context,run)=>{await reviewHook?.(input);return choice.run(server,name,input,context,run);}});
  const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:true});
  const http=createServer((req,res)=>{void transport.handleRequest(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
  await server.connect(transport);await new Promise(r=>http.listen(0,'127.0.0.1',r));
  const sdk=new Client({name:'synthetic-device-owner',version:'1'});
  await sdk.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+http.address().port+'/mcp')));
  const raw=(name,args={})=>sdk.callTool({name,arguments:args});
  const call=async(name,args={})=>{const result=await raw(name,args),value=nativeData(result);assert.equal(result.isError??false,false,JSON.stringify(value));return value;};
  const choose=async(name,args,action='allow',inspect=()=>{})=>{
   const first=await call(name,args);assert.equal(first.state,'user-choice-needs-browser');
   const html=await(await fetch(first.url)).text();assert.ok(!html.includes('PRIVATE KEY'));assert.ok(!html.includes('galaxy-recovery-v1:'));await inspect(html,first);
   const response=await fetch(first.url,{method:'POST',headers:{Origin:new URL(first.url).origin,'Content-Type':'application/x-www-form-urlencoded'},body:'action='+action});
   assert.equal(response.status,200);return call(name,args);
  };
  let closed=false;const bridge={tools,sdk,raw,call,choose,async close(){if(closed)return;closed=true;choice.close();await tools.close();await sdk.close();await server.close();
   http.closeAllConnections();if(http.listening)await new Promise(r=>http.close(r));}};bridges.push(bridge);return bridge;
 }
 const bridge=await attach(newer);
 return{...bridge,f,old,newer,subjectId,oldDeviceId,newDeviceId:offer.deviceId,native,attach,commits,paths,statusRequests,
  setLostAck:value=>lostAck=value,setNeverDispatched:value=>neverDispatched=value,setStatusOffline:value=>statusOffline=value,setReviewHook:value=>reviewHook=value,
  async cleanup(){for(const b of bridges)await b.close();for(const r of runtimes)r.close();api.closeAllConnections();await new Promise(r=>api.close(r));await f.db.close();
   const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-native-device-tools-'));await rm(target,{recursive:true,force:true});}};
}

test('actual MCP and loopback user review revoke the exact old device; no model confirmation or declined preview can commit',{timeout:60000},async()=>{
 const x=await fixture();try{
  const listed=await x.sdk.listTools();assert.deepEqual(listed.tools.map(t=>t.name).sort(),Object.values(names).sort());
  assert.equal(listed.tools.find(t=>t.name===names.read).annotations.readOnlyHint,true);
  const current=await x.call(names.read,{action:'list'});assert.equal(current.canManage,true);assert.equal(current.devices.length,2);
  const p=await x.call(names.prepare,{deviceId:x.oldDeviceId}),before=x.commits.length;
  assert.equal(p.signed,false);assert.equal(p.challengeRegistered,true);assert.equal(p.controlCommitted,false);assert.equal(p.preview.target.deviceId,x.oldDeviceId);
  assert.equal((await x.raw(names.confirm,{previewId:p.previewId,confirmed:true})).isError,true);assert.equal(x.commits.length,before);
  assert.equal((await x.choose(names.confirm,{previewId:p.previewId},'decline')).state,'declined');assert.equal(x.commits.length,before);
  const pending=await x.call(names.read,{action:'pending'});assert.equal(pending.active.operationId,p.operationId);
  const rereview=await x.call(names.prepare,{deviceId:x.oldDeviceId});assert.equal(rereview.operationId,p.operationId);assert.notEqual(rereview.previewId,p.previewId);
  const result=await x.choose(names.confirm,{previewId:rereview.previewId},'allow',async(html,first)=>{
   assert.equal(html.includes('<pre>'),false);assert.ok(html.includes(x.oldDeviceId));assert.ok(html.includes('保留历史证明'));
   const diagnostic=JSON.stringify(await(await fetch(first.url+'?download=1')).json());
   for(const text of [x.oldDeviceId,x.newDeviceId,p.preview.requestHash,p.preview.challengeHash,'historicalProofs','not-consumed'])assert.ok(diagnostic.includes(text));
  });
  assert.equal(result.receipt.state,'committed');assert.equal(result.currentAccessGranted,false);assert.equal(x.commits.length,before+1);
  assert.equal((await x.raw(names.confirm,{previewId:p.previewId})).isError,true);assert.equal(x.commits.length,before+1);
  const receipt=await x.call(names.read,{action:'reconcile',operationId:p.operationId});assert.equal(receipt.recordedLocalReceipt,true);assert.equal(receipt.state,'committed');
  await assert.rejects(x.old.api.call('/v2/consents/receipt',{consentId:randomUUID()}),/access_denied/);
  await assert.rejects(x.old.connect({confirmed:true}),/current_device_control_required/);
 }finally{await x.cleanup();}
});

test('actual same-GUID reconnect and late user approval invalidate the original opaque preview; close also withholds it',{timeout:60000},async()=>{
 const x=await fixture();try{
  const p=await x.call(names.prepare,{deviceId:x.oldDeviceId}),before=x.commits.length;
  await x.newer.connect({confirmed:true});assert.equal((await x.raw(names.confirm,{previewId:p.previewId})).isError,true);assert.equal(x.commits.length,before);
  const fresh=await x.call(names.prepare,{deviceId:x.oldDeviceId});assert.equal(fresh.operationId,p.operationId);
  const needs=await x.call(names.confirm,{previewId:fresh.previewId});assert.equal(needs.state,'user-choice-needs-browser');
  await fetch(needs.url,{method:'POST',headers:{Origin:new URL(needs.url).origin,'Content-Type':'application/x-www-form-urlencoded'},body:'action=allow'});
  let entered,release;const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r);
  x.setReviewHook(async()=>{entered();await gate;});const waiting=x.raw(names.confirm,{previewId:fresh.previewId});await reached;
  await x.newer.connect({confirmed:true});release();const result=await waiting;assert.equal(result.isError,true);assert.equal(x.commits.length,before);x.setReviewHook(null);
  const newest=await x.call(names.prepare,{deviceId:x.oldDeviceId}),lastChoice=await x.call(names.confirm,{previewId:newest.previewId});
  assert.equal(lastChoice.state,'user-choice-needs-browser');await Promise.all([x.tools.close(),x.tools.close()]);
  await fetch(lastChoice.url,{method:'POST',headers:{Origin:new URL(lastChoice.url).origin,'Content-Type':'application/x-www-form-urlencoded'},body:'action=allow'});
  assert.equal((await x.raw(names.confirm,{previewId:newest.previewId})).isError,true);assert.equal(x.commits.length,before);
 }finally{await x.cleanup();}
});

test('actual committed lost ACK is recovered after NativeFS restart using the same original status; unknown handle never resends',{timeout:60000},async()=>{
 const x=await fixture();try{
  const p=await x.call(names.prepare,{deviceId:x.oldDeviceId}),before=x.commits.length;
  x.setLostAck(true);await assert.rejects(x.choose(names.confirm,{previewId:p.previewId}),/device_management_native_incomplete/);
  assert.equal(x.commits.length,before+1);assert.equal((await x.call(names.confirm,{previewId:p.previewId})).state,'original-operation-needs-reconciliation');
  assert.equal(x.commits.length,before+1);const saved=await x.newer.store.get('identity-operation:'+x.f.access.endpoint+':'+p.operationId);await x.close();x.newer.close();
  const restarted=await x.native('new');await restarted.connect({confirmed:true});const b=await x.attach(restarted);
  const pending=await b.call(names.read,{action:'pending'});assert.equal(pending.active.operationId,p.operationId);
  const receipt=await b.call(names.read,{action:'reconcile',operationId:p.operationId});assert.equal(receipt.receipt.state,'committed');assert.equal(receipt.currentAccessGranted,false);
  assert.equal(x.paths.at(-1),'/v2/identity/control/status');assert.deepEqual(x.statusRequests.at(-1),saved.commit);assert.equal(x.commits.length,before+1);
  assert.equal((await b.call(names.read,{action:'pending'})).active,null);
 }finally{await x.cleanup();}
});

test('stopping unknown requires actual review and keeps original proof; it never asserts cloud cancellation or repeats a commit',{timeout:60000},async()=>{
 const x=await fixture();try{
  const p=await x.call(names.prepare,{deviceId:x.oldDeviceId}),before=x.commits.length;
  x.setNeverDispatched(true);await assert.rejects(x.choose(names.confirm,{previewId:p.previewId}),/device_management_native_incomplete/);
  x.setStatusOffline(true);assert.equal((await x.raw(names.read,{action:'reconcile',operationId:p.operationId})).isError,true);
  assert.equal((await x.raw(names.stop,{operationId:p.operationId,confirmed:true})).isError,true);
  const declined=await x.choose(names.stop,{operationId:p.operationId},'decline');assert.equal(declined.state,'declined');
  assert.equal((await x.call(names.read,{action:'pending'})).active.localRetryStopped,false);
  // A declined exact choice remains declined. A newly explicit connection
  // review has another binding/generation and cannot reuse that cached choice.
  await x.newer.connect({confirmed:true});
  const stopped=await x.choose(names.stop,{operationId:p.operationId},'allow',async(html,first)=>{assert.ok(html.includes('这不会确认远端已取消'));const diagnostic=JSON.stringify(await(await fetch(first.url+'?download=1')).json());assert.ok(diagnostic.includes(p.operationId));assert.ok(diagnostic.includes('serverCancellationConfirmed'));assert.ok(diagnostic.includes('originalProofRetained'));});
  assert.equal(stopped.localRetryStopped,true);assert.equal(stopped.serverCancellationConfirmed,false);assert.equal(stopped.receipt,null);assert.equal(x.commits.length,before);
  assert.equal((await x.raw(names.prepare,{deviceId:x.oldDeviceId})).isError,true);
  x.setStatusOffline(false);const receipt=await x.call(names.read,{action:'reconcile',operationId:p.operationId});
  assert.equal(receipt.receipt.state,'requested');assert.equal(receipt.localRetryStopped,true);assert.equal(x.commits.length,before);
  const saved=await x.newer.store.get('identity-operation:'+x.f.access.endpoint+':'+p.operationId);assert.ok(saved.commit.controllerSignature);
 }finally{await x.cleanup();}
});

test('expired local previews and terminal operations reclaim capacity; close invalidates a pending review',{timeout:60000},async()=>{
 const x=await fixture();try{
  let p;for(let i=0;i<32;i++)p=await x.call(names.prepare,{deviceId:x.oldDeviceId});
  assert.equal((await x.raw(names.prepare,{deviceId:x.oldDeviceId})).isError,true);const before=x.commits.length;
  const result=await x.choose(names.confirm,{previewId:p.previewId});assert.equal(result.receipt.state,'committed');assert.equal(x.commits.length,before+1);
  const self=await x.call(names.prepare,{deviceId:x.newDeviceId}).catch(e=>e);assert.match(self.message,/identity_last_controller/,'capacity was reclaimed; real self-revoke rule is still enforced');
  assert.equal((await x.raw(names.confirm,{previewId:p.previewId})).isError,true);
 }finally{await x.cleanup();}
 // Preview TTL is tested with another independent real control authority; no
 // expired preview is permitted to consume a cached browser approval.
 const y=await fixture();try{
  const p=await y.call(names.prepare,{deviceId:y.oldDeviceId}),before=y.commits.length;
  const needs=await y.call(names.confirm,{previewId:p.previewId});assert.equal(needs.state,'user-choice-needs-browser');
  y.f.now+=181;assert.equal((await y.raw(names.confirm,{previewId:p.previewId})).isError,true);assert.equal(y.commits.length,before);
  await y.tools.close();assert.equal((await y.raw(names.read,{action:'pending'})).isError,true);assert.equal(y.commits.length,before);
 }finally{await y.cleanup();}
});

test('awaiting prepares reserve capacity, failed admission is released, and close withholds late previews',{timeout:10000},async()=>{
 // Deferred factory contracts isolate capacity/error cleanup. The independent
 // concurrency probe exercises the same limit through the actual MCP SDK.
 const endpoint='https://synthetic-capacity.example',subjectId='GUID'+'1'.repeat(28),deviceId=randomUUID(),bindingId=randomUUID();
 let generation=1;const handlers=new Map(),waiters=[];
 const runtime={api:{endpoint,snapshot:()=>({subjectId,bindingId,generation})},
  receiptStatus:{captureLease:()=>{const captured=generation;return {endpoint,subjectId,deviceId,bindingId,generation:captured,
   assertCurrent:()=>assert.equal(generation,captured)};}},
  deviceManagement:{prepareRevoke:()=>new Promise((resolve,reject)=>waiters.push({resolve,reject}))}};
 const tools=registerNativeDeviceManagementTools({registerTool:(name,_schema,fn)=>handlers.set(name,fn)},
  {runtime,now:()=>0,review:()=>assert.fail('capacity checks must not request user approval')});
 const call=()=>handlers.get(names.prepare)({deviceId:randomUUID()},{});
 const valid=()=>({endpoint,subjectId,initiatorDeviceId:deviceId,kind:'revoke-device',expiresAt:3600,operationId:randomUUID()});
 let pending=[];
 try{
  pending=Array.from({length:32},call);await Promise.resolve();await Promise.resolve();assert.equal(waiters.length,32);
  assert.match(JSON.stringify(await call()),/device_management_native_preview_capacity/);assert.equal(waiters.length,32);
  waiters[0].reject(Object.assign(Error('synthetic_prepare_failed'),{code:'synthetic_prepare_failed'}));
  assert.equal((await pending[0]).isError,true);
  const replacement=call();pending.push(replacement);await Promise.resolve();await Promise.resolve();assert.equal(waiters.length,33);
  for(const w of waiters.slice(1))w.resolve(valid());
  assert.equal((await Promise.all(pending.slice(1))).filter(v=>!v.isError).length,32);
  assert.match(JSON.stringify(await call()),/device_management_native_preview_capacity/);
  // A new lease prunes old handles. Invalid results must release their newly
  // reserved slots too, instead of filling the capacity with failed prepares.
  generation++;const invalid=Array.from({length:32},call);pending.push(...invalid);await Promise.resolve();await Promise.resolve();
  assert.equal(waiters.length,65);for(const w of waiters.slice(33))w.resolve({...valid(),kind:'invalid'});
  assert.ok((await Promise.all(invalid)).every(v=>v.isError));
  const late=call();pending.push(late);await Promise.resolve();await Promise.resolve();assert.equal(waiters.length,66);
  const closing=tools.close();assert.equal(tools.close(),closing);
  waiters.at(-1).resolve(valid());assert.match(JSON.stringify(await late),/device_management_native_closed/);
  await closing;assert.equal((await call()).isError,true);assert.equal(waiters.length,66);
 }finally{for(const w of waiters)w.resolve(valid());await Promise.allSettled(pending);await tools.close();}
});
