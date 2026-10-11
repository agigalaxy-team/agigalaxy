import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeWatch } from '../src/native-v2/watch.mjs';
import { createNativeWatchRuntime } from '../src/native-v2/watch-runtime.mjs';
import { createCodexAppServerDriver } from '../src/native-v2/host-adapters/codex-app-server.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function protocol() {
  const listeners = new Set(), disconnects = new Set(), calls = [];
  let thread = 0, turn = 0, current;
  const rpc = { calls, hook: null,
    subscribe(fn) { listeners.add(fn); }, onDisconnect(fn) { disconnects.add(fn); }, notify(method, params) { calls.push({ method, params }); },
    emit(state, ids = current) { for(const fn of listeners)fn({method:'turn/completed',params:{threadId:ids.threadId,turn:{id:ids.turnId,status:state,items:[{type:'agentMessage',text:'authorized result'},{type:'reasoning',text:'private reasoning'}]}}}); },
    async request(method, params) {
      calls.push({ method, params }); if(rpc.hook)await rpc.hook(method,params);
      if(method==='initialize')return {userAgent:'installed-test-protocol',platformFamily:'windows'};
      if(method==='model/list')return {data:[{id:'chosen',model:'user-selected-model'}]};
      if(method==='config/read')return {config:{web_search:'disabled',mcp_servers:{},features:Object.fromEntries(['shell_tool','unified_exec','view_image','code_mode','js_repl','apps','plugins','multi_agent'].map(name=>[name,false]))}};
      if(method==='thread/start')return {thread:{id:'thread-'+(++thread)}};
      if(method==='thread/resume')return {thread:{id:params.threadId}};
      if(method==='turn/start'){current={threadId:params.threadId,turnId:'turn-'+(++turn)};return {turn:{id:current.turnId,status:'inProgress'}};}
      if(method==='turn/interrupt'){rpc.emit('interrupted',{threadId:params.threadId,turnId:params.turnId});return {};}
      if(method==='thread/read')return {thread:{id:params.threadId,turns:[{id:current.turnId,status:rpc.readState??'completed',items:[{type:'agentMessage',text:'must not be exposed by receipt'}]}]}};
      throw Error('unexpected protocol method');
    }, async close() {for(const fn of disconnects)fn();} };
  return rpc;
}
function fixture() {
  let time=1000, generation=1, source=true, ackLost=false, revoke=false, runs=0, cursorCalls=0,failHistory=false,onUpdate=null;
  const subjectId='GUID'+'A'.repeat(28),roomId=randomUUID(),grantId=randomUUID(),bindingId=randomUUID(),records=new Map(),events=[];
  let liveGrantId=grantId;
  const snapshot=()=>({subjectId,endpoint:'https://synthetic.example',bindingId,generation});
  const store={get:async key=>structuredClone(records.get(key)),update:async(key,change)=>{records.set(key,structuredClone(change(structuredClone(records.get(key)))));if(onUpdate)await onUpdate(structuredClone(records.get(key)));}};
  const api={endpoint:'https://synthetic.example',snapshot,async call(path,input){events.push(path.split('/').at(-1));
    if(path.endsWith('agent-grants'))return {items:revoke?[]:[{grantId:liveGrantId,bindingId,state:'active',expiresAt:time+100000}]};
    if(path.endsWith('history')){if(failHistory)throw Error('transport unavailable');return {messages:source&&input.after==='0'?[{messageId:randomUUIDStable,sequence:'1',subjectId:'other',state:'accepted',text:'shared input'}]:[],scannedThrough:'1',complete:true};}
    if(path.endsWith('agent-revoke')){revoke=true;return {revoked:true};}
    if(path.endsWith('cursor')){cursorCalls++;if(ackLost){ackLost=false;throw Error('lost ACK');}return {kind:'agent',agentGrantId:liveGrantId,sequence:input.sequence};}
    throw Error('unexpected API path');}};
  const randomUUIDStable=randomUUID();
  const watch=createNativeWatch({store,api,subjectId,now:()=>time});
  const timers=[];
  const rpc=protocol(),baseDriver=createCodexAppServerDriver({rpc,completionTimeoutMs:100,cancelTimeoutMs:50});
  const driver={...baseDriver,run:input=>{runs++;return baseDriver.run(input);}};
  const runtime=createNativeWatchRuntime({watch,hostDriver:driver,getHostLease:snapshot,now:()=>time,
    schedule:(fn,delay)=>{const timer={fn,delay};timers.push(timer);return timer;},cancelSchedule:timer=>{timer.cancelled=true;}});
  return{watch,runtime,rpc,events,timers,records,driver,snapshot,roomId,grantId,
    configure:async()=>{const {items}=await watch.start({roomId,agentGrantId:grantId,purpose:'summarize relevant shared changes',expiresAt:time+86400},{confirmed:true});const id=items[0].id;await runtime.activate(id,{checkNow:false,host:{model:'user-selected-model',cwd:process.cwd()},confirmed:true});return id;},
    get runs(){return runs;},get cursorCalls(){return cursorCalls;},set ackLost(value){ackLost=value;},set source(value){source=value;},set failHistory(value){failHistory=value;},advance(seconds){time+=seconds;},reconnect(){generation++;},
    freshGrant(){revoke=false;liveGrantId=randomUUID();return liveGrantId;},onUpdate(fn){onUpdate=fn;}};
}

test('Codex driver requires exact turn completion, resumes only same scope, and exposes no reasoning',async()=>{
  const rpc=protocol(),driver=createCodexAppServerDriver({rpc});
  const input={watchId:'watch',work:{workId:randomUUID(),roomId:randomUUID(),items:[{messageId:randomUUID(),sequence:'1',text:'scope-only'}]},purpose:'review',model:'user-selected-model',cwd:process.cwd(),scopeKey:'lease-1'};
  try{
    const first=driver.run(input);await tick();let settled=false;void first.then(()=>settled=true);assert.equal(settled,false);
    rpc.emit('completed',{threadId:'unrelated-thread',turnId:'unrelated-turn'});await tick();assert.equal(settled,false);
    rpc.emit('completed');assert.equal((await first).output,'authorized result');
    const next=driver.run({...input,work:{...input.work,workId:randomUUID()}});await tick();rpc.emit('completed');await next;
    assert.equal(rpc.calls.filter(x=>x.method==='thread/resume').length,1);
    const changed=driver.run({...input,scopeKey:'lease-2'});await tick();rpc.emit('failed');assert.equal((await changed).state,'failed');
    assert.equal(rpc.calls.filter(x=>x.method==='thread/start').length,2);
    assert.equal(rpc.calls.find(x=>x.method==='turn/start').params.clientUserMessageId,input.work.workId);
    assert.deepEqual(rpc.calls.find(x=>x.method==='turn/start').params.sandboxPolicy,{type:'readOnly',networkAccess:false});
    assert.equal(rpc.calls.find(x=>x.method==='thread/start').params.config['features.shell_tool'],false);
  }finally{await driver.close();}
});

test('cancel waits for actual interrupted notification; read-only reconciliation never starts a new turn',async()=>{
  const rpc=protocol(),driver=createCodexAppServerDriver({rpc});
  const input={watchId:'watch',work:{workId:randomUUID(),roomId:randomUUID(),items:[]},purpose:'review',model:'user-selected-model',cwd:process.cwd()};
  const running=driver.run(input);await tick();const cancelled=await driver.cancel('watch');assert.equal(cancelled.cancellationConfirmed,true);assert.equal((await running).state,'interrupted');
  const before=rpc.calls.filter(x=>x.method==='turn/start').length;
  const result=await driver.reconcile({threadId:'thread-1',turnId:'turn-1'});assert.equal(result.state,'completed');assert.equal(result.output,undefined);
  assert.equal(rpc.calls.filter(x=>x.method==='turn/start').length,before);await driver.close();
});

test('Watch completed model work ACKs Agent cursor, lost ACK retries original only and no-change calls zero models',async()=>{
  const f=fixture(),id=await f.configure();f.ackLost=true;
  try{
    const checking=f.runtime.check(id);await tick();assert.equal(f.cursorCalls,0);assert.equal((await f.runtime.status(id)).items[0].modelRunning,true);f.rpc.emit('completed');
    const unknown=await checking;assert.equal(unknown.state,'host-completed-ack-unconfirmed');assert.equal(f.runs,1);
    const {items}=await f.watch.status(id),execution=items[0].pending.hostExecution;assert.equal(execution.state,'completed');assert.ok(execution.threadId&&execution.turnId);assert.ok(!JSON.stringify(execution).includes('shared input'));
    const retry=await f.runtime.check(id);assert.equal(retry.state,'processed');assert.equal(f.runs,1);assert.equal(f.cursorCalls,2);assert.equal(retry.receipt.humanRead,false);
    f.advance(900);const unchanged=await f.runtime.check(id);assert.equal(unchanged.state,'unchanged');assert.equal(f.runs,1);
    assert.equal(f.timers.at(-1).delay,900000);
  }finally{await f.runtime.dispose();}
});

for(const state of ['failed','interrupted'])test('Watch '+state+' never ACKs or automatically repeats the model',async()=>{
  const f=fixture(),id=await f.configure();try{const checking=f.runtime.check(id);await tick();f.rpc.emit(state);assert.equal((await checking).state,'host-result-pending');
    assert.equal((await f.runtime.check(id)).state,'host-result-pending');assert.equal(f.cursorCalls,0);assert.equal(f.runs,1);
  }finally{await f.runtime.dispose();}
});

test('pause revokes Galaxy before host cancel; later output suppressed and stopped intent not resumed',async()=>{
  const f=fixture(),id=await f.configure();try{
    const checking=f.runtime.check(id);await tick();f.rpc.hook=async method=>{if(method==='turn/interrupt')assert.equal(f.events.at(-1),'agent-revoke');};
    const paused=await f.runtime.pause(id);assert.equal(paused.remoteGrantRevoked,true);assert.equal(paused.hostCancellation.executionEnded,true);
    assert.equal((await checking).workSuppressed,true);assert.equal(f.cursorCalls,0);
    const row=(await f.watch.status(id)).items[0];assert.equal(row.state,'paused');assert.ok(row.lastHostExecution.threadId);assert.equal(row.lastHostExecution.localRetryStopped,true);
    assert.equal(row.lastHostExecution.cancellation.executionEnded,true);
    assert.equal(row.hostStopReceipts[row.lastHostExecution.workId].cancellation.state,'interrupted');
    assert.ok(!JSON.stringify(row.hostStopReceipts).includes('shared input'));
    await f.runtime.activate(id,{checkNow:false});assert.equal((await f.runtime.check(id)).state,'inactive');assert.equal(f.runs,1);
  }finally{await f.runtime.dispose();}
});

test('same owner replacement generation during model turn withholds result and does not ACK',async()=>{
  const f=fixture(),id=await f.configure();try{const checking=f.runtime.check(id);await tick();f.reconnect();f.rpc.emit('completed');
    const result=await checking;assert.equal(result.workSuppressed,true);assert.equal(result.output,undefined);assert.equal(f.cursorCalls,0);
    assert.equal((await f.runtime.check(id)).state,'binding-changed');assert.equal(f.runs,1);
  }finally{await f.runtime.dispose();}
});

test('source removal during inference prevents result exposure and cursor ACK',async()=>{
  const f=fixture(),id=await f.configure();try{const checking=f.runtime.check(id);await tick();f.source=false;f.rpc.emit('completed');
    const result=await checking;assert.equal(result.state,'host-completed-ack-unconfirmed');assert.equal(result.output,undefined);assert.equal(f.cursorCalls,0);
  }finally{await f.runtime.dispose();}
});

test('24-hour expiry prevents model dispatch and unconfirmed turn remains original unknown after timeout',async()=>{
  const f=fixture(),id=await f.configure();try{const checking=f.runtime.check(id);await tick();f.rpc.hook=async method=>{if(method==='turn/interrupt')throw Error('host offline');};
    assert.equal((await checking).execution.state,'unknown');assert.equal(f.runs,1);assert.equal(f.cursorCalls,0);
    const again=await f.runtime.check(id);assert.equal(again.state,'host-result-pending');assert.equal(f.runs,1);
    f.advance(86400);assert.equal((await f.runtime.check(id)).state,'inactive');assert.equal(f.runs,1);
  }finally{await f.runtime.dispose();}
});

test('unspecified Watch expires after 24 hours and transport retries back off to 30 minutes without model calls',async()=>{
  const f=fixture();
  const {items}=await f.watch.start({roomId:f.roomId,agentGrantId:f.grantId,purpose:'explicit room follow'},{confirmed:true});
  const id=items[0].id;assert.equal(items[0].expiresAt,1000+86400);
  await f.runtime.activate(id,{checkNow:false,host:{model:'user-selected-model',cwd:process.cwd()},confirmed:true});f.failHistory=true;
  try{for(const delay of [60,120,240,480,960,1800,1800]){
    await assert.rejects(f.runtime.check(id),/transport unavailable/);assert.equal(f.timers.at(-1).delay,delay*1000);f.advance(delay);
  }assert.equal(f.runs,0);assert.equal(f.cursorCalls,0);}finally{await f.runtime.dispose();}
});

test('host unknown reconciles exact original turn without inference and only then permits original ACK',async()=>{
  const f=fixture(),id=await f.configure();try{
    const checking=f.runtime.check(id);await tick();f.rpc.hook=async method=>{if(method==='turn/interrupt')throw Error('lost cancellation response');};
    assert.equal((await checking).execution.state,'unknown');assert.equal(f.cursorCalls,0);
    const receipt=await f.runtime.reconcileHost(id);assert.equal(receipt.state,'completed');assert.equal(receipt.bodyIncluded,false);assert.equal(f.runs,1);
    const ack=await f.runtime.check(id);assert.equal(ack.state,'processed');assert.equal(f.runs,1);assert.equal(f.cursorCalls,1);
    assert.equal(f.rpc.calls.filter(call=>call.method==='turn/start').length,1);
  }finally{await f.runtime.dispose();}
});

test('user selected unavailable model and lease replaced before dispatch never start a turn',async()=>{
  const rpc=protocol(),driver=createCodexAppServerDriver({rpc});let current=true;
  const input={watchId:'watch',work:{workId:randomUUID(),roomId:randomUUID(),items:[]},purpose:'review',model:'unavailable-model',cwd:process.cwd(),isCurrent:()=>current};
  assert.equal((await driver.run(input)).reason,'selected-model-unavailable');assert.equal(rpc.calls.filter(call=>call.method==='turn/start').length,0);
  rpc.hook=async method=>{if(method==='thread/start')current=false;};
  assert.equal((await driver.run({...input,model:'user-selected-model'})).state,'interrupted');assert.equal(rpc.calls.filter(call=>call.method==='turn/start').length,0);
  await driver.close();
});

test('explicit host choice upgrades an idle manual Watch and re-reads its pending authorized source',async()=>{
  const f=fixture();const {items}=await f.watch.start({roomId:f.roomId,agentGrantId:f.grantId,purpose:'explicit room follow'},{confirmed:true});
  const id=items[0].id;await f.runtime.activate(id,{checkNow:false});
  assert.equal((await f.runtime.check(id)).state,'work-ready');
  try{
    await f.runtime.activate(id,{checkNow:false,host:{model:'user-selected-model',cwd:process.cwd()},confirmed:true});
    const checking=f.runtime.check(id);await tick();f.rpc.emit('completed');
    assert.equal((await checking).state,'processed');assert.equal(f.runs,1);assert.equal(f.cursorCalls,1);
  }finally{await f.runtime.dispose();}
});

test('late cancellation for an old grant scope cannot interrupt a newly selected scope',async()=>{
  const rpc=protocol(),driver=createCodexAppServerDriver({rpc});
  const input={watchId:'watch',work:{workId:randomUUID(),roomId:randomUUID(),items:[]},purpose:'review',model:'user-selected-model',cwd:process.cwd(),scopeKey:'old-grant'};
  try{
    const old=driver.run(input);await tick();rpc.emit('completed');await old;
    const current=driver.run({...input,work:{...input.work,workId:randomUUID()},scopeKey:'new-grant'});await tick();
    const before=rpc.calls.filter(call=>call.method==='turn/interrupt').length;
    const stale=await driver.cancel('watch',{scopeKey:'old-grant'});
    assert.equal(rpc.calls.filter(call=>call.method==='turn/interrupt').length,before);
    assert.equal(stale.executionEnded,false);rpc.emit('completed');assert.equal((await current).state,'completed');
  }finally{await driver.close();}
});

test('stopped unconfirmed host cancellation retains original locator and later queries it without resuming or ACK',async()=>{
  const f=fixture(),id=await f.configure();try{
    const checking=f.runtime.check(id);await tick();f.rpc.hook=async method=>{if(method==='turn/interrupt')throw Error('host unavailable');};
    const stopped=await f.runtime.stop(id);assert.equal(stopped.hostCancellation.executionEnded,false);await checking;
    const unknownState=(await f.runtime.status(id)).items[0];assert.equal(unknownState.hostState,'not-running');assert.equal(unknownState.modelRunning,null);
    const row=(await f.watch.status(id)).items[0],workId=row.lastHostExecution.workId;
    assert.equal(row.hostStopReceipts[workId].cancellation.state,'unknown');
    f.reconnect();const before=f.rpc.calls.filter(call=>call.method==='turn/start').length;
    const receipt=await f.runtime.reconcileHost(id,{workId});assert.equal(receipt.state,'completed');assert.equal(receipt.bodyIncluded,false);
    assert.equal(f.rpc.calls.filter(call=>call.method==='turn/start').length,before);assert.equal(f.cursorCalls,0);assert.equal(f.runtime.isActive(id),false);
    assert.equal((await f.watch.status(id)).items[0].hostStopReceipts[workId].cancellation.executionEnded,true);
  }finally{await f.runtime.dispose();}
});

test('fresh driver cancels only the original journal turn and never opens a replacement inference',async()=>{
  const rpc=protocol(),original=createCodexAppServerDriver({rpc,completionTimeoutMs:20,cancelTimeoutMs:10});
  const input={watchId:'watch',work:{workId:randomUUID(),roomId:randomUUID(),items:[]},purpose:'review',model:'user-selected-model',cwd:process.cwd(),scopeKey:'exact-grant'};
  let fresh;
  try{
    rpc.hook=async method=>{if(method==='turn/interrupt')throw Error('lost cancellation');};
    const unknown=await original.run(input);assert.equal(unknown.state,'unknown');
    rpc.hook=null;rpc.readState='inProgress';fresh=createCodexAppServerDriver({rpc,cancelTimeoutMs:20});
    const result=await fresh.cancel('watch',{scopeKey:input.scopeKey,threadId:unknown.threadId,turnId:unknown.turnId});
    assert.equal(result.state,'interrupted');assert.equal(result.executionEnded,true);
    assert.equal(rpc.calls.filter(call=>call.method==='thread/start').length,1);assert.equal(rpc.calls.filter(call=>call.method==='turn/start').length,1);
    assert.deepEqual(rpc.calls.filter(call=>call.method==='turn/interrupt').at(-1).params,{threadId:unknown.threadId,turnId:unknown.turnId});
  }finally{await fresh?.close();await original.close();}
});

test('unconfirmed effective reader settings reject model work before thread or turn creation',async()=>{
  const rpc=protocol(),driver=createCodexAppServerDriver({rpc});
  const delegate=rpc.request.bind(rpc);
  rpc.request=async(method,params)=>method==='config/read'?{config:{features:{shell_tool:true},mcp_servers:{remote:{enabled:true}},web_search:'live'}}:delegate(method,params);
  try{
    const result=await driver.run({watchId:'watch',work:{workId:randomUUID(),roomId:randomUUID(),items:[]},purpose:'review',model:'user-selected-model',cwd:process.cwd(),scopeKey:'scope'});
    assert.equal(result.reason,'host_reader_configuration_unconfirmed');assert.equal(result.hostTurnDispatches,0);
    assert.equal(rpc.calls.filter(call=>call.method==='thread/start'||call.method==='turn/start').length,0);
  }finally{await driver.close();}
});

test('the 24-hour host deadline interrupts an in-progress original turn and retains exact cancellation without ACK',async()=>{
  const f=fixture(),id=await f.configure();try{
    const checking=f.runtime.check(id);await tick();f.advance(86400);
    const deadline=f.timers.find(timer=>timer.delay===86400000&&!timer.cancelled);assert.ok(deadline);deadline.fn();
    await tick();assert.equal((await checking).workSuppressed,true);assert.equal(f.cursorCalls,0);assert.equal(f.runs,1);
    const row=(await f.watch.status(id)).items[0];assert.equal(row.state,'expired');
    assert.equal(row.stopAuthorization.state,'revoked');assert.equal(row.lastHostExecution.cancellation.state,'interrupted');
    assert.equal(f.runtime.isActive(id),false);
  }finally{await f.runtime.dispose();}
});

test('a fresh grant explicitly resumed while old pause is returning keeps its new turn and permission',async()=>{
  const f=fixture(),id=await f.configure();let fresh=Promise.resolve({state:'not-started'});
  try{
    const old=f.runtime.check(id);await tick();
    f.onUpdate(async state=>{if(state.watches[id]?.stopAuthorization?.state==='revoked'){
      f.onUpdate(null);f.rpc.emit('completed');await old;
      const newGrantId=f.freshGrant();await f.watch.resume({id,agentGrantId:newGrantId,expiresAt:1000+86400},{confirmed:true});
      await f.runtime.activate(id,{checkNow:false,host:{model:'user-selected-model',cwd:process.cwd()},confirmed:true});
      fresh=f.runtime.check(id);await tick();
    }});
    const paused=await f.runtime.pause(id);assert.equal(paused.hostCancellation.state,'scope-mismatch');
    assert.equal(f.rpc.calls.filter(call=>call.method==='turn/interrupt').length,0);
    assert.equal((await f.watch.status(id)).items[0].state,'active');assert.equal((await f.runtime.status(id)).items[0].modelRunning,true);
    f.rpc.emit('completed');assert.equal((await fresh).state,'processed');assert.equal(f.runs,2);assert.equal(f.cursorCalls,1);
  }finally{f.onUpdate(null);await f.runtime.dispose();}
});

test('an old grant pause cannot revoke a newer stored grant and changed manual pending source cannot start inference',async()=>{
  const f=fixture();const {items}=await f.watch.start({roomId:f.roomId,agentGrantId:f.grantId,purpose:'explicit room follow'},{confirmed:true});
  const id=items[0].id;await f.runtime.activate(id,{checkNow:false});await f.runtime.check(id);
  try{
    f.source=false;await f.runtime.activate(id,{checkNow:false,host:{model:'user-selected-model',cwd:process.cwd()},confirmed:true});
    await assert.rejects(f.runtime.check(id),/watch_source_changed/);assert.equal(f.runs,0);
    const state=[...f.records.values()][0],current=state.watches[id];current.agentGrantId=f.freshGrant();
    await assert.rejects(f.watch.pause(id,{agentGrantId:f.grantId}),/watch_grant_changed/);
    assert.equal((await f.watch.status(id)).items[0].state,'active');assert.equal(f.events.filter(event=>event==='agent-revoke').length,0);
  }finally{await f.runtime.dispose();}
});

test('invalid MCP disable names are rejected before any host initialization',()=>{
  const rpc=protocol();
  for(const disabledMcpServers of [null,'server',[null],[''],['bad.name'],['bad name'],['server=true'],['server\n-c'],['"server"'],['x'.repeat(65)],['server','server'],Array(65).fill('server')]){
    assert.throws(()=>createCodexAppServerDriver({rpc,disabledMcpServers}),/host_mcp_disable_names_invalid/);
  }
  assert.equal(rpc.calls.length,0);
});

test('explicit MCP disable configuration is immutable and identical for thread start and resume; effective host settings still gate inference',async()=>{
  const rpc=protocol(),names=['one-server','two_server'],driver=createCodexAppServerDriver({rpc,disabledMcpServers:names});
  names[0]='later-config';names.push('another');
  const delegate=rpc.request.bind(rpc);let enabled=true;
  rpc.request=async(method,params)=>{
    const result=await delegate(method,params);
    if(method==='config/read')result.config.mcp_servers={'one-server':{enabled},two_server:{enabled:false}};
    return result;
  };
  const input={watchId:'watch',work:{workId:randomUUID(),roomId:randomUUID(),items:[]},purpose:'review',model:'user-selected-model',cwd:process.cwd(),scopeKey:'same-lease'};
  try{
    assert.equal((await driver.capabilities()).readerConfigurationConfirmed,false);
    assert.equal((await driver.run(input)).reason,'host_reader_configuration_unconfirmed');
    assert.equal(rpc.calls.filter(call=>call.method==='thread/start'||call.method==='turn/start').length,0);
    enabled=false;assert.equal((await driver.capabilities()).readerConfigurationConfirmed,true);
    for(let attempt=0;attempt<2;attempt++){
      const running=driver.run({...input,work:{...input.work,workId:randomUUID()}});await tick();rpc.emit('completed');assert.equal((await running).state,'completed');
    }
    const profiles=rpc.calls.filter(call=>call.method==='thread/start'||call.method==='thread/resume');
    assert.deepEqual(profiles.map(call=>call.method),['thread/start','thread/resume']);
    assert.deepEqual(profiles[0].params.config,profiles[1].params.config);
    for(const call of profiles){
      assert.equal(call.params.config['mcp_servers.one-server.enabled'],false);
      assert.equal(call.params.config['mcp_servers.two_server.enabled'],false);
      assert.equal(call.params.config['mcp_servers.later-config.enabled'],undefined);
      assert.equal(call.params.config['mcp_servers.another.enabled'],undefined);
      assert.deepEqual(call.params.config.mcp_servers,{});
    }
  }finally{await driver.close();}
});

test('fixed process MCP disable arguments are passed literally without a shell and handshake creates no thread or turn',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-host-disable-'));
  const file=join(directory,'app-server');
  let driver;
  try{
    await writeFile(file,`const readline=require('node:readline');const calls=[];
      const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{
        const m=JSON.parse(line);calls.push(m.method);if(m.id===undefined)return;
        let result;
        if(m.method==='initialize')result={userAgent:JSON.stringify(process.argv.slice(2)),platformFamily:'node-protocol-fixture'};
        else if(m.method==='model/list')result={data:[]};
        else if(m.method==='config/read')result={config:{features:Object.fromEntries(['shell_tool','unified_exec','view_image','code_mode','js_repl','apps','plugins','multi_agent'].map(name=>[name,false])),web_search:'disabled',mcp_servers:{'one-server':{enabled:false},two_server:{enabled:false}}}};
        else throw Error('Unexpected inference method');
        process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
      });`);
    driver=createCodexAppServerDriver({command:process.execPath,cwd:directory,disabledMcpServers:['one-server','two_server']});
    const capabilities=await driver.capabilities(),args=JSON.parse(capabilities.process.userAgent);
    assert.deepEqual(args.slice(0,3),['--stdio','-c','mcp_servers={}']);
    assert.deepEqual(args.slice(-4),['-c','mcp_servers.one-server.enabled=false','-c','mcp_servers.two_server.enabled=false']);
    assert.equal(capabilities.readerConfigurationConfirmed,true);
    assert.equal(capabilities.models.length,0);
  }finally{
    await driver?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+'/')||resolve(directory).startsWith(resolve(tmpdir())+'\\'));
    await rm(directory,{recursive:true,force:true});
  }
});
