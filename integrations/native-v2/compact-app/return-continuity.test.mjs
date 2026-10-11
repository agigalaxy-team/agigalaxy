import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from '../../../packages/galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createNativeNavigation} from '../../../packages/galaxy-edge-mcp/src/native-v2/navigation.mjs';
import {createCompactController} from './controller.mjs';
import {panelResult} from './result.mjs';

test('browser return retains the same view and original references through actual source503 and revoked Task403',{timeout:60000},async()=>{
 const f=await serviceFixture(browserScopes),directory=await mkdtemp(join(tmpdir(),'galaxy-compact-return-')),calls=[];
 let api,runtime,controller,sourceFailure=false,holdDeniedRead=false,deniedArrived,releaseDenied;
 try{
  api=createApi({...f,rateLimit:1000});const handler=api.listeners('request')[0];api.removeAllListeners('request');
  api.on('request',(req,res)=>{if(sourceFailure&&req.method==='GET'&&/^\/v2\/tasks\/[^/]+$/.test(req.url)){
   res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'synthetic_source_unavailable'}));
  }else handler(req,res);});
  await new Promise(r=>api.listen(0,'127.0.0.1',r));const local='http://127.0.0.1:'+api.address().port;
  runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
   fetch:async(url,options)=>{const path=new URL(url).pathname,response=await fetch(local+path,options);calls.push({path,method:options?.method??'GET',status:response.status});
    if(holdDeniedRead&&response.status===403&&/^\/v2\/tasks\/[^/]+$/.test(path)){holdDeniedRead=false;deniedArrived();await new Promise(r=>releaseDenied=r);}return response;},openBrowser:async()=>({launched:true})});
  await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});
  const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',workContext:{goal:'Synthetic original-work return',currentSituation:'Local return fixture',attemptRefs:[]},title:'Synthetic current Task',summary:'SYNTHETIC_BODY_TO_HIDE',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+3600};
  const help=await runtime.helpFlow.start({localTaskRef:'SYNTHETIC_PRIVATE_ORIGINAL_WORK'});
  const auth=await runtime.authorize({requestId:randomUUID(),payloadJson:JSON.stringify(task),action:'assistance.publish',objectId:task.operationId,visibility:'Private',viewers:[],expiresAt:f.now+3600},{confirmed:true});
  assert.equal((await runtime.helpFlow.publish(help.id,{consentId:auth.consentId,payloadJson:auth.payloadJson})).publication.state,'acknowledged');
  controller=createCompactController(runtime);
  const shown=await controller.show({object:{kind:'task',id:task.taskId},helpSessionId:help.id,origin:{host:'synthetic-original-host',workRef:'synthetic-local-origin'}});
  await controller.save({viewId:shown.viewId,expectedRevision:0,draft:'SYNTHETIC_UNSENT_LOCAL_NOTE'});
  const opened=await controller.open({viewId:shown.viewId});
  const readable=await controller.resume({viewId:shown.viewId,navigationId:opened.navigationId});
  assert.equal(readable.source.source.id,task.taskId);assert.equal(readable.returned,true);
  const before=calls.length;sourceFailure=true;
  const unavailable=await controller.resume({viewId:shown.viewId,navigationId:opened.navigationId});
  assert.equal(unavailable.viewId,shown.viewId);assert.equal(unavailable.navigationId,opened.navigationId);assert.equal(unavailable.returned,true);
  assert.equal(unavailable.source,null);assert.equal(unavailable.sourceError,'synthetic_source_unavailable');
  assert.equal(unavailable.help.taskId,task.taskId);assert.equal(unavailable.help.operations[0].operationId,task.operationId);
  assert.equal(unavailable.help.operations[0].state,'acknowledged');assert.equal(unavailable.help.revision,shown.help.revision);
  assert.equal(unavailable.draft.text,'SYNTHETIC_UNSENT_LOCAL_NOTE');const projected=panelResult(unavailable);
  assert.ok(!JSON.stringify(projected.content).includes('SYNTHETIC_UNSENT_LOCAL_NOTE'));
  assert.ok(!JSON.stringify(projected.structuredContent).includes('SYNTHETIC_UNSENT_LOCAL_NOTE'));
  assert.ok(!JSON.stringify(unavailable).includes(task.summary));assert.ok(!JSON.stringify(unavailable).includes('SYNTHETIC_PRIVATE_ORIGINAL_WORK'));
  sourceFailure=false;
  const restored=await controller.resume({viewId:shown.viewId,navigationId:opened.navigationId});
  assert.equal(restored.source.summary,task.summary);assert.equal(restored.sourceError,null);
  await runtime.api.call('/v1/consents/'+auth.consentId+'/revoke',{});
  const denied=await controller.resume({viewId:shown.viewId,navigationId:opened.navigationId});
  assert.equal(denied.viewId,shown.viewId);assert.equal(denied.source,null);assert.equal(denied.sourceError,'consent_required');
  assert.equal(denied.help.operations[0].state,'acknowledged');assert.equal(denied.draft.text,'SYNTHETIC_UNSENT_LOCAL_NOTE');
  assert.ok(!JSON.stringify(denied).includes(task.summary));assert.equal(denied.businessMutation,false);assert.equal(denied.modelCalls,0);
  const oldBinding=(await runtime.status()).connection.bindingId,arrival=new Promise(r=>deniedArrived=r);holdDeniedRead=true;
  const oldReturn=controller.resume({viewId:shown.viewId,navigationId:opened.navigationId});
  await arrival;await runtime.connect({confirmed:true});assert.notEqual((await runtime.status()).connection.bindingId,oldBinding);releaseDenied();
  await assert.rejects(oldReturn,/panel_connection_changed|receipt_status_authority_changed/);
  const currentReturn=await controller.resume({viewId:shown.viewId,navigationId:opened.navigationId});
  assert.equal(currentReturn.source,null);assert.equal(currentReturn.sourceError,'consent_required');assert.equal(currentReturn.help.taskId,task.taskId);
  const after=calls.slice(before);
  assert.ok(after.some(x=>x.status===503));assert.ok(after.some(x=>x.path==='/v2/tasks/'+task.taskId&&x.status===403));
  assert.equal(after.filter(x=>x.method==='POST'&&['/v1/consents','/v2/tasks','/v2/cases/events','/v2/verification-records/submit'].includes(x.path)).length,0);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,1);
  assert.equal((await runtime.store.get('navigation:'+opened.navigationId)).origin.workRef,'synthetic-local-origin');
  console.log(JSON.stringify({actualSignedHttp:true,actualTaskConsent403:true,actualSource503:true,actualRebindHeld403Rejected:true,sameView:true,sameTask:true,originalAckPreserved:true,newBusinessWrites:0,newConsents:0,modelCalls:0,physicalHostAcceptance:false}));
 }finally{
  controller?.close();runtime?.close();if(api?.listening)await new Promise(r=>api.close(r));await f.db.close();
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-compact-return-'));await rm(target,{recursive:true,force:true});
 }
});

function controlled(){
 let identity='GUID'+'1'.repeat(28),bindingId='binding-one',generation=1,mode=null,release,entered;
 const reads=[],data=new Map(),object={kind:'task',id:randomUUID()};
 const snapshot=()=>({subjectId:identity,endpoint:'https://api.example',bindingId,generation});
 const runtime={website:'https://selected.example',now:()=>1,status:async()=>({identity,endpoint:'https://api.example',connection:snapshot()}),
  store:{get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)},api:{snapshot,call:async path=>{reads.push(path);return{taskId:object.id,version:1,state:'open',request:{title:'Current source',summary:'Current permitted body'},participations:[]};}},
  receiptStatus:{captureLease:()=>{const original=JSON.stringify(snapshot());return{...snapshot(),assertCurrent(){if(JSON.stringify(snapshot())!==original)throw Object.assign(Error('receipt_status_authority_changed'),{code:'receipt_status_authority_changed'});}};}}};
 runtime.navigation=createNativeNavigation({website:runtime.website,store:runtime.store,captureLease:runtime.receiptStatus.captureLease,openBrowser:async()=>({launched:true}),
  refresh:async target=>{if(mode?.held){entered();await new Promise(r=>release=r);}if(mode?.error)throw mode.error;return{taskId:target.id};}});
 const controller=createCompactController(runtime);
 return{controller,object,reads,setError:error=>mode={error},hold:async(error)=>{let arrive;const arrival=new Promise(r=>arrive=r);mode={error,held:true};entered=arrive;return{arrival,release:()=>release()};},change:kind=>{if(kind==='identity')identity='GUID'+'2'.repeat(28);if(kind==='binding')bindingId='binding-two';if(kind==='generation')generation++;}};
}

test('browser return refuses navigation from another view and non-source failures',async()=>{
 const c=controlled();try{
  const first=await c.controller.show({object:c.object}),second=await c.controller.show({object:c.object});
  const opened=await c.controller.open({viewId:first.viewId}),input={viewId:first.viewId,navigationId:opened.navigationId};
  await assert.rejects(c.controller.resume({...input,viewId:second.viewId}),/panel_navigation_mismatch/);
  for(const e of [Object.assign(Error('unauthorized'),{code:'unauthorized',status:401}),Object.assign(Error('binding_revoked'),{code:'binding_revoked',status:403}),Error('navigation_not_found'),Error('unexpected_internal_failure')]){
   c.setError(e);await assert.rejects(c.controller.resume(input),reason=>reason===e);
  }
 }finally{c.controller.close();}
});

for(const change of ['identity','binding','generation'])test('late source403 cannot return a previous '+change+' scope',async()=>{
 const c=controlled();try{
  const shown=await c.controller.show({object:c.object}),opened=await c.controller.open({viewId:shown.viewId});
  const held=await c.hold(Object.assign(Error('consent_required'),{code:'consent_required',status:403}));
  const returned=c.controller.resume({viewId:shown.viewId,navigationId:opened.navigationId});
  await held.arrival;c.change(change);held.release();
  await assert.rejects(returned,/panel_identity_changed|panel_connection_changed|receipt_status_authority_changed/);
  assert.equal(c.reads.length,1,'only the initial permitted source was read; no render under changed authority');
 }finally{c.controller.close();}
});
