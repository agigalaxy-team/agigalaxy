import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client,InMemoryTransport} from '../../integrations/native-v2/compact-app/node_modules/@modelcontextprotocol/client/dist/index.mjs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const source=process.env.GALAXY_NATIVE_TEST_SOURCE,candidate=process.env.GALAXY_NATIVE_TEST_CANDIDATE;
assert.ok(source&&candidate,'Fixed source and built artifact required');
const {createNativeToolServer}=await import(pathToFileURL(join(candidate,'server.js')).href);
const {serviceFixture}=await import(pathToFileURL(join(source,"packages/galaxy-official/test/service-fixture.mjs")).href);
const {createApi}=await import(pathToFileURL(join(source,"packages/galaxy-official/src/http.mjs")).href);
const {browserScopes}=await import(pathToFileURL(join(source,"packages/galaxy-official/src/browser-client.mjs")).href);
const {digest}=await import(pathToFileURL(join(source,"packages/galaxy-official/src/shared/digest.mjs")).href);
const {createWebRuntime}=await import(pathToFileURL(join(source,"packages/galaxy-web/src/runtime.mjs")).href);
const {createRecoveryMaterial}=await import(pathToFileURL(join(source,"packages/galaxy-core/src/domain/identity-material.mjs")).href);

const names=['galaxy_task_v2_owner_read_prepare','galaxy_task_v2_owner_read',
 'galaxy_task_v2_owner_control_prepare','galaxy_task_v2_owner_control'];
const content=result=>result.content[0].text;
// Actual local HTTP, MCP SDK transport, device recovery, JWS and PGlite facts.
// Local device storage is a Map contract fixture, not a physical browser/IDB.
// serviceFixture explicitly isolates unrelated public Account quota checks.
async function fixture(){
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000}),runtimes=[],hosts=[];
 const close=async()=>{await Promise.all(hosts.map(async h=>{await h.sdk.close();await h.server.close();}));runtimes.forEach(r=>r.close());
  for(const server of [api])if(server.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}await f.db.close();};
 try{
  for(const server of [api])await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${api.address().port}`;
  async function device(){
   const values=new Map(),get=async k=>structuredClone(values.get(k)),put=async(k,v)=>values.set(k,structuredClone(v));let credential;
   const store={get,put,async update(key,fn){const next=fn(structuredClone(values.get(key)));if(next&&typeof next.then==='function'){if(next instanceof Promise)void next.catch(()=>{});throw Error('local_update_async_callback');}const committed=structuredClone(next);values.set(key,committed);return structuredClone(committed);},async prepareRecovery(subjectId,operationId){const key=`pending-recovery:${subjectId}:${operationId}`;
    let v=await get(key);if(!v){v={...await createRecoveryMaterial(subjectId),operationId};await put(key,v);}return v;},
    async declareSaved(subjectId,id){const key=`pending-recovery:${subjectId}:${id}`;await put(key,{...await get(key),saveDeclared:true});},
    async recordReceipt(subjectId,id,receipt){const key=`pending-recovery:${subjectId}:${id}`;await put(key,{...await get(key),receipt});}};
   const runtime=await createWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{store,now:()=>f.now,
    fetch:(url,options)=>{const authorization=new Headers(options?.headers).get('authorization');if(authorization)credential=authorization.replace(/^Bearer /,'');
     return fetch(origin+new URL(url).pathname,options);}});runtimes.push(runtime);
   await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});
   const recovery=await runtime.prepareRecovery();await runtime.saveRecovery({operationId:recovery.operationId,confirmed:true});
   return{runtime,get credential(){return credential;},subjectId:runtime.api.snapshot().subjectId,
    recover:async()=>{const prior=runtime.api.snapshot();const recovered=await runtime.recover(recovery.code,{confirmed:true});
     await runtime.confirmRecoveredCode({operationId:recovered.operationId,confirmed:true});await runtime.connect({confirmed:true});
     assert.equal(runtime.api.snapshot().subjectId,prior.subjectId);assert.notEqual(runtime.api.snapshot().control.deviceId,prior.control.deviceId);}};
  }
  const host=async who=>{await who.runtime.api.call('/v2/tasks/query',{view:'requested'});
   const credential=who.credential,connection=structuredClone(who.runtime.api.snapshot()),journal=new Map();
   const transportRuntime={website:'https://synthetic.example',now:()=>f.now,
    store:{get:async key=>journal.get(key),put:async(key,value)=>journal.set(key,value)},
    status:async()=>({identity:who.subjectId}),helpFlow:{start:async()=>{throw new Error('Unexpected Help write');}},navigation:{},
    api:{endpoint:f.access.endpoint,snapshot:()=>connection,call:async(path,input,options={})=>{
     const response=await fetch(origin+path,{method:options.method??'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential},
      ...(options.method==='GET'?{}:{body:JSON.stringify(input)})});const result=await response.json();
     if(!response.ok)throw Object.assign(new Error(result.error),{code:result.error,status:response.status});return result;
    }}};
   const server=createNativeToolServer(transportRuntime),sdk=new Client({name:'fixed-native-owner-review',version:'0.1.3'});
   const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await server.connect(serverTransport);await sdk.connect(clientTransport);
   let lost=false,writes=0;
   const raw=(name,args)=>sdk.callTool({name,arguments:args});
   const call=async(name,args)=>{const result=await raw(name,args);if(result.isError){const code=result.structuredContent?.error??content(result);throw Object.assign(new Error(code),{code});}
    if(name==='galaxy_task_v2_owner_control'){writes++;if(lost){lost=false;throw new Error('synthetic MCP response lost after actual commit');}}
    assert.ok(result.structuredContent);return result.structuredContent;};
   const value={sdk,server,raw,call,lose:()=>{lost=true;},writes:()=>writes};hosts.push(value);return value;};
  const sign=async(who,payloadJson,action,objectId,options={})=>{
   const prepared=await who.runtime.api.prepareAuthorization(payloadJson,{action,objectId,visibility:'Private',viewers:[],expiresAt:f.now+7200,confirmed:true,...options});
   return who.runtime.api.submitAuthorization(prepared,{confirmed:true,reconcile:true});};
  const publish=async(who,host,viewers=[])=>{const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',
   title:'Synthetic original MCP work',summary:'Private original source must remain exact',workContext:{goal:'Continue original work',currentSituation:'Device recovery',attemptRefs:[]},
   visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+10000};
   const request=await sign(who,JSON.stringify(task),'assistance.publish',task.operationId,{viewers});
   const created=await host.call('galaxy_task_v2_create',request);assert.equal(created.taskId,task.taskId);return{...task,request};};
  const rows=taskId=>f.db.query('SELECT id,kind,version,consent_id,payload_text,payload_hash FROM task_events WHERE task_id=$1 ORDER BY version',[taskId]);
  return{f,device,host,sign,publish,rows,close};
 }catch(error){await close();throw error;}
}
const readPreview=(host,task,eventIds)=>host.call(names[0],{taskId:task.taskId,operationId:randomUUID(),...(eventIds?{eventIds}:{})});
const permit=(h,who,p)=>h.sign(who,p.payloadJson,'task.owner-read',JSON.parse(p.payloadJson).operationId,{expiresAt:p.expiresAt});
const controlPreview=(host,task,kind='cancel',operationId=randomUUID())=>host.call(names[2],{taskId:task.taskId,operationId,kind,reason:'Explicit synthetic owner decision'});
const controlPermit=(h,who,p,options={})=>h.sign(who,p.payloadJson,'assistance.publish',p.operationId,{expiresAt:p.expiresAt,...options});

test('fixed native artifact MCP returns precise partial authored facts after recovery and separately cancels once with original receipt recovery',async()=>{
 const h=await fixture();try{
  const owner=await h.device(),peer=await h.device(),old=await h.host(owner),other=await h.host(peer),task=await h.publish(owner,old,[peer.subjectId]);
  const invite={taskId:task.taskId,event:{kind:'invite',eventId:randomUUID(),expectedTaskVersion:1,recipientId:peer.subjectId,note:'Synthetic distinct invitation',expiresAt:h.f.now+600}};
  await old.call('galaxy_task_v2_event',{taskId:task.taskId,...await h.sign(owner,JSON.stringify(invite),'assistance.publish',invite.event.eventId,{viewers:[peer.subjectId]})});
  const reply={taskId:task.taskId,event:{kind:'invitation-reply',eventId:randomUUID(),expectedTaskVersion:2,invitationId:invite.event.eventId,
   response:'interested',message:'Private counterparty message must not be returned by owner recovery'}};
  await other.call('galaxy_task_v2_event',{taskId:task.taskId,...await h.sign(peer,JSON.stringify(reply),'assistance.publish',reply.event.eventId,{viewers:[owner.subjectId]})});
  const original=(await h.rows(task.taskId)).rows;await owner.recover();const host=await h.host(owner);
  const listed=(await host.sdk.listTools()).tools.filter(t=>names.includes(t.name));assert.deepEqual(listed.map(t=>t.name).sort(),[...names].sort());
  for(const tool of listed)assert.equal(tool.annotations.readOnlyHint,tool.name!==names[3]);
  await assert.rejects(host.call('galaxy_task_v2_get',{taskId:task.taskId}),/consent_required/);
  const p=await readPreview(host,task,[invite.event.eventId]);assert.equal(p.latestTaskVersion,3);assert.equal(p.payloadHash,digest(p.payloadJson));
  assert.deepEqual(p.events.map(e=>e.eventId),[task.operationId,invite.event.eventId]);assert.equal(JSON.stringify(p).includes(task.summary),false);
  const unapproved=await host.raw(names[1],{taskId:task.taskId,consentId:randomUUID(),payloadJson:p.payloadJson,confirmed:true});assert.equal(unapproved.isError,true);
  const signed=await permit(h,owner,p),partial=await host.call(names[1],{taskId:task.taskId,...signed});
  assert.deepEqual(partial.events.map(e=>e.payloadJson),[task.request.payloadJson,original[1].payload_text]);
  assert.equal(JSON.stringify(partial).includes(reply.event.message),false);
  for(const key of ['completeTaskSnapshot','taskWriteGranted','contextAccessGranted','referenceAccessGranted'])assert.equal(partial[key],false);
  const pControl=await controlPreview(host,task),wrong=await host.raw(names[3],{taskId:task.taskId,...signed});assert.equal(wrong.isError,true);
  const request=await controlPermit(h,owner,pControl),beforeConsent=Number((await h.f.db.query('SELECT count(*) FROM consents')).rows[0].count);
  host.lose();await assert.rejects(host.call(names[3],{taskId:task.taskId,...request}),/response lost/);
  assert.deepEqual((await h.rows(task.taskId)).rows.slice(0,3),original);assert.equal((await h.rows(task.taskId)).rows.length,4);
  await owner.runtime.connect({confirmed:true});const refreshed=await h.host(owner),ref={taskId:task.taskId,eventId:pControl.operationId,payloadHash:pControl.payloadHash};
  const ack=await refreshed.call('galaxy_task_v2_receipt',ref);assert.equal(ack.state,'acknowledged');assert.equal(ack.version,4);
  assert.equal(ack.authority,'accepted-event-only; not-current-authorization');assert.equal(JSON.stringify(ack).includes(task.summary),false);
  assert.equal((await refreshed.call('galaxy_task_v2_receipt',{...ref,payloadHash:'0'.repeat(64)})).state,'conflict');
  assert.equal(Number((await h.f.db.query('SELECT count(*) FROM consents')).rows[0].count),beforeConsent);assert.equal(refreshed.writes(),0);
  assert.equal(Number((await h.f.db.query("SELECT count(*) FROM task_events WHERE task_id=$1 AND kind='cancel'",[task.taskId])).rows[0].count),1);
  await assert.rejects(refreshed.call('galaxy_task_v2_get',{taskId:task.taskId}),/consent_required/);
  const foreign=await other.raw(names[0],{taskId:task.taskId,operationId:randomUUID()});assert.equal(foreign.isError,true);
  const receiptHttp=await owner.runtime.api.call('/v2/tasks/receipt',ref);assert.deepEqual(receiptHttp,ack);
 }finally{await h.close();}
});

test('fixed native artifact MCP refuses a stale binding, a read permit, or revoked source without minting authorization or rewriting original facts',async()=>{
 const h=await fixture();try{
  const owner=await h.device(),peer=await h.device(),old=await h.host(owner),task=await h.publish(owner,old);const original=(await h.rows(task.taskId)).rows;
  await owner.recover();let host=await h.host(owner);const p=await controlPreview(host,task,'close'),signed=await controlPermit(h,owner,p);
  const unsigned=await host.raw(names[3],{taskId:task.taskId,payloadJson:p.payloadJson,confirmed:true});assert.equal(unsigned.isError,true);
  const spoof=await host.raw(names[2],{taskId:task.taskId,operationId:randomUUID(),kind:'close',reason:'Synthetic',bindingId:randomUUID()});assert.equal(spoof.isError,true);
  await owner.runtime.connect({confirmed:true});host=await h.host(owner);
  assert.equal((await host.raw(names[3],{taskId:task.taskId,...signed})).isError,true);assert.deepEqual((await h.rows(task.taskId)).rows,original);
  const ref={taskId:task.taskId,eventId:p.operationId,payloadHash:p.payloadHash};assert.equal((await host.call('galaxy_task_v2_receipt',ref)).state,'absent');
  const refreshed=await controlPreview(host,task,'close',p.operationId);assert.equal(refreshed.payloadJson,p.payloadJson);assert.equal(refreshed.payloadHash,p.payloadHash);
  const readP=await readPreview(host,task),readSigned=await permit(h,owner,readP);
  const audience=await h.sign(owner,readP.payloadJson,'task.owner-read',JSON.parse(readP.payloadJson).operationId,{expiresAt:readP.expiresAt,viewers:[peer.subjectId]});
  assert.equal((await host.raw(names[1],{taskId:task.taskId,...audience})).isError,true);
  assert.equal((await host.raw(names[3],{taskId:task.taskId,...readSigned})).isError,true);
  const exact=await controlPermit(h,owner,refreshed),result=await host.call(names[3],{taskId:task.taskId,...exact});
  assert.equal(result.state,'closed');assert.equal(result.currentAccessGranted,false);assert.equal(result.completeTaskAccessGranted,false);assert.equal(result.settlementExecuted,false);
  await owner.runtime.api.call(`/v1/consents/${task.request.consentId}/revoke`,{});
  for(const [name,input] of [[names[0],{taskId:task.taskId,operationId:randomUUID()}],[names[1],{taskId:task.taskId,...readSigned}],
   [names[2],{taskId:task.taskId,operationId:randomUUID(),kind:'cancel',reason:'Cannot revive withdrawn source'}],[names[3],{taskId:task.taskId,...exact}]]){
   const denied=await host.raw(name,input);assert.equal(denied.isError,true);assert.equal(content(denied).includes(task.summary),false);
  }
  assert.equal((await host.call('galaxy_task_v2_receipt',ref)).state,'acknowledged');assert.deepEqual((await h.rows(task.taskId)).rows.slice(0,1),original);
  assert.equal((await h.rows(task.taskId)).rows.length,2);
 }finally{await h.close();}
});
