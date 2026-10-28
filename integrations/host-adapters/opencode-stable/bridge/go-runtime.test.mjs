import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {generateKeyPairSync} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createNativeRuntimeBridge} from '../native-runtime-bridge.mjs';
import {createHostLocalClient} from './host-local-client.mjs';
import {createHostInputHandler} from './host-input.mjs';
import {createOpenCodeWorkRecorder} from '../work-recorder.mjs';
import {createOpenCodeWorkSummarizer} from '../work-summarizer.mjs';
const executable=process.env.GALAXY_GO_TEST_BINARY;
const data=result=>JSON.parse(result.content[0].text);
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'galaxy-go-host-')),store=join(directory,'data'),configPath=join(directory,'native.json'),closers=[];
 t.after(async()=>{for(const close of closers.reverse())await close();const exact=resolve(directory);assert.ok(exact.startsWith(resolve(tmpdir())+sep));await rm(exact,{recursive:true,force:true});});
 await promisify(execFile)(process.execPath,['scripts/go/native-fixture.mjs',store]);
 const {identity}=JSON.parse(await readFile(join(store,'expected.json'),'utf8'));
 const now=Math.floor(Date.now()/1000),key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
 await writeFile(configPath,JSON.stringify({version:2,website:'https://selected.invalid',endpoint:'https://galaxy.invalid',dataDirectory:store,trustedKeys:{synthetic:{publicKeyPem:key,notBefore:now-1,notAfter:now+3600,revoked:false}}}));
 return{configPath,identity,close:fn=>closers.push(fn)};
}
async function eventually(predicate){for(let index=0;index<150;index++){if(await predicate())return;await delay(20);}assert.fail('Host operation did not finish');}

test('real Go MCP child preserves requestState, exact choices, cancellation and close',{skip:!executable&&'Set GALAXY_GO_TEST_BINARY to the development Go executable'},async t=>{
 const f=await fixture(t),bridge=createNativeRuntimeBridge({backend:'go',executable,configPath:f.configPath});f.close(bridge.close);
 const reads=await Promise.all([bridge.call('galaxy_local_work_list'),bridge.call('galaxy_local_archive_settings')]);assert.equal(data(reads[0]).galaxyId,f.identity.id);
 const args={galaxyId:f.identity.id,enabled:true,sessions:[{host:'opencode',sessionId:'project-notes'}],autoCleanAfterDays:null};
 const choice=await bridge.call('galaxy_local_archive_configure',args);assert.equal(choice.resultType,'input_required');assert.ok(choice.requestState);assert.match(choice.inputRequests.choice.params.message,/project-notes|阅读位置/);
 const denied=data(await bridge.call('galaxy_local_archive_configure',args,{requestState:choice.requestState,inputResponses:{choice:{action:'decline'}}}));assert.equal(denied.state,'declined');
 const next=await bridge.call('galaxy_local_archive_configure',args);assert.notEqual(next.requestState,choice.requestState);
 const saved=data(await bridge.call('galaxy_local_archive_configure',args,{requestState:next.requestState,inputResponses:{choice:{action:'accept',content:{confirm:true}}}}));assert.equal(saved.settings.enabled,true);
 const replay=data(await bridge.call('galaxy_local_archive_configure',args,{requestState:next.requestState,inputResponses:{choice:{action:'accept',content:{confirm:true}}}}));assert.deepEqual(replay,saved);
 const controller=new AbortController();controller.abort();await assert.rejects(bridge.call('galaxy_local_work_list',{}, {signal:controller.signal}),/native_bridge_cancelled/);
 const firstClose=bridge.close();assert.equal(firstClose,bridge.close());await firstClose;await assert.rejects(bridge.call('galaxy_local_work_list'),/native_bridge_closed/);
});

test('real Go host persists foreground observations and own SDK summaries; MCP reads the same original store',{skip:!executable&&'Set GALAXY_GO_TEST_BINARY to the development Go executable'},async t=>{
 const f=await fixture(t),host=createHostLocalClient({executable,configPath:f.configPath}),bridge=createNativeRuntimeBridge({backend:'go',executable,configPath:f.configPath});f.close(host.close);f.close(bridge.close);
 assert.deepEqual(await host.history.identity(),{id:f.identity.id});
 const handlers=new Map(),messages=[],parts=new Map(),notices=[];
 const api={app:{version:'synthetic-host'},route:{current:{name:'session',params:{sessionID:'foreground'}}},event:{on:(type,handler)=>{handlers.set(type,handler);return()=>handlers.delete(type);}},state:{session:{messages:()=>messages},part:id=>parts.get(id)||[],mcp:()=>[]},ui:{toast:()=>{}}};
 const recorder=createOpenCodeWorkRecorder(api,{history:host.history,archive:host.archive,pollMs:60000,onSessionComplete:async input=>{notices.push(input);return bridge.sessionComplete(input);}});f.close(()=>recorder.close());await recorder.ready;
 const created=Date.now()+50,info={id:'host-message',sessionID:'foreground',role:'user',time:{created},model:{providerID:'synthetic-host',modelID:'chosen-model'}};
 messages.push(info);parts.set(info.id,[{id:'text-part',messageID:info.id,sessionID:'foreground',type:'text',text:'A synthetic draft exists; outcome is unknown.'}]);
 handlers.get('message.updated')({id:'event',type:'message.updated',properties:{sessionID:'foreground',info}});await recorder.refresh();
 handlers.get('session.idle')({id:'session-done',type:'session.idle',properties:{sessionID:'foreground'}});await recorder.refresh();await eventually(()=>notices.length>0&&recorder.status().archiveSync?.state==='submitted');assert.deepEqual(notices[0],{galaxyId:f.identity.id,host:'opencode',sessionId:'foreground'});assert.equal(recorder.status().archiveSync.completionConfirmed,false);
 const work=(await host.history.get({host:'opencode',sessionId:'foreground',limit:100})).work;
 assert.ok(work.workId);const observed=await host.history.get({workId:work.workId});assert.ok(observed.observations.some(item=>item.content?.excerpt?.includes('synthetic draft')));
 let createInput,promptInput;
 const sdk={create:async input=>{createInput=input;return{data:{id:'own-summary-child'}};},prompt:async input=>{promptInput=input;return{data:{info:{id:'own-summary-result'},parts:[{type:'text',text:JSON.stringify({title:'Synthetic draft',summary:'Draft observed; result unknown.',outcome:'unknown'})}]}};},update:async()=>({data:{}}),abort:async()=>({data:{}})};
 const summarizer=createOpenCodeWorkSummarizer({client:{session:sdk}},host.history,{delayMs:0});f.close(()=>summarizer.close());
 summarizer.schedule({galaxyId:f.identity.id,workId:work.workId,sessionId:'foreground',model:{providerID:'synthetic-host',modelID:'chosen-model'}});
 await eventually(async()=>!(await host.history.get({workId:work.workId})).work.pending);
 assert.deepEqual(createInput.permission,[{permission:'*',pattern:'*',action:'deny'}]);assert.equal(promptInput.model.modelID,'chosen-model');
 const detail=await host.history.get({workId:work.workId});assert.equal(detail.summaries[0].sourceKind,'user-model');assert.equal(detail.summaries[0].execution.messageId,'own-summary-result');
 await assert.rejects(host.history.observe({galaxyId:'unrelated',host:'opencode',sessionId:'foreground',sourceId:'forged',kind:'message',source:{kind:'host-event'},details:{}}),/local_work_identity_changed/);
 assert.equal((await host.archive.captureMessage({galaxyId:f.identity.id,host:'opencode',sessionId:'unselected',messageId:'not-selected',message:{id:'not-selected',role:'user'},parts:[]})).captured,false);
 await recorder.close();assert.equal(handlers.size,0);
 assert.deepEqual(data(await bridge.call('galaxy_local_work_get',{workId:work.workId})),detail);
});

test('trusted host Dialog selection and native dismissal produce the actual response',async()=>{
 let dialog,dispose;const api={ui:{dialog:{setSize(){},replace(factory,onDispose){dispose=onDispose;factory();}},DialogSelect(input){dialog=input;}}};
 const handler=createHostInputHandler(()=>api),params={mode:'form',message:'Exact selected scope',requestedSchema:{properties:{confirm:{type:'boolean'}},required:['confirm']}};
 const accepted=handler(params);dialog.options[0].onSelect();assert.deepEqual(await accepted,{action:'accept',content:{confirm:true}});dispose();
 const cancelled=handler(params);dispose();assert.deepEqual(await cancelled,{action:'cancel'});
 const controller=new AbortController(),aborted=handler(params,{signal:controller.signal});controller.abort();assert.deepEqual(await aborted,{action:'cancel'});
});

test('actual Go requestState continues only after host Dialog choice and host close cancels its waiting form',{skip:!executable&&'Set GALAXY_GO_TEST_BINARY to the development Go executable'},async t=>{
 const f=await fixture(t);let dialog,opened;
 const api={ui:{dialog:{setSize(){},replace(factory){factory();opened?.();}},DialogSelect(input){dialog=input;}}};
 const bridge=createNativeRuntimeBridge({backend:'go',executable,configPath:f.configPath,onInputRequest:createHostInputHandler(()=>api)});f.close(bridge.close);
 const args={enabled:true,sessions:[{host:'opencode',sessionId:'project-notes'}],autoCleanAfterDays:null};
 let ready=new Promise(resolve=>{opened=resolve;});const first=bridge.call('galaxy_local_archive_configure',args);await ready;
 assert.match(dialog.title,/阅读位置|project-notes/);dialog.options[0].onSelect();assert.equal(data(await first).settings.enabled,true);
 ready=new Promise(resolve=>{opened=resolve;});const waiting=bridge.call('galaxy_local_archive_configure',{...args,enabled:false,sessions:[]});
 // Attach the rejection handler before closing so shutdown cannot become an
 // unhandled rejection while the real child is still finishing its stream.
 const cancelled=assert.rejects(waiting,/native_bridge_closed/);await ready;await bridge.close();await cancelled;
});

test('owning host notification rejects a wrong original owner without becoming a model tool or breaking MCP',{skip:!executable&&'Set GALAXY_GO_TEST_BINARY to the development Go executable'},async t=>{
 const f=await fixture(t),diagnostics=[],bridge=createNativeRuntimeBridge({backend:'go',executable,configPath:f.configPath,onDiagnostic:value=>diagnostics.push(value)});f.close(bridge.close);
 assert.deepEqual(await bridge.sessionComplete({galaxyId:'wrong-original-owner',host:'opencode',sessionId:'project-notes'}),{state:'submitted',completionConfirmed:false});
 assert.equal(data(await bridge.call('galaxy_local_work_list')).galaxyId,f.identity.id);await eventually(()=>diagnostics.some(value=>value.code==='native_connection_selection_changed'));
 const before=diagnostics.length;assert.deepEqual(await bridge.sessionComplete({galaxyId:f.identity.id,host:'opencode',sessionId:'project-notes'}),{state:'submitted',completionConfirmed:false});
 assert.equal(data(await bridge.call('galaxy_local_work_list')).galaxyId,f.identity.id);assert.equal(diagnostics.length,before);
 await assert.rejects(bridge.call('notifications/galaxy/host-session-complete',{galaxyId:f.identity.id,host:'opencode',sessionId:'project-notes'}),/native_bridge_request_rejected/);
 await bridge.close();await assert.rejects(bridge.sessionComplete({galaxyId:f.identity.id,host:'opencode',sessionId:'project-notes'}),/native_bridge_closed/);
});
