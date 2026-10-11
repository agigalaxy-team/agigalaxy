import {nativeData} from './native-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createNativeToolServer} from '../src/native-v2/server.mjs';
import {createNativeWatch} from '../src/native-v2/watch.mjs';
import {nativeWatchHostConfigSchema} from '../src/native-v2/watch-host-config.mjs';
import {createClaudeCodeDriver} from '../src/native-v2/host-adapters/claude-code.mjs';

function wire(){
 let sequence=0;const pending=new Map();
 return{answer:false,reviewHook:null,async start(){},async close(){this.onclose?.();},
  async send(message){
   if(message.method==='elicitation/create'){
    await this.reviewHook?.(message);
    this.onmessage({jsonrpc:'2.0',id:message.id,result:{action:this.answer?'accept':'decline',content:{confirm:this.answer}}});return;
   }
   const p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);p.resolve(message);}
  },
  call(method,params={}){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('MCP response timeout')),5000);pending.set(id,{resolve,reject,timer});this.onmessage({jsonrpc:'2.0',id,method,params});});},
  notify(method,params){this.onmessage({jsonrpc:'2.0',method,params});},
 };
}
async function fixture({configured=true,kind='codex-app-server',driverFactory=null}={}){
 const subjectId='GUID'+'A'.repeat(28),bindingId=randomUUID(),roomId=randomUUID(),grantId=randomUUID(),messageId=randomUUID();
 const values=new Map(),calls=[],runs=[],constructors=[];let generation=1,closed=0,cursor=0;
 const snapshot=()=>({subjectId,bindingId,generation});
 const store={get:async k=>structuredClone(values.get(k)),put:async(k,v)=>values.set(k,structuredClone(v)),update:async(k,f)=>values.set(k,structuredClone(f(structuredClone(values.get(k)))))};
 const api={endpoint:'https://synthetic.example',snapshot,async call(path,input){calls.push({path,input});
  if(path.endsWith('/agent-grants'))return{items:[{grantId,bindingId,state:'active',expiresAt:2000}]};
  if(path.endsWith('/history'))return{messages:[{messageId,sequence:'1',subjectId:'other',state:'accepted',text:'Synthetic authorized source'}],scannedThrough:'1',complete:true};
  if(path.endsWith('/cursor')){cursor++;return{kind:'agent',agentGrantId:grantId,sequence:'1'};}
  if(path.endsWith('/agent-revoke'))return{revoked:true};
  throw Error('unexpected API '+path);
 }};
 const runtime={api,store,website:'https://example.org',now:()=>1000,status:async()=>({identity:subjectId}),navigation:{open:async()=>({})},helpFlow:{start:async()=>({})}};
 const watch=createNativeWatch({api,store,subjectId,now:runtime.now});
 const id=(await watch.start({roomId,agentGrantId:grantId,purpose:'review only the shared messages',expiresAt:2000},{confirmed:true})).items[0].id;
 const key='native-watch:'+api.endpoint+':'+subjectId;await store.update(key,s=>{s.watches[id].nextCheckAt=1900;return s;});
 const factory=options=>{constructors.push(options);return{
  capabilities:async()=>({host:'codex-app-server',readerConfigurationConfirmed:true,models:[{model:'selected-model'}]}),
  run:async input=>{runs.push(input);await input.onState({state:'dispatching',threadId:'original-thread',turnId:'original-turn'});return{state:'completed',threadId:'original-thread',turnId:'original-turn',output:'Synthetic completed analysis',hostTurnDispatches:1};},
  reconcile:async input=>({state:'completed',threadId:input.threadId,turnId:input.turnId}),
  cancel:async()=>({state:'not-running',cancellationConfirmed:false,executionEnded:true}),status:()=>({state:'not-running',modelRunning:false}),close:async()=>{closed++;},
 };};
 const config={kind,command:process.execPath,cwd:process.cwd(),...(kind==='codex-app-server'?{disabledMcpServers:['synthetic_server']}:{})};
 const selectedFactory=driverFactory?options=>{constructors.push(options);return driverFactory(options);}:factory;
 const server=createNativeToolServer(runtime,{...(configured?{watchHost:config}:{}),watchHostDriverFactory:selectedFactory}),transport=wire();
 await server.connect(transport);await transport.call('initialize',{protocolVersion:'2025-11-25',capabilities:{elicitation:{form:{}}},clientInfo:{name:'synthetic-host-integration',version:'1'}});transport.notify('notifications/initialized');
 const invoke=async(name,args={})=>{const response=await transport.call('tools/call',{name,arguments:args});if(response.error)return{protocolError:response.error};try{return nativeData(response.result);}catch{if(response.result.isError)return{error:'mcp_tool_input_rejected'};throw Error('Unexpected non-JSON success');}};
 return{server,transport,invoke,id,store,key,constructors,runs,calls,config,rebind(){generation++;},get closed(){return closed;},get cursor(){return cursor;}};
}

test('trusted Watch host configuration accepts only fixed local executable options',()=>{
 const valid={kind:'codex-app-server',command:process.execPath,cwd:process.cwd()};assert.ok(nativeWatchHostConfigSchema.safeParse(valid).success);
 assert.equal(nativeWatchHostConfigSchema.safeParse({...valid,command:'codex'}).success,false);
 assert.equal(nativeWatchHostConfigSchema.safeParse({...valid,args:['--unsafe']}).success,false);
 assert.equal(nativeWatchHostConfigSchema.safeParse({...valid,disabledMcpServers:['name.enabled=true']}).success,false);
 assert.equal(nativeWatchHostConfigSchema.safeParse({...valid,disabledMcpServers:['x'.repeat(65)]}).success,false);
 assert.equal(nativeWatchHostConfigSchema.safeParse({...valid,disabledMcpServers:['duplicate','duplicate']}).success,false);
});
test('missing host configuration and read-only Watch status start no host or model',async()=>{
 const f=await fixture({configured:false});try{
  assert.deepEqual(await f.invoke('galaxy_watch_host_capabilities'),{configured:false,modelStarted:false});
  const status=await f.invoke('galaxy_watch_status',{id:f.id});assert.equal(status.items[0].hostModelEnabled,false);
  assert.equal(f.constructors.length,0);assert.equal(f.runs.length,0);
 }finally{await f.server.close();}
});
test('actual MCP choice enables only the configured host scope; original host receipt starts no extra turn',async()=>{
 const f=await fixture();try{
  const capability=await f.invoke('galaxy_watch_host_capabilities');assert.equal(capability.readerConfigurationConfirmed,true);assert.equal(f.runs.length,0);
  assert.deepEqual(f.constructors[0],{command:f.config.command,cwd:f.config.cwd,disabledMcpServers:['synthetic_server']});
  const refused=await f.invoke('galaxy_watch_host_activate',{id:f.id,model:'selected-model'});assert.equal(refused.state,'declined');assert.equal(f.runs.length,0);
  f.transport.answer=true;
  const activated=await f.invoke('galaxy_watch_host_activate',{id:f.id,model:'selected-model'});assert.equal(activated.items[0].hostModelEnabled,true);
  assert.equal(f.runs.length,0);
  const extra=await f.invoke('galaxy_watch_host_activate',{id:f.id,model:'selected-model',command:'untrusted'});assert.ok(extra.protocolError||extra.error);assert.equal(f.runs.length,0);
  await f.store.update(f.key,s=>{s.watches[f.id].nextCheckAt=1000;return s;});
  const done=await f.invoke('galaxy_watch_check',{id:f.id});assert.equal(done.state,'processed');assert.equal(f.runs.length,1);assert.equal(f.cursor,1);
  assert.equal(f.runs[0].cwd,f.config.cwd);assert.equal(f.runs[0].model,'selected-model');assert.equal(f.runs[0].work.items.length,1);
  await f.store.update(f.key,s=>{s.watches[f.id].lastHostExecution={workId:randomUUID(),threadId:'original-thread',turnId:'original-turn',lease:{subjectId:'GUID'+'A'.repeat(28),endpoint:'https://synthetic.example'}};return s;});
  const receipt=await f.invoke('galaxy_watch_host_reconcile',{id:f.id});assert.equal(receipt.state,'completed');assert.equal(receipt.bodyIncluded,false);assert.equal(f.runs.length,1);assert.equal(f.cursor,1);
 }finally{await f.server.close();assert.equal(f.closed,1);}
});
test('a same-owner rebind during the actual MCP choice cannot enable its previous host selection',async()=>{
 const f=await fixture();try{
  f.transport.answer=true;f.transport.reviewHook=async()=>f.rebind();
  const result=await f.invoke('galaxy_watch_host_activate',{id:f.id,model:'selected-model'});assert.equal(result.error,'native_choice_binding_changed');
  assert.equal(f.constructors.length,0);assert.equal(f.runs.length,0);
 }finally{await f.server.close();}
});

const claudeHelp=' --bare --restricted --safe-mode --tools --disallowedTools --strict-mcp-config --mcp-config --setting-sources --settings --disable-slash-commands --no-chrome --permission-mode --permission-prompts --no-session-persistence --session-id --replay-user-messages ';
test('actual MCP Claude entry explains unavailable managed proof, refuses background selection and keeps ordinary foreground Watch readable',async()=>{
 const probes=[];let spawns=0;
 const f=await fixture({kind:'claude-code',driverFactory:options=>createClaudeCodeDriver({...options,
  readCommand:async args=>{probes.push(args);return args[0]==='--version'?'2.1.266 (Claude Code)':claudeHelp;},
  spawnProcess:()=>{spawns++;throw Error('No real model process is permitted');}})});
 try{
  const caps=await f.invoke('galaxy_watch_host_capabilities');assert.equal(caps.host,'claude-code');assert.equal(caps.configured,true);
  assert.equal(caps.readerProfileDocumented,true);assert.equal(caps.readerConfigurationConfirmed,false);
  assert.equal(caps.backgroundReaderSupported,false);assert.equal(caps.backgroundReaderReason,'host_reader_configuration_unconfirmed');
  assert.equal(caps.effectiveManagedPolicyConfirmed,false);assert.equal(caps.modelStarted,false);assert.equal(spawns,0);
  f.transport.answer=true;
  const result=await f.invoke('galaxy_watch_host_activate',{id:f.id,model:'explicit-user-model'});
  assert.equal(result.state,'foreground-fallback');assert.equal(result.reason,'host_reader_configuration_unconfirmed');
  assert.equal(result.hostModelEnabled,false);assert.equal(result.modelCalls,0);assert.equal(result.modelStarted,false);
  const status=await f.invoke('galaxy_watch_status',{id:f.id});assert.equal(status.items[0].hostModelEnabled,false);
  await f.store.update(f.key,s=>{s.watches[f.id].nextCheckAt=1000;return s;});
  const work=await f.invoke('galaxy_watch_check',{id:f.id});assert.equal(work.state,'work-ready');
  assert.equal(work.work.items[0].text,'Synthetic authorized source');assert.equal(f.cursor,0);assert.equal(spawns,0);
  assert.deepEqual(probes,[['--version'],['--help']]);
  const original={threadId:randomUUID(),turnId:randomUUID()};
  await f.store.update(f.key,s=>{s.watches[f.id].lastHostExecution={workId:randomUUID(),...original,
   lease:{subjectId:'GUID'+'A'.repeat(28),endpoint:'https://synthetic.example'}};return s;});
  // This production driver has no saved original terminal. The MCP recovery
  // path must return metadata unknown and cannot recreate an old session.
  const receipt=await f.invoke('galaxy_watch_host_reconcile',{id:f.id});assert.equal(receipt.state,'unknown');
  assert.equal(receipt.bodyIncluded,false);assert.equal(receipt.automaticRetry,false);assert.equal(spawns,0);assert.equal(f.cursor,0);
  assert.ok(!JSON.stringify(await f.store.get(f.key)).includes('Synthetic authorized source'));
  assert.deepEqual(f.constructors,[{command:f.config.command,cwd:f.config.cwd}]);
 }finally{await f.server.close();}
});

test('actual MCP Claude capability wait cannot enable or fallback against a replacement binding',async()=>{
 let spawns=0;
 const f=await fixture({kind:'claude-code',driverFactory:options=>createClaudeCodeDriver({...options,
  readCommand:async args=>{if(args[0]==='--help'){f.rebind();return claudeHelp;}return'2.1.266 (Claude Code)';},
  spawnProcess:()=>{spawns++;throw Error('No model process');}})});
 try{
  f.transport.answer=true;
  const result=await f.invoke('galaxy_watch_host_activate',{id:f.id,model:'explicit-user-model'});
  assert.equal(result.error,'watch_binding_changed');assert.equal(spawns,0);
  const status=await f.invoke('galaxy_watch_status',{id:f.id});assert.equal(status.items[0].hostModelEnabled,false);
 }finally{await f.server.close();}
});

test('declining actual MCP Claude model choice performs no capability probe or process dispatch',async()=>{
 let probes=0,spawns=0;
 const f=await fixture({kind:'claude-code',driverFactory:options=>createClaudeCodeDriver({...options,
  readCommand:async()=>{probes++;throw Error('No probe after decline');},spawnProcess:()=>{spawns++;throw Error('No model process');}})});
 try{
  const result=await f.invoke('galaxy_watch_host_activate',{id:f.id,model:'explicit-user-model'});
  assert.equal(result.state,'declined');assert.equal(f.constructors.length,0);assert.equal(probes,0);assert.equal(spawns,0);
 }finally{await f.server.close();}
});
