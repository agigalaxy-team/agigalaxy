import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createNativeRuntime} from '../../galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {nativeHttpDefinitions} from '../../galaxy-edge-mcp/src/native-v2/http-tools.mjs';
import {createNativeToolServer} from '../../galaxy-edge-mcp/src/native-v2/server.mjs';
import {createNativeWatch} from '../../galaxy-edge-mcp/src/native-v2/watch.mjs';
import {createNativeStore} from '../../galaxy-edge-mcp/src/native-v2/store.mjs';
import {verifyContextV2} from './context-v2-workflow.mjs';
import {createNativeNavigation,navigationSchema} from '../../galaxy-edge-mcp/src/native-v2/navigation.mjs';
import {InMemoryTransport,CLIENT_CAPABILITIES_META_KEY,CLIENT_INFO_META_KEY,PROTOCOL_VERSION_META_KEY} from '@modelcontextprotocol/server';

async function verifyRequestCapabilities(server){
 /** @type {Array<import('@modelcontextprotocol/server').ServerContext['mcpReq']['envelope']>} */
 const seen=[];
 server.registerTool('synthetic_capability_probe',{inputSchema:{},annotations:{readOnlyHint:true}},(_args,/** @type {import('@modelcontextprotocol/server').ServerContext} */ctx)=>{
  seen.push(ctx.mcpReq.envelope);return{content:[]};
 });
 assert.equal(server.server.transport,undefined,'the fresh server has no host connection');
 const[a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await b.start();
  const first={ [PROTOCOL_VERSION_META_KEY]:'2026-07-28',[CLIENT_INFO_META_KEY]:{name:'synthetic-capability-client',version:'1'},
   [CLIENT_CAPABILITIES_META_KEY]:{experimental:{'synthetic-only':{}}} };
  const empty={ [PROTOCOL_VERSION_META_KEY]:'2026-07-28',[CLIENT_CAPABILITIES_META_KEY]:{} };
  for(const request of [{id:1,meta:undefined},{id:2,meta:first},{id:3,meta:empty},{id:4,meta:undefined}]){
   /** @type {Promise<import('@modelcontextprotocol/server').JSONRPCMessage>} */
   const response=new Promise(resolve=>{b.onmessage=resolve;});
   await b.send({jsonrpc:'2.0',id:request.id,method:'tools/call',params:{name:'synthetic_capability_probe',arguments:{},...(request.meta?{_meta:request.meta}:{})}});
   const received=await response;assert.ok('result' in received,JSON.stringify(received));
   assert.equal(seen.length,request.id,'each request reaches the actual SDK handler exactly once');
   assert.deepEqual(seen.at(-1),request.meta,'only this request supplies client capabilities; omitted envelopes do not inherit earlier capabilities');
  }
 }finally{await server.close();await b.close();}
}

test('native canonical Context routes grant one recipient, accept exact metadata and revoke through real HTTP',async()=>{
 await verifyContextV2({extraScopes:browserScopes.filter(x=>!['binding','consent','assistance','context'].includes(x)),afterWorkflow:async({f,p,clock,fresh,localEndpoint})=>{
  const calls=[];
  const client=who=>nativeHttpDefinitions({call:async(path,input,options={})=>{
   calls.push({path,input,method:options.method??'POST'});
   const response=await fetch(localEndpoint+path,{method:options.method??'POST',headers:{Authorization:'Bearer '+who.credential,'Content-Type':'application/json'},
    ...(input===undefined?{}:{body:JSON.stringify(input)})});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
  }});
  const owner=client(f),recipient=client(p),invoke=(tools,name,input)=>tools[name].run(tools[name].inputSchema.parse(input));
  const grant={...fresh,id:randomUUID(),expiresAt:clock.now+200};
  await invoke(owner,'galaxy_context_v2_grant',await f.authorize(grant,'context.grant',{viewers:[grant.participantId]}));
  const pending=await invoke(recipient,'galaxy_context_v2_get',{grantId:grant.id,metadataOnly:true});
  assert.equal(pending.materials[0].content,undefined);
  const accept={schemaVersion:2,id:randomUUID(),grantId:grant.id,taskId:grant.taskId,participationId:grant.participationId,
   scopeVersion:grant.scopeVersion,materialsHash:pending.metadata.materialsHash,kind:'accept'};
  await invoke(recipient,'galaxy_context_v2_event',{grantId:grant.id,...await p.authorize(accept,'context.grant',{viewers:[f.actor.subjectId]})});
  assert.equal((await invoke(recipient,'galaxy_context_v2_get',{grantId:grant.id})).materials[0].content,grant.materials[0].content);
  const revoke={...accept,id:randomUUID(),kind:'revoke'};
  await invoke(owner,'galaxy_context_v2_event',{grantId:grant.id,...await f.authorize(revoke,'context.grant',{viewers:[p.actor.subjectId]})});
  assert.equal((await invoke(recipient,'galaxy_context_v2_get',{grantId:grant.id})).state,'revoked');
  assert.ok(calls.some(x=>x.path==='/v2/context/'+grant.id+'/metadata'&&x.method==='GET'));
  assert.ok(!calls.some(x=>x.path.startsWith('/v2/context/grants/')));
  await invoke(owner,'galaxy_search_v2_query',{type:'task',query:{view:'requested'}});
  await invoke(owner,'galaxy_choice_preferences',{});await invoke(owner,'galaxy_choice_list',{});
  await invoke(owner,'galaxy_comments_query',{taskId:grant.taskId});
  await invoke(owner,'galaxy_comment_governance_config',{});await invoke(owner,'galaxy_comment_governance_query',{});
  assert.equal((await invoke(owner,'galaxy_capsule_v2_receipt',{type:'publication',operationId:randomUUID(),payloadHash:'a'.repeat(64)})).state,'absent');
  await invoke(owner,'galaxy_capsule_v2_permissions',{});
 }});
});

test('Capsule browser navigation keeps exact selected version; new canonical bridge never substitutes another object',async()=>{
 const records=new Map(),opened=[],returned=[],id=randomUUID(),versionId=randomUUID();
 const navigation=createNativeNavigation({website:'https://galaxy.example',store:{put:async(k,v)=>records.set(k,v),get:async k=>records.get(k)},
  openBrowser:async url=>{opened.push(url);return{launched:true};},refresh:async object=>{returned.push(object);return{selectedVersion:object.versionId};}});
 const result=await navigation.open({object:{kind:'capsule',id,versionId}});
 assert.equal(opened[0],`https://galaxy.example/app/capsules/${id}/versions/${versionId}`);
 assert.equal((await navigation.resume(result.navigationId)).data.selectedVersion,versionId);assert.equal(returned[0].id,id);
 assert.equal(navigationSchema.safeParse({object:{kind:'task',id,versionId}}).success,false);
 const calls=[],tools=nativeHttpDefinitions({call:async(...args)=>{calls.push(args);return{};}}),run=(name,input)=>tools[name].run(tools[name].inputSchema.parse(input));
 await run('galaxy_capsule_v2_read',{capsuleId:id,versionId});await run('galaxy_capsule_v2_versions',{capsuleId:id});
 assert.deepEqual(calls[0],['/v2/capsules/read',{capsuleId:id,versionId}]);assert.equal(calls[1][0],'/v2/capsules/versions');
 const signed={consentId:randomUUID(),payloadJson:'{}'},reportId=randomUUID();
 await run('galaxy_comment_governance_event',{reportId,...signed});assert.deepEqual(calls.at(-1),['/v2/comment-governance/'+reportId+'/events',signed]);
 await run('galaxy_comment_get',{commentId:id});assert.deepEqual(calls.at(-1),['/v2/comments/'+id,undefined,{method:'GET'}]);
});

test('native current device survives restart; real HTTP Task and Consent retry preserve exact bytes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-native-v2-'));let runtime,second,third,api;const f=await serviceFixture([...browserScopes]);
 try{api=createApi({...f,rateLimit:1000});await new Promise(r=>api.listen(0,'127.0.0.1',r));const local='http://127.0.0.1:'+api.address().port;
  let requests=0,launchUrl;const fetcher=(url,options)=>{requests++;return fetch(local+new URL(url).pathname,options);};
  const config={dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://www.galaxy.example',trustedKeys:f.bindings.trustedKeys,fetch:fetcher,now:()=>f.now,openBrowser:async url=>{launchUrl=url;return{launched:true,state:'launch-requested'};}};
  runtime=await createNativeRuntime(config);assert.equal((await runtime.status()).connected,false);assert.equal(requests,0);
  await runtime.initialize({profile:'coding-case'},{confirmed:true});assert.equal(requests,0,'local initialization stays local');
  await runtime.connect({confirmed:true});const first=await runtime.status();assert.equal(first.connected,true);
  const server=createNativeToolServer(runtime),beforeCapabilities=requests;await verifyRequestCapabilities(server);
  assert.equal(requests,beforeCapabilities,'checking MCP capability context does not contact Official or a model');
  const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',workContext:{goal:'Synthetic native workflow',currentSituation:'No failure history',attemptRefs:[]},title:'Native Task',summary:'Synthetic private request',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+3600};
  const input={requestId:randomUUID(),payloadJson:JSON.stringify(task,null,2),action:'assistance.publish',objectId:task.operationId,visibility:'Private',viewers:[],expiresAt:f.now+3600};
  const authorized=await runtime.authorize(input,{confirmed:true});assert.equal(authorized.payloadJson,input.payloadJson,'signed bytes preserved');
  const definitions=nativeHttpDefinitions(runtime.api);const created=await definitions.galaxy_task_v2_create.run({consentId:authorized.consentId,payloadJson:authorized.payloadJson});assert.equal(created.taskId,task.taskId);
  const nav=await runtime.navigation.open({object:{kind:'task',id:task.taskId},origin:{host:'synthetic-native',workRef:'private-local-only-ref'}});
  assert.equal(launchUrl,'https://www.galaxy.example/app/tasks/'+task.taskId);assert.equal(nav.opened,'unverified');assert.ok(!launchUrl.includes('private-local'));
  for(const[kind,path]of Object.entries({match:'match',publish:'publish',participate:'participate',search:'search',capsules:'capsules',privacy:'settings/privacy',identity:'settings/identity'})){
   const entry=await runtime.navigation.open({object:{kind}});assert.equal(entry.targetPath,'/app/'+path);assert.equal(launchUrl,'https://www.galaxy.example/app/'+path);}
  const projectId=randomUUID(),projectLink=await runtime.navigation.open({object:{kind:'project',id:projectId}});assert.equal(projectLink.targetPath,'/app/projects/'+projectId);assert.equal(launchUrl,'https://www.galaxy.example/app/projects/'+projectId);assert.equal(projectLink.opened,'unverified');
  const resumed=await runtime.navigation.resume(nav.navigationId);assert.equal(resumed.data.taskId,task.taskId);assert.equal(resumed.origin.workRef,'private-local-only-ref');
  runtime.close();second=await createNativeRuntime(config);const reread=await nativeHttpDefinitions(second.api).galaxy_task_v2_get.run({taskId:task.taskId});assert.equal(reread.taskId,task.taskId);
  assert.equal((await second.status()).identity,first.identity);assert.notEqual((await second.status()).connection.bindingId,first.connection.bindingId);
  const retry=await second.authorize(input);assert.equal(retry.consentId,authorized.consentId);assert.equal(retry.payloadJson,input.payloadJson);
  third=await createNativeRuntime({...config,dataDirectory:join(directory,'new-device')});
  const offer=await third.device.offer(first.identity,{confirmed:true});assert.ok(!JSON.stringify(offer).includes('PRIVATE KEY'));
  const approval=await second.device.approve(offer,{confirmed:true});const adopted=await third.device.accept(approval,{confirmed:true});assert.equal(adopted.receipt.state,'committed');assert.equal(adopted.activated,true);
  await third.connect({confirmed:true});assert.equal((await third.status()).identity,first.identity);assert.notEqual((await third.status()).connection.control.deviceId,(await second.status()).connection.control.deviceId);
  assert.equal((await third.api.call('/v2/tasks/'+task.taskId,undefined,{method:'GET'})).taskId,task.taskId);
  const adoptedSetup=await third.initialize({profile:'minimal'},{confirmed:true});assert.equal(adoptedSetup.identity,first.identity);assert.equal(adoptedSetup.existingIdentityPreserved,true);
  assert.equal((await third.command('open',{})).identity,first.identity);
  const help=await third.helpFlow.start({localTaskRef:'original-native-work',taskId:task.taskId});assert.equal(help.subjectId,first.identity);assert.equal(help.paths.length,4);
  assert.equal((await third.helpFlow.refresh(help.id)).remote.taskId,task.taskId);
  const returned=await third.helpFlow.returnToTask(help.id,{expectedRevision:help.revision});assert.equal(returned.handoff.localTaskRef,'original-native-work');assert.equal(returned.successFactsCreated,false);
  const records=await readdir(join(directory,'native-v2','records'));for(const name of records){const text=await readFile(join(directory,'native-v2','records',name),'utf8');assert.ok(!text.includes('PRIVATE KEY'));assert.ok(!text.includes('"credential":'));}
  const beforeEvidence=requests;
  assert.throws(()=>definitions.galaxy_evidence_v2_submit.run({consentId:randomUUID(),payloadJson:JSON.stringify({kind:'revoke',id:randomUUID(),operationId:randomUUID(),expectedVersion:1,
   caseId:randomUUID(),reportedBy:first.identity,synthetic:true,objectType:'evidence',reason:'Synthetic wrong-kind test'})}),/invalid_evidence_event/);assert.equal(requests,beforeEvidence);
  await second.disconnect();const before=requests;await assert.rejects(second.api.call('/v2/tasks/query',{}),/native_connection_choice_required/);assert.equal(requests,before);
 }finally{runtime?.close();second?.close();third?.close();if(api)await new Promise(r=>api.close(r));await f.db.close();await rm(directory,{recursive:true,force:true});}
});

test('host-driven watch is leased, rechecks source, skips self echo and never calls a model',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-native-watch-'));try{
  const subjectId='GUID'+'1'.repeat(28),roomId=randomUUID(),bindingId=randomUUID();let grantId=randomUUID(),revoked=false,now=2000000000,calls=0,bodyAvailable=true,pendingResolve=null,currentBinding=bindingId;
  const other='GUID'+'2'.repeat(28);const api={endpoint:'https://official.example.org',snapshot:()=>({bindingId:currentBinding}),call:async(path,input)=>{
   calls++;if(path.endsWith('/agent-grants'))return{items:[{grantId,state:revoked?'revoked':'active',bindingId,expiresAt:2000100000}]};
   if(path.endsWith('/agent-revoke')){assert.equal(input.grantId,grantId);revoked=true;return{revoked:true,hostRuntimeStopped:false};}
   if(path.endsWith('/cursor'))return{kind:'agent',sequence:input.sequence};
   if(pendingResolve)await pendingResolve;
   return{messages:input.after==='0'&&bodyAvailable?[{messageId:randomUUID(),sequence:'1',subjectId,actorKind:'agent',agentGrantId:grantId,state:'accepted',text:'self echo'},
    {messageId:randomUUID(),sequence:'2',subjectId:other,actorKind:'human',agentGrantId:null,state:'accepted',text:'New question'}]:[],scannedThrough:'2',complete:true,next:null};}};
  const store=createNativeStore(directory),a=createNativeWatch({store,api,subjectId,now:()=>now}),b=createNativeWatch({store:createNativeStore(directory),api,subjectId,now:()=>now});
  const started=await a.start({roomId,agentGrantId:grantId,purpose:'Explain new replies',expiresAt:now+86400},{confirmed:true}),id=started.items[0].id;
  const work=await a.check(id);assert.equal(work.modelCalls,0);assert.equal(work.work.items.length,1);assert.equal(work.work.items[0].text,'New question');
  const persisted=JSON.stringify(await store.get('native-watch:'+api.endpoint+':'+subjectId));assert.ok(!persisted.includes('New question'));
  bodyAvailable=false;const filtered=await b.check(id);assert.equal(filtered.state,'unchanged','pending work does not replay revoked source text');
  now+=900;let release;pendingResolve=new Promise(r=>release=r);const checking=a.check(id);await new Promise(r=>setTimeout(r,30));
  assert.equal((await b.check(id)).state,'leased-elsewhere');assert.equal((await a.check(id)).state,'already-checking');await a.stop(id);release();assert.equal((await checking).state,'stopped-during-check');
  const prior=calls;assert.equal((await a.check(id)).state,'inactive');assert.equal(calls,prior,'stop prevents new Galaxy calls');
  grantId=randomUUID();revoked=false;
  const resumed=await a.start({roomId,agentGrantId:grantId,purpose:'Selected new bounded watch',expiresAt:now+3600},{confirmed:true});
  currentBinding=randomUUID();
  await assert.rejects(a.start({roomId,agentGrantId:grantId,purpose:'Wrong binding',expiresAt:now+3600},{confirmed:true}),/watch_current_binding_grant_required/);
  assert.equal((await a.check(resumed.items[0].id)).state,'binding-changed');
  await assert.rejects(a.start({roomId,agentGrantId:grantId,purpose:'Revoked original grant',expiresAt:now+3600},{confirmed:true}),/active_room_agent_grant_required/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
