import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {McpServer} from '@modelcontextprotocol/server';
import {App} from '@modelcontextprotocol/ext-apps';
import {AppBridge} from '@modelcontextprotocol/ext-apps/app-bridge';
import {serviceFixture} from '../../../packages/galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createNativeNavigation} from '../../../packages/galaxy-edge-mcp/src/native-v2/navigation.mjs';
import {registerNativeCompactApps,loadCompactArtifact} from './server.mjs';
import {createCompactController} from './controller.mjs';

test('official App/AppBridge + real native HTTP preserve current Task, text fallback, source loss and local drafts',{timeout:60000},async()=>{
 const f=await serviceFixture(browserScopes),directory=await mkdtemp(join(tmpdir(),'galaxy-compact-app-'));let api,runtime,client,mcp,app,bridge,registration;
 try{api=createApi({...f,rateLimit:1000});await new Promise(r=>api.listen(0,'127.0.0.1',r));const local='http://127.0.0.1:'+api.address().port,opened=[];
  runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
   fetch:(url,options)=>fetch(local+new URL(url).pathname,options),openBrowser:async url=>{opened.push(url);return{launched:true,state:'launch-requested'};}});
  await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});
  const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',workContext:{goal:'Synthetic compact-view scope',currentSituation:'No failure required',attemptRefs:[]},title:'Synthetic exact Task',summary:'Visible current summary',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+3600};
  const auth=await runtime.authorize({requestId:randomUUID(),payloadJson:JSON.stringify(task),action:'assistance.publish',objectId:task.operationId,visibility:'Private',viewers:[],expiresAt:f.now+3600},{confirmed:true});
  await runtime.api.call('/v2/tasks',{consentId:auth.consentId,payloadJson:auth.payloadJson});
  const help=await runtime.helpFlow.start({localTaskRef:'private original prompt never in URL',taskId:task.taskId});
  mcp=new McpServer({name:'galaxy-compact-protocol-fixture',version:'1'});registration=registerNativeCompactApps(mcp,{runtime,artifact:await loadCompactArtifact()});
  client=new Client({name:'synthetic-no-ui-host',version:'1'},{capabilities:{}});const [a,b]=InMemoryTransport.createLinkedPair();await mcp.connect(a);await client.connect(b);
  const tools=await client.listTools();assert.equal(tools.tools.length,5);const uri=tools.tools.find(t=>t.name==='galaxy_panel')._meta.ui.resourceUri;
  const resource=await client.readResource({uri});assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app');assert.ok(!resource.contents[0].text.includes(task.summary));assert.ok(!resource.contents[0].text.includes('PRIVATE KEY'));
  const input={object:{kind:'task',id:task.taskId},helpSessionId:help.id,origin:{host:'synthetic-sdk',workRef:'original-local-work'}};
  const textResult=await client.callTool({name:'galaxy_panel',arguments:input});assert.equal(textResult.isError,undefined);const shown=textResult.structuredContent;
  assert.equal(shown.source.title,task.title);assert.equal(shown.paths.length,4);assert.equal(shown.activeEntries.length,3);assert.deepEqual(JSON.parse(textResult.content[0].text),shown);
  assert.equal(textResult._meta.galaxyUi.advertisedByHost,false);assert.ok(!JSON.stringify(shown).includes('credential'));assert.ok(!JSON.stringify(shown).includes('private original prompt'));
  bridge=new AppBridge(client,{name:'synthetic-official-app-bridge',version:'1'},{serverTools:{},updateModelContext:{text:{}},logging:{}});
  let teardown=false,received;app=new App({name:'synthetic-Galaxy-App',version:'1'},{},{autoResize:false});app.ontoolresult=x=>received=x;app.onteardown=async()=>{teardown=true;return{};};
  const [c,d]=InMemoryTransport.createLinkedPair();await bridge.connect(c);await app.connect(d);await bridge.sendToolInput({arguments:input});await bridge.sendToolResult(textResult);
  await new Promise(r=>setImmediate(r));assert.equal(received.structuredContent.source.source.id,task.taskId);
  const call=async(name,args={})=>app.callServerTool({name,arguments:{viewId:shown.viewId,...args}});
  const saved=await call('galaxy_panel_draft_save',{expectedRevision:0,draft:'本机未发送草稿'});assert.equal(saved.structuredContent.draft.revision,1);
  const conflict=await call('galaxy_panel_draft_save',{expectedRevision:0,draft:'冲突草稿'});assert.equal(conflict.structuredContent.error,'panel_draft_conflict');
  const exact=await call('galaxy_panel_open');assert.equal(exact.structuredContent.url,'https://selected.example/app/tasks/'+task.taskId);assert.ok(!exact.structuredContent.url.includes('original'));
  for(const entry of ['match','publish','participate'])assert.equal((await call('galaxy_panel_open',{entry})).structuredContent.targetPath,'/app/'+entry);
  assert.equal((await call('galaxy_panel_return',{navigationId:exact.structuredContent.navigationId})).structuredContent.source.source.id,task.taskId);
  const revoked=await runtime.api.call('/v1/consents/'+auth.consentId+'/revoke',{});assert.ok(revoked);
  const loss=(await call('galaxy_panel_refresh')).structuredContent;assert.equal(loss.source,null);assert.ok(loss.sourceError);assert.equal(loss.draft.text,'本机未发送草稿');
  await bridge.teardownResource({});assert.equal(teardown,true);assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,1);
  const reopened=(await client.callTool({name:'galaxy_panel',arguments:input})).structuredContent;assert.equal(reopened.draft.text,'本机未发送草稿');assert.equal(reopened.source,null);
  console.log(JSON.stringify({actualOfficialSdk:true,actualAppBridge:true,actualNativeHttp:true,textOnlyFallback:true,currentPermissionRechecked:true,localDraftRetained:true,threeExactEntries:true,fourHelpPaths:true,modelCalls:0,actualHostUi:false}));
 }finally{await app?.close();await bridge?.close();await client?.close();registration?.close();await mcp?.close();runtime?.close();if(api?.listening)await new Promise(r=>api.close(r));await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-compact-app-'));await rm(target,{recursive:true,force:true});}
});

test('identity changes while reading never expose the previous principal; Capsule exact version and concurrent drafts stay separate',async()=>{
 let subjectId='GUID'+'1'.repeat(28),release;const data=new Map(),versionId=randomUUID(),id=randomUUID(),opened=[];
 const runtime={website:'https://selected.example',now:()=>1,status:async()=>({identity:subjectId,endpoint:'https://api.example',connection:{bindingId:'same'}}),
  store:{get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)},api:{call:async(path,x)=>{if(release)await new Promise(r=>release=r);return{capsuleId:x.capsuleId,versionId:x.versionId,sourceStatus:'available',version:{title:'Selected version'}};}}};
 runtime.navigation=createNativeNavigation({website:runtime.website,store:runtime.store,openBrowser:async url=>{opened.push(url);return{launched:true};},refresh:async()=>({})});
 const controller=createCompactController(runtime),view=await controller.show({object:{kind:'capsule',id,versionId}});
 assert.equal(view.source.source.versionId,versionId);assert.equal((await controller.open({viewId:view.viewId})).url,`https://selected.example/app/capsules/${id}/versions/${versionId}`);
 const conflicts=await Promise.allSettled(['a','b'].map(draft=>controller.save({viewId:view.viewId,expectedRevision:0,draft})));assert.equal(conflicts.filter(x=>x.status==='fulfilled').length,1);
 release=true;const reading=controller.refresh({viewId:view.viewId});await new Promise(r=>setImmediate(r));subjectId='GUID'+'2'.repeat(28);release();await assert.rejects(reading,/panel_identity_changed/);
 await assert.rejects(controller.open({viewId:view.viewId}),/panel_identity_changed/);controller.close();
});
