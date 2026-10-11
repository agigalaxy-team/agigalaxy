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
import {componentResult,panelResult} from './result.mjs';
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
  const tools=await client.listTools();assert.equal(tools.tools.length,14);const uri=tools.tools.find(t=>t.name==='galaxy_panel')._meta.ui.resourceUri;
  const resource=await client.readResource({uri});assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app');assert.ok(!resource.contents[0].text.includes(task.summary));assert.ok(!resource.contents[0].text.includes('PRIVATE KEY'));
  const input={object:{kind:'task',id:task.taskId},helpSessionId:help.id,origin:{host:'synthetic-sdk',workRef:'original-local-work'}};
  const textResult=await client.callTool({name:'galaxy_panel',arguments:input});assert.equal(textResult.isError,undefined);const shown=textResult.structuredContent;
  assert.equal(shown.source.title,task.title);assert.equal(shown.paths.length,4);assert.equal(shown.activeEntries.length,3);assert.ok(textResult.content[0].text.includes(task.title));assert.ok(!textResult.content[0].text.includes('viewId'));assert.ok(!textResult.content[0].text.includes(task.taskId));
  assert.equal(textResult._meta.galaxyUi.advertisedByHost,false);assert.ok(!JSON.stringify(shown).includes('credential'));assert.ok(!JSON.stringify(shown).includes('private original prompt'));
  bridge=new AppBridge(client,{name:'synthetic-official-app-bridge',version:'1'},{serverTools:{},updateModelContext:{text:{}},logging:{}});
  let teardown=false,received;app=new App({name:'synthetic-Galaxy-App',version:'1'},{},{autoResize:false});app.ontoolresult=x=>received=x;app.onteardown=async()=>{teardown=true;return{};};
  const [c,d]=InMemoryTransport.createLinkedPair();await bridge.connect(c);await app.connect(d);await bridge.sendToolInput({arguments:input});await bridge.sendToolResult(textResult);
  await new Promise(r=>setImmediate(r));assert.equal(received.structuredContent.source.source.id,task.taskId);
  const call=async(name,args={})=>app.callServerTool({name,arguments:{viewId:shown.viewId,...args}});
  const saved=await call('galaxy_panel_draft_save',{expectedRevision:0,draft:'本机未发送草稿'});assert.equal(saved.structuredContent.draft.revision,1);assert.equal(saved.structuredContent.draft.text,undefined);assert.equal(componentResult(saved).draft.text,'本机未发送草稿');
  const conflict=await call('galaxy_panel_draft_save',{expectedRevision:0,draft:'冲突草稿'});assert.equal(conflict.structuredContent.error,'panel_draft_conflict');
  const exact=await call('galaxy_panel_open');assert.equal(exact.structuredContent.url,'https://selected.example/app/tasks/'+task.taskId);assert.ok(!exact.structuredContent.url.includes('original'));
  for(const entry of ['match','publish','participate'])assert.equal((await call('galaxy_panel_open',{entry})).structuredContent.targetPath,'/app/'+entry);
  assert.equal((await call('galaxy_panel_return',{navigationId:exact.structuredContent.navigationId})).structuredContent.source.source.id,task.taskId);
  const revoked=await runtime.api.call('/v1/consents/'+auth.consentId+'/revoke',{});assert.ok(revoked);
  const loss=(await call('galaxy_panel_refresh')).structuredContent;assert.equal(loss.source,null);assert.ok(loss.sourceError);assert.equal(loss.draft.text,undefined);assert.equal(loss.draft.hasContent,true);
  await bridge.teardownResource({});assert.equal(teardown,true);assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,1);
  const reopenedResult=await client.callTool({name:'galaxy_panel',arguments:input});const reopened=componentResult(reopenedResult);assert.equal(reopened.draft.text,'本机未发送草稿');assert.ok(!JSON.stringify(reopenedResult.content).includes('本机未发送草稿'));assert.ok(!JSON.stringify(reopenedResult.structuredContent).includes('本机未发送草稿'));assert.equal(reopened.source,null);
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

test('compact exact action review preserves bytes, declining and input-required do not commit; lost ACK reconciles once',{timeout:60000},async()=>{
 const f=await serviceFixture(browserScopes),directory=await mkdtemp(join(tmpdir(),'galaxy-compact-app-actions-'));let api,runtime,controller;
 let reviewMode='declined',writes=0,drop=false,reviews=0;
 try{
  api=createApi({...f,rateLimit:1000});await new Promise(r=>api.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+api.address().port;
  runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
   fetch:async(url,options)=>{const path=new URL(url).pathname;if(path==='/v2/tasks'&&options.method!=='GET')writes++;const res=await fetch(base+path,options);if(drop&&path==='/v2/tasks'&&res.status===200){drop=false;throw Error('synthetic lost exact ACK');}return res;}});
  await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});const session=await runtime.helpFlow.start({localTaskRef:'PRIVATE ORIGINAL TASK'});
  const modern={resultType:'input_required',inputRequests:[],requestState:{bounded:'synthetic'}};
  controller=createCompactController(runtime,{reviewAction:async({preview,run})=>{reviews++;assert.equal(preview.payload.title,'Synthetic precise action');
   if(reviewMode==='modern')return modern;
   if(reviewMode!=='allow')return{content:[{type:'text',text:JSON.stringify({state:reviewMode,operation:'galaxy_panel_action_execute',...(reviewMode==='user-choice-needs-browser'?{url:'http://127.0.0.1:12345/choice'}:{})})}]};
   return{content:[{type:'text',text:JSON.stringify(await run())}]};}});
  const shown=await controller.show({helpSessionId:session.id});const payload={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',workContext:{goal:'exact synthetic goal',currentSituation:'Known test situation',attemptRefs:[]},title:'Synthetic precise action',summary:'EXACT PRIVATE PREVIEW ONLY',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+3600};
  const payloadJson=JSON.stringify(payload,null,2),prepared=await controller.prepare({viewId:shown.viewId,action:{kind:'publish-task',payloadJson}}),p=prepared.preview;
  assert.equal(p.prepareInput.payloadJson,payloadJson);const projected=panelResult(prepared);assert.ok(!JSON.stringify(projected.content).includes(payload.summary));assert.ok(!JSON.stringify(projected.structuredContent).includes(payload.summary));assert.equal(componentResult(projected).preview.payload.summary,payload.summary);
  const input={viewId:shown.viewId,operationId:p.operationId,payloadHash:p.payloadHash,authorizationRequestId:p.authorizationRequestId,confirmed:true};
  await assert.rejects(controller.execute({...input,payloadHash:'0'.repeat(64)}),/help_action_preview_changed/);assert.equal(reviews,0);
  await assert.rejects(controller.prepare({viewId:shown.viewId,action:{kind:'publish-task',payloadJson:JSON.stringify({...payload,summary:'changed material'})}}));
  const declined=await controller.execute(input);assert.equal(declined.actionResult.state,'declined');assert.equal(declined.actionResult.receipt,null);assert.equal(writes,0);
  reviewMode='user-choice-needs-browser';const browser=await controller.execute(input);assert.equal(browser.actionResult.receipt,null);assert.equal(browser.choice.state,'user-choice-needs-browser');assert.equal(writes,0);
  reviewMode='modern';assert.deepEqual(await controller.execute(input),modern);assert.equal(writes,0);
  reviewMode='allow';drop=true;const unknown=await controller.execute(input);assert.equal(unknown.actionResult.state,'acknowledged');assert.equal(writes,1);
  assert.equal((await controller.execute(input)).actionResult.state,'acknowledged');assert.equal(writes,1);
  const reconciled=await controller.reconcile({viewId:shown.viewId,operationId:p.operationId});assert.equal(reconciled.actionResult.state,'acknowledged');assert.equal(writes,1);assert.equal(reconciled.object.id,payload.taskId);
  const replay=await controller.execute(input);assert.equal(replay.actionResult.state,'acknowledged');assert.equal(writes,1);
  const clean=await controller.preview({viewId:shown.viewId,operationId:p.operationId});assert.equal(clean.preview.payload,undefined);assert.equal(clean.preview.prepareInput,undefined);
  const finished=await controller.finish({viewId:shown.viewId,expectedRevision:replay.help.revision});assert.equal(finished.handoff.taskId,payload.taskId);assert.equal(finished.remoteOperationsCanceled,false);assert.ok(!JSON.stringify(panelResult(finished)).includes('PRIVATE ORIGINAL TASK'));
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,1);
 }finally{controller?.close();runtime?.close();if(api?.listening)await new Promise(r=>api.close(r));await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-compact-app-'));await rm(target,{recursive:true,force:true});}
});

test('compact review hides stale explanations and rejects selection until sources are current',async()=>{
 const offerId=randomUUID(),sessionId=randomUUID();let state='current',revision=1;const session=()=>({id:sessionId,revision,pauseState:'active',caseId:null,taskId:null,selectedHelpIds:[],linkedOperations:[],actionOperations:[]});
 const runtime={website:'https://selected.example',status:async()=>({identity:'GUID'+'1'.repeat(28),endpoint:'https://api.example'}),store:{get:async()=>null},helpFlow:{
  review:async()=>({session:session(),checkedAt:1,offers:[{id:offerId,state,offer:{path:'open-assistance',kind:'source-backed-option',helpDescription:'CURRENT HELP ONLY',userFacingReason:'CURRENT REASON ONLY',participants:[],interventionKinds:['review'],environmentDifferences:['Different environment'],conditions:['Confirm availability'],availability:'unknown',basisRefs:[]}}]}),
  select:async()=>{revision++;}}};
 const controller=createCompactController(runtime),shown=await controller.show({helpSessionId:sessionId});assert.equal(shown.help.offers[0].helpDescription,'CURRENT HELP ONLY');state='changed';const refreshed=await controller.refresh({viewId:shown.viewId});assert.equal(refreshed.help.offers[0].state,'changed');assert.ok(!JSON.stringify(refreshed).includes('CURRENT HELP ONLY'));assert.ok(!JSON.stringify(refreshed).includes('CURRENT REASON ONLY'));await assert.rejects(controller.select({viewId:shown.viewId,expectedRevision:1,offerIds:[offerId]}),/help_selection_refresh_required/);controller.close();
});
