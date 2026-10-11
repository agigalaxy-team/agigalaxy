import {nativeData} from './native-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createNativeToolServer } from '../src/native-v2/server.mjs';
import { createConfiguredNotificationChannel, nativeNotificationConfigSchema } from '../src/native-v2/notifications/config.mjs';
import { nativeConfigSchema } from '../src/native-v2/stdio.mjs';

// Actual MCP server and its choice gate. Only the OS helper and inbox/store are
// protocol doubles; the separate macOS process tests exercise owned stdio.
async function fixture({ permissionSupported = true, elicitation = true, modern = false } = {}) {
 const subjectId='GUID'+'B'.repeat(28),bindingId=randomUUID(),values=new Map(),pending=new Map();
 const counts={created:0,permission:0,show:0,closed:0,network:0,timers:0,reviews:0};
 let generation=1,sequence=0,active=true,permissionHook=null,storePutHook=null;
 const runtime={api:{endpoint:'https://synthetic.example',snapshot:()=>active?{subjectId,bindingId,generation}:null,
  call:async()=>{counts.network++;throw Error('permission must not call the service');}},
  store:{get:async key=>structuredClone(values.get(key)),put:async(key,value)=>{values.set(key,structuredClone(value));await storePutHook?.(key);},
   update:async(key,mutate)=>{const value=mutate(structuredClone(values.get(key)));values.set(key,structuredClone(value));return value;}},
  website:'https://example.org',status:async()=>({identity:subjectId}),helpFlow:{start:async()=>({})},
  navigation:{open:async()=>({})},disconnect:async()=>{active=false;return{connected:false};},now:()=>1000};
 const transport={answer:false,reviewHook:null,async start(){},async close(){this.onclose?.();},
  async send(message){if(message.method==='elicitation/create'){counts.reviews++;await this.reviewHook?.();
   this.onmessage({jsonrpc:'2.0',id:message.id,result:{action:this.answer?'accept':'decline',content:{confirm:this.answer}}});return;}
   const request=pending.get(message.id);if(request){pending.delete(message.id);clearTimeout(request.timer);request.resolve(message);}},
  call(method,params={}){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('MCP timeout')),5000);
   pending.set(id,{resolve,reject,timer});this.onmessage({jsonrpc:'2.0',id,method,params:{...params,...(modern?{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'synthetic-permission',version:'1'},'io.modelcontextprotocol/clientCapabilities':{elicitation:{form:{}}}}}:{})}});});},
  notify(method,params){this.onmessage({jsonrpc:'2.0',method,params});}};
 const makeServer=()=>createNativeToolServer(runtime,{notificationOptions:{createChannel(){counts.created++;let closed=false;return{
  kind:'macos-user-notifications',capabilities:async()=>({available:true}),show:async()=>{counts.show++;throw Error('not a permission action');},withdraw:async()=>({}),
  ...(permissionSupported?{requestPermission:async options=>{counts.permission++;assert.equal(options.isCurrent(),true);await permissionHook?.(options);
   return{available:true,permission:'authorized',channel:'macos-user-notifications',displayEvidence:'none'};}}:{}),
  close:async()=>{if(!closed){closed=true;counts.closed++;}}};},setTimer(){counts.timers++;return{unref(){}};},clearTimer(){}}});
 const instances=[];let server;
 if(modern){const handle=serveStdio(()=>{const instance=makeServer();instances.push(instance);return instance;},{transport});server={close:async()=>{await handle.close();await Promise.all(instances.map(instance=>instance.close()));}};}
 else{server=makeServer();await server.connect(transport);}
 if(!modern){await transport.call('initialize',{protocolVersion:'2025-11-25',capabilities:elicitation?{elicitation:{form:{}}}:{},clientInfo:{name:'synthetic-notification-permission',version:'1'}});
 transport.notify('notifications/initialized');}
 const invoke=async(name,argumentsValue={})=>{const value=await transport.call('tools/call',{name,arguments:argumentsValue});
  if(value.error)return{error:'protocol_input_rejected'};try{return nativeData(value.result);}catch{return{error:'tool_input_rejected'};}};
 return{server,transport,counts,values,invoke,rebind(){generation++;},setPermissionHook(value){permissionHook=value;},setStorePutHook(value){storePutHook=value;}};
}

test('macOS trusted config is exact, inert and defaults to no compiled helper', async()=>{
 const valid={kind:'macos-user-notifications',command:'/Applications/GalaxyNotifications.app/Contents/MacOS/GalaxyNotifications'};
 assert.deepEqual(nativeNotificationConfigSchema.parse(valid),valid);
 const config={version:2,endpoint:'https://official.example.org',website:'https://galaxy.example.org',dataDirectory:process.cwd(),trustedKeys:{},hostNotifications:valid};
 assert.deepEqual(nativeConfigSchema.parse(config).hostNotifications,valid);
 for(const input of [{...valid,command:'/usr/bin/osascript'},{...valid,args:[]},{...valid,requestPermission:true}])
  assert.equal(nativeConfigSchema.safeParse({...config,hostNotifications:input}).success,false);
 let constructed=0;
 const channel=createConfiguredNotificationChannel(undefined,{platform:'darwin',createMacOS:options=>{constructed++;assert.deepEqual(options,{platform:'darwin'});return{kind:'macos-user-notifications'};}});
 assert.equal(channel.kind,'macos-user-notifications');assert.equal(constructed,1);
 const actual=createConfiguredNotificationChannel(undefined,{platform:'darwin'});
 try{assert.equal((await actual.capabilities()).reason,'macos_bundled_helper_required');}finally{await actual.close();}
});

test('actual MCP permission needs a fresh choice, performs no reminder enable or source reads, and remains separate from enable',async()=>{
 const f=await fixture();try{
  const list=await f.transport.call('tools/list');
  assert.equal(list.result.tools.find(tool=>tool.name==='galaxy_host_notifications_permission').annotations.readOnlyHint,false);
  assert.equal((await f.invoke('galaxy_host_notifications_status')).enabled,false);
  assert.equal((await f.invoke('galaxy_host_notifications_permission')).state,'declined');assert.equal(f.counts.created,0);
  assert.ok((await f.invoke('galaxy_host_notifications_permission',{command:'untrusted'})).error);assert.equal(f.counts.permission,0);
  f.transport.answer=true;
  const result=await f.invoke('galaxy_host_notifications_permission');assert.equal(result.available,true);assert.equal(result.permission,'authorized');
  assert.equal(result.reminderPreferenceChanged,false);assert.equal(result.systemDisplayConfirmed,false);assert.equal(result.modelCalls,0);
  assert.equal((await f.invoke('galaxy_host_notifications_status')).enabled,false);
  assert.equal([...f.values.keys()].every(key=>key.startsWith('native-exact-choice:')),true,'only the explicit local approval is retained');
  assert.deepEqual([f.counts.permission,f.counts.show,f.counts.network,f.counts.timers,f.counts.closed],[1,0,0,0,1]);
  const before=f.counts.reviews;f.transport.answer=false;
  assert.equal((await f.invoke('galaxy_host_notifications_permission')).state,'declined');assert.equal(f.counts.reviews,before+1);
  f.transport.answer=true;assert.equal((await f.invoke('galaxy_host_notifications_enable')).enabled,true);
  assert.equal(f.counts.permission,1,'reminder enable never requests OS permission');
  const next=await f.invoke('galaxy_host_notifications_permission');assert.equal(next.reminderPreferenceChanged,false);
  assert.equal((await f.invoke('galaxy_host_notifications_status')).enabled,true,'permission check does not disable an existing reminder choice');
 }finally{await f.server.close();}
});

test('actual MCP stale or superseded OS permission choice cannot start or return a new owner result',async()=>{
 const f=await fixture();try{
  f.transport.answer=true;f.transport.reviewHook=()=>f.rebind();
  assert.equal((await f.invoke('galaxy_host_notifications_permission')).error,'native_choice_binding_changed');assert.equal(f.counts.created,0);
  f.transport.reviewHook=null;f.setPermissionHook(async()=>f.rebind());
  assert.equal((await f.invoke('galaxy_host_notifications_permission')).error,'notification_binding_or_choice_changed');
  assert.equal(f.counts.permission,1);assert.equal(f.counts.closed,1);assert.equal(f.counts.timers,0);
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  f.setPermissionHook(options=>new Promise(resolve=>{options.signal.addEventListener('abort',resolve,{once:true});entered();}));
  const request=f.invoke('galaxy_host_notifications_permission');await started;
  assert.equal((await f.invoke('galaxy_host_notifications_disable')).enabled,false);
  assert.equal((await request).error,'notification_binding_or_choice_changed');assert.equal(f.counts.closed,2);
  assert.equal(f.counts.network,0);assert.equal(f.counts.show,0);
 }finally{await f.server.close();}
});

test('a channel without OS permission support remains a truthful foreground capability result',async()=>{
 const f=await fixture({permissionSupported:false});try{
  f.transport.answer=true;const result=await f.invoke('galaxy_host_notifications_permission');
  assert.equal(result.available,false);assert.equal(result.reason,'notification_permission_request_unsupported');
  assert.equal(f.counts.permission,0);assert.equal(f.counts.closed,1);assert.equal(f.counts.network,0);assert.equal(f.counts.timers,0);
 }finally{await f.server.close();}
});

test('a concurrent permission call obtains a separate review while the first approval write awaits completion',async()=>{
 const f=await fixture();let release,entered;const hold=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});let first=true;
 try{
  f.transport.answer=true;f.setStorePutHook(async key=>{if(first&&key.startsWith('native-exact-choice:')){first=false;entered();await hold;}});
  const pending=f.invoke('galaxy_host_notifications_permission');await ready;
  const second=await f.invoke('galaxy_host_notifications_permission');release();const original=await pending;
  assert.equal(f.counts.reviews,2);assert.equal(second.permission,'authorized');
  assert.equal(original.error,'native_choice_scope_changed');assert.equal(f.counts.permission,1);
  assert.equal([...f.values.values()].every(value=>value.singleUse===true),true);
 }finally{release?.();await f.server.close();}
});

test('browser permission approval is consumed before persistence and its old URL cannot authorize again',async()=>{
 const f=await fixture({elicitation:false});let release,entered;const hold=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});let first=true;
 const approve=url=>fetch(url,{method:'POST',headers:{origin:new URL(url).origin,'content-type':'application/x-www-form-urlencoded'},body:'action=allow'});
 try{
  const preview=await f.invoke('galaxy_host_notifications_permission');assert.equal(preview.state,'user-choice-needs-browser');
  assert.equal((await f.invoke('galaxy_host_notifications_permission')).url,preview.url,'pending retry retains the original local review');
  assert.equal((await approve(preview.url)).status,200);
  f.setStorePutHook(async key=>{if(first&&key.startsWith('native-exact-choice:')){first=false;entered();await hold;}});
  const pending=f.invoke('galaxy_host_notifications_permission');await ready;
  const concurrent=await f.invoke('galaxy_host_notifications_permission');
  assert.equal(concurrent.state,'user-choice-needs-browser');assert.notEqual(concurrent.url,preview.url);assert.equal(f.counts.permission,0);
  assert.match(await(await approve(preview.url)).text(),/不能再次授权/);
  assert.equal((await f.invoke('galaxy_host_notifications_permission')).url,concurrent.url);
  release();assert.equal((await pending).permission,'authorized');assert.equal(f.counts.permission,1);
  const after=await f.invoke('galaxy_host_notifications_permission');assert.equal(after.state,'user-choice-needs-browser');
  assert.notEqual(after.url,preview.url);assert.equal(f.counts.permission,1);assert.equal(f.counts.network,0);assert.equal(f.counts.timers,0);
 }finally{release?.();await f.server.close();}
});

test('modern input_required permission continuation cannot request OS permission a second time',async()=>{
 const f=await fixture({modern:true});try{
  const params={name:'galaxy_host_notifications_permission',arguments:{}};
  const preview=await f.transport.call('tools/call',params);assert.equal(preview.result.resultType,'input_required',JSON.stringify(preview));assert.equal(f.counts.permission,0);
  const accepted={...params,requestState:preview.result.requestState,inputResponses:{choice:{action:'accept',content:{confirm:true}}}};
  const reply=await f.transport.call('tools/call',accepted);assert.equal(nativeData(reply.result).permission,'authorized');
  const repeated=await f.transport.call('tools/call',accepted);assert.equal(nativeData(repeated.result).error,'native_choice_changed_or_expired');
  assert.equal(f.counts.permission,1);
  const next=await f.transport.call('tools/call',params);assert.equal(next.result.resultType,'input_required');assert.equal(f.counts.permission,1);
 }finally{await f.server.close();}
});
