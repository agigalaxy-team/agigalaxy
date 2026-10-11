import {nativeData} from './native-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createNativeToolServer} from '../src/native-v2/server.mjs';

function wire() {
 let sequence=0; const pending=new Map();
 return {answer:false,reviewHook:null,async start(){},async close(){this.onclose?.();},
  async send(message){
   if(message.method==='elicitation/create') {await this.reviewHook?.();this.onmessage({jsonrpc:'2.0',id:message.id,result:{action:this.answer?'accept':'decline',content:{confirm:this.answer}}});return;}
   const p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);p.resolve(message);}
  },
  call(method,params={}){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('MCP response timeout')),5000);pending.set(id,{resolve,reject,timer});this.onmessage({jsonrpc:'2.0',id,method,params});});},
  notify(method,params){this.onmessage({jsonrpc:'2.0',method,params});},
 };
}
async function fixture() {
 const subjectId='GUID'+'B'.repeat(28), bindingId=randomUUID(),id='room-message:'+randomUUID();
 const rows=new Map(),calls=[],shows=[],timers=new Map();let generation=1,active=true,closed=0,created=0,acknowledged=false,loseAck=true,tail=Promise.resolve();
 const store={creationHook:null,get:async key=>structuredClone(rows.get(key)??null),put:async(key,value)=>rows.set(key,structuredClone(value)),
  update(key,change){const result=tail.then(async()=>{const value=change(structuredClone(rows.get(key)??null));rows.set(key,structuredClone(value));if(key==='native-notification-delivery-client')await store.creationHook?.();return structuredClone(value);});tail=result.catch(()=>{});return result;}};
 const api={endpoint:'https://synthetic.example',snapshot:()=>active?{subjectId,bindingId,generation}:null,async call(path,input){calls.push({path,input});
  if(path.endsWith('/query'))return{items:[{id,object:{type:'room',id:randomUUID()},title:'private source stays private',interruptiveEligible:true,quiet:false,read:false,presented:acknowledged}]};
  if(path.endsWith('/claim'))return{id,claimed:!acknowledged,claimId:input.claimId,leaseUntil:new Date(1030*1000).toISOString(),presented:acknowledged};
  if(path.endsWith('/ack')){acknowledged=true;if(loseAck){loseAck=false;throw Error('synthetic_lost_ack');}return{id,presented:true,humanReadChanged:false,acknowledgement:'client-reported-display'};}
  throw Error('Unexpected API');
 }};
 const runtime={api,store,website:'https://example.org',now:()=>1000,status:async()=>({identity:subjectId}),navigation:{open:async()=>({})},helpFlow:{start:async()=>({})},disconnect:async()=>{active=false;return{connected:false};}};
 const notificationOptions={createChannel:()=>{created++;return{capabilities:async()=>({available:true}),show:async input=>{shows.push(input);return{state:'shown',displayed:true,evidence:'BalloonTipShown',promptId:input.promptId};},withdraw:async()=>({}),close:async()=>{closed++;}};},
  setTimer:(fn,ms)=>{assert.equal(ms,60000);const key={unref(){}};timers.set(key,fn);return key;},clearTimer:key=>timers.delete(key)};
 const server=createNativeToolServer(runtime,{notificationOptions}),transport=wire();await server.connect(transport);
 await transport.call('initialize',{protocolVersion:'2025-11-25',capabilities:{elicitation:{form:{}}},clientInfo:{name:'synthetic-notification-integration',version:'1'}});transport.notify('notifications/initialized');
 const invoke=async(name,args={})=>{const response=await transport.call('tools/call',{name,arguments:args});if(response.error)return{error:'protocol_input_rejected'};try{return nativeData(response.result);}catch{return{error:'tool_input_rejected'};}};
 return {server,transport,invoke,calls,shows,timers,rows,store,rebind(){generation++;},get closed(){return closed;},get created(){return created;},async tick(){const [key,fn]=timers.entries().next().value;timers.delete(key);await fn();}};
}
test('actual MCP declined or stale reminder choice starts no host process, timer, network or model',async()=>{
 const f=await fixture();try{
  assert.equal((await f.invoke('galaxy_host_notifications_status')).enabled,false);
  assert.equal((await f.invoke('galaxy_host_notifications_check')).state,'disabled');
  assert.equal((await f.invoke('galaxy_host_notifications_enable')).state,'declined');
  f.transport.answer=true;f.transport.reviewHook=()=>f.rebind();
  assert.equal((await f.invoke('galaxy_host_notifications_enable')).error,'native_choice_binding_changed');
  assert.equal(f.created,0);assert.equal(f.timers.size,0);assert.equal(f.calls.length,0);
 }finally{await f.server.close();}
});
test('actual MCP enable polls current inbox; stop preserves original unknown ACK and disconnect drains reminders',async()=>{
 const f=await fixture();try{
  f.transport.answer=true;const enabled=await f.invoke('galaxy_host_notifications_enable');assert.equal(enabled.enabled,true);assert.equal(enabled.modelCalls,0);
  assert.equal(f.created,1);assert.equal(f.timers.size,1);assert.equal(f.calls.length,0);
  assert.ok((await f.invoke('galaxy_host_notifications_enable',{command:'untrusted'})).error);
  await f.tick();assert.equal(f.shows.length,1);assert.equal(f.timers.size,1);
  const first=f.calls.find(x=>x.path.endsWith('/ack'));assert.ok(first);
  await f.invoke('galaxy_host_notifications_disable');assert.equal(f.timers.size,0);
  const before=f.calls.length;const reconciled=await f.invoke('galaxy_host_notifications_reconcile');assert.equal(reconciled.systemNotificationStarts,0);
  assert.deepEqual(f.calls.slice(before),[first]);assert.equal(f.shows.length,1);
  assert.equal(f.calls.some(x=>x.path.endsWith('/read')||x.path.endsWith('/cursor')),false);
  assert.equal(JSON.stringify([...f.rows.values(),...f.shows]).includes('private source'),false);
  await f.invoke('galaxy_host_notifications_enable');assert.equal(f.timers.size,1);
  await f.invoke('galaxy_native_disconnect');assert.equal(f.timers.size,0);assert.equal((await f.invoke('galaxy_host_notifications_check')).state,'disabled');
 }finally{await f.server.close();assert.equal(f.closed,1);}
});
test('same-owner replacement binding stops the scheduled bridge before any new notification request',async()=>{
 const f=await fixture();try{
  f.transport.answer=true;await f.invoke('galaxy_host_notifications_enable');f.rebind();await f.tick();
  assert.equal(f.timers.size,0);assert.equal(f.calls.length,0);assert.equal(f.shows.length,0);
 }finally{await f.server.close();}
});
test('explicit disable during local instance creation prevents the older accepted enable from scheduling',async()=>{
 const f=await fixture();let release,entered;
 const blocked=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 try{
  f.transport.answer=true;f.store.creationHook=async()=>{entered();await blocked;};
  const enabling=f.invoke('galaxy_host_notifications_enable');await started;
  assert.equal((await f.invoke('galaxy_host_notifications_disable')).enabled,false);release();
  assert.equal((await enabling).enabled,false);assert.equal((await f.invoke('galaxy_host_notifications_status')).enabled,false);
  assert.equal(f.timers.size,0);assert.equal(f.calls.length,0);assert.equal(f.shows.length,0);
 }finally{release();await f.server.close();}
});
test('disabling reminders invalidates only their prior enable choice and requires a fresh actual answer',async()=>{
 const f=await fixture();try{
  f.transport.answer=true;assert.equal((await f.invoke('galaxy_host_notifications_enable')).enabled,true);
  await f.invoke('galaxy_host_notifications_disable');f.transport.answer=false;
  assert.equal((await f.invoke('galaxy_host_notifications_enable')).state,'declined');
  assert.equal((await f.invoke('galaxy_host_notifications_status')).enabled,false);assert.equal(f.timers.size,0);
 }finally{await f.server.close();}
});
