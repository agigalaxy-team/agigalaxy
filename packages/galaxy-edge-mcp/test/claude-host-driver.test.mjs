import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createClaudeCodeDriver } from '../src/native-v2/host-adapters/claude-code.mjs';
import { createNativeWatch } from '../src/native-v2/watch/index.mjs';
import { createNativeWatchRuntime } from '../src/native-v2/watch/runtime.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const help=' --bare --restricted --safe-mode --tools --disallowedTools --strict-mcp-config --mcp-config --setting-sources --settings --disable-slash-commands --no-chrome --permission-mode --permission-prompts --no-session-persistence --session-id --replay-user-messages ';
// Official CLI NDJSON/control shapes; this protocol double does not call a
// provider, create a real Claude session, or claim actual OS cancellation.
function fixture({autoResult=false,interruptTerminal=true,profile=true,version='2.1.266',helpText=help,onInterrupt=()=>{},verifyReaderProfile=async()=>true}={}){
  const processes=[],probes=[],frames=[];
  const spawnProcess=(command,args,options)=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    const sessionId=args[args.indexOf('--session-id')+1];let closed=false,original;
    child.send=message=>child.stdout.write(JSON.stringify(message)+'\n');
    child.end=()=>{if(!closed){closed=true;child.emit('close',0,null);}};child.kill=()=>{child.end();return true;};
    child.stdin.on('finish',child.end);
    child.stdin.on('data',chunk=>{for(const line of String(chunk).trim().split('\n')){
      const message=JSON.parse(line);frames.push(message);
      if(message.type==='user'){
        original=message;
        child.send({type:'system',subtype:'init',session_id:sessionId,tools:profile?[]:['Read'],mcp_servers:[],permissionMode:'dontAsk'});
        child.send({...message,session_id:sessionId});
        if(autoResult)child.complete();
      }else if(message.type==='control_request'&&message.request.subtype==='interrupt'){
        onInterrupt();
        child.send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{}}});
        if(interruptTerminal)child.complete({terminal_reason:'aborted_streaming',result:undefined});
      }
    }});
    child.complete=(extra={})=>child.send({type:'result',subtype:'success',is_error:false,num_turns:1,terminal_reason:'completed',
      session_id:sessionId,uuid:randomUUID(),result:'scoped useful result',...extra});
    child.original=()=>original;
    processes.push({command,args,options,child});return child;
  };
  const driver=createClaudeCodeDriver({command:process.execPath,cwd:process.cwd(),spawnProcess,verifyReaderProfile,
    readCommand:async args=>{probes.push(args);return args[0]==='--version'?version+' (Claude Code)\n':helpText;},
    completionTimeoutMs:100,cancelTimeoutMs:15,closeTimeoutMs:15});
  const input={watchId:randomUUID(),work:{workId:randomUUID(),roomId:randomUUID(),items:[{messageId:randomUUID(),sequence:'1',text:'literal `$(not shell)` private scoped message'}]},
    purpose:'summarize authorized changes',model:'chosen-model',cwd:process.cwd(),scopeKey:'binding-1/grant-1'};
  return{driver,input,processes,probes,frames};
}

test('Claude capabilities are only version/help and cannot assert effective reader, real model catalog or persistent turn lookup',async()=>{
  const f=fixture();try{
    const caps=await f.driver.capabilities();assert.equal(caps.version,'2.1.266');assert.equal(caps.readerProfileDocumented,true);
    assert.equal(caps.readerConfigurationConfirmed,false);assert.equal(caps.modelCatalogAvailable,false);
    assert.equal(caps.originalTurnStatusQuery,'observed-local-terminal-only');assert.equal(caps.sessionPersistence,false);
    assert.deepEqual(f.probes,[['--version'],['--help']]);assert.equal(f.processes.length,0);
  }finally{await f.driver.close();}
});

test('Claude fixed no-tool profile sends only scoped stdin and waits for exact original replay/init/result, not assistant text or another session',async()=>{
  const f=fixture();let locator;
  try{
    const running=f.driver.run({...f.input,onState:async value=>{locator=value;assert.equal(f.processes.length,0);}});await tick();
    const {child,args,options}=f.processes[0];let done=false;void running.then(()=>done=true);
    assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(args[args.indexOf('--tools')+1],'');
    assert.equal(args[args.indexOf('--disallowedTools')+1],'*');assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
    assert.equal(args[args.indexOf('--setting-sources')+1],'');assert.equal(args[args.indexOf('--permission-mode')+1],'dontAsk');
    assert.equal(args[args.indexOf('--permission-prompts')+1],'none');assert.ok(args.includes('--bare')&&args.includes('--restricted')&&args.includes('--no-session-persistence'));
    assert.ok(!args.some(arg=>arg.includes('private scoped message')));assert.equal(child.original().uuid,f.input.work.workId);
    assert.equal(locator.turnId,f.input.work.workId);assert.equal(locator.threadId,child.original().session_id);
    child.send({type:'assistant',message:{content:[{type:'text',text:'not a completed result'},{type:'thinking',thinking:'hidden reasoning'}]}});
    child.complete({session_id:randomUUID()});child.complete({origin:{kind:'task-notification'}});await tick();assert.equal(done,false);
    child.complete();const result=await running;assert.equal(result.state,'completed');assert.equal(result.output,'scoped useful result');
    assert.equal(result.hostTurnAccepted,true);assert.equal(result.hostTurnDispatches,1);
    const receipt=await f.driver.reconcile(locator);assert.equal(receipt.state,'completed');assert.equal(receipt.bodyIncluded,false);assert.equal(receipt.output,undefined);
    assert.ok(!JSON.stringify(receipt).includes('private scoped message'));assert.equal(f.processes.length,1);
  }finally{await f.driver.close();}
});

test('Claude incomplete installed profile and lease replacement while persisting original locator dispatch zero processes',async()=>{
  const unsupported=fixture({helpText:help.replace('--restricted','')}),changed=fixture();let current=true;
  try{
    const failed=await unsupported.driver.run(unsupported.input);assert.equal(failed.reason,'host_reader_profile_unavailable');assert.equal(failed.foregroundFallback,true);assert.equal(unsupported.processes.length,0);
    const withheld=await changed.driver.run({...changed.input,isCurrent:()=>current,onState:async()=>{current=false;}});
    assert.equal(withheld.hostTurnDispatches,0);assert.equal(changed.processes.length,0);
    await assert.rejects(changed.driver.run({...changed.input,model:'--dangerously-skip-permissions'}),/host_run_scope_required/);
  }finally{await unsupported.driver.close();await changed.driver.close();}
});

test('Claude default unverified configuration and a lease changed during trusted verification dispatch zero prompts',async()=>{
  let current=true;
  const blocked=fixture({verifyReaderProfile:null}),changed=fixture({verifyReaderProfile:async profile=>{
    assert.equal(Object.isFrozen(profile.arguments),true);current=false;return true;
  }});
  try{
    const result=await blocked.driver.run(blocked.input);
    assert.equal(result.reason,'host_reader_configuration_unconfirmed');assert.equal(result.foregroundFallback,true);
    assert.equal(result.hostTurnDispatches,0);assert.equal(blocked.processes.length,0);
    assert.equal((await changed.driver.run({...changed.input,isCurrent:()=>current})).hostTurnDispatches,0);assert.equal(changed.processes.length,0);
  }finally{await blocked.driver.close();await changed.driver.close();}
});

test('Claude real Node NDJSON process confirms failed terminal and drains close without equating process kill to cancellation',async()=>{
  // Real local Node streams/process lifecycle; the program only speaks the
  // documented protocol shapes and never invokes Claude or a provider.
  const script=`const readline=require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line),send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
      if(m.type==='user'){
        send({type:'system',subtype:'init',session_id:m.session_id,tools:[],mcp_servers:[],permissionMode:'dontAsk'});
        send(m);send({type:'result',session_id:m.session_id,subtype:'error_during_execution',is_error:true,num_turns:1});
      }
    });`;
  let child;
  const f=fixture(),driver=createClaudeCodeDriver({command:process.execPath,cwd:process.cwd(),verifyReaderProfile:async()=>true,
    readCommand:async args=>args[0]==='--version'?'2.1.266 (Claude Code)':help,
    spawnProcess:(command,args,options)=>child=spawn(command,['-e',script,'--',...args],options),closeTimeoutMs:1000});
  try{
    const result=await driver.run(f.input);assert.equal(result.state,'failed');assert.equal(result.output,undefined);
    assert.equal(child.exitCode,0);assert.equal((await driver.reconcile(result)).state,'failed');
    await Promise.all([driver.close(),driver.close()]);assert.equal((await driver.run(f.input)).hostTurnDispatches,0);
  }finally{await driver.close();await f.driver.close();}
});

test('Claude unsafe actual init and a requested tool leave unknown, withhold all output and release only owned process',async()=>{
  const f=fixture({profile:false});try{
    const result=await f.driver.run(f.input);assert.equal(result.state,'unknown');assert.equal(result.reason,'host_reader_configuration_unconfirmed');assert.equal(result.output,undefined);
    const receipt=await f.driver.reconcile(result);assert.equal(receipt.state,'unknown');assert.equal(f.processes.length,1);
  }finally{await f.driver.close();}
  const g=fixture();try{
    const running=g.driver.run(g.input);await tick();const child=g.processes[0].child;
    child.send({type:'control_request',request_id:randomUUID(),request:{subtype:'can_use_tool',tool_name:'Read',input:{file_path:'untrusted'}}});
    assert.equal(g.frames.at(-1).response.subtype,'error');
    child.send({type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{}}]}});
    assert.equal((await running).state,'unknown');
  }finally{await g.driver.close();}
});

test('Claude interrupt confirmation requires exact aborted terminal; control ACK or killed process remains original unknown without retry',async()=>{
  const f=fixture(),g=fixture({interruptTerminal:false});try{
    const first=f.driver.run(f.input);await tick();const original=f.processes[0].child.original();
    const stale=await f.driver.cancel(f.input.watchId,{scopeKey:'other'});assert.equal(stale.state,'scope-mismatch');
    const cancelled=await f.driver.cancel(f.input.watchId,{scopeKey:f.input.scopeKey,threadId:original.session_id,turnId:original.uuid});
    assert.equal(cancelled.cancellationConfirmed,true);assert.equal(cancelled.executionEnded,true);assert.equal((await first).output,undefined);
    const unknown=g.driver.run(g.input);await tick();const reference=g.processes[0].child.original();
    const requested=await g.driver.cancel(g.input.watchId,{scopeKey:g.input.scopeKey});assert.equal(requested.cancellationConfirmed,false);assert.equal(requested.executionEnded,false);
    g.processes[0].child.kill();const result=await unknown;assert.equal(result.state,'unknown');
    const before=g.processes.length;assert.equal((await g.driver.reconcile({threadId:reference.session_id,turnId:reference.uuid})).state,'unknown');assert.equal(g.processes.length,before);
  }finally{await f.driver.close();await g.driver.close();}
});

test('Claude Watch completes then ACKs once; no-change checks call zero models and pause revokes Galaxy before interrupt',async()=>{
  let generation=1,revoked=false,cursor=0,time=1000;
  const f=fixture({onInterrupt:()=>assert.equal(revoked,true)});
  const records=new Map(),subjectId='GUID'+'A'.repeat(28),bindingId=randomUUID(),roomId=randomUUID(),grantId=randomUUID(),messageId=randomUUID();
  const secondRoomId=randomUUID(),secondGrantId=randomUUID(),thirdRoomId=randomUUID(),thirdGrantId=randomUUID();
  const grants=new Map([[roomId,grantId],[secondRoomId,secondGrantId],[thirdRoomId,thirdGrantId]]),revokedGrants=new Set();
  const snapshot=()=>({subjectId,endpoint:'https://synthetic.example',bindingId,generation});
  const store={get:async key=>structuredClone(records.get(key)),update:async(key,change)=>{records.set(key,structuredClone(change(structuredClone(records.get(key)))));}};
  const api={endpoint:'https://synthetic.example',snapshot,async call(path,input){
    const room=path.split('/')[4],grant=grants.get(room);
    if(path.endsWith('agent-grants'))return{items:revokedGrants.has(grant)?[]:[{grantId:grant,bindingId,state:'active',expiresAt:100000}]};
    if(path.endsWith('history'))return{messages:input.after==='0'?[{messageId,sequence:'1',subjectId:'other',state:'accepted',text:'authorized shared input'}]:[],scannedThrough:'1',complete:true};
    if(path.endsWith('cursor')){cursor++;return{kind:'agent',agentGrantId:input.agentGrantId,sequence:input.sequence};}
    if(path.endsWith('agent-revoke')){revoked=true;revokedGrants.add(input.agentGrantId);return{revoked:true};}throw Error('unexpected API');}};
  const watch=createNativeWatch({store,api,subjectId,now:()=>time}),runtime=createNativeWatchRuntime({watch,hostDriver:f.driver,getHostLease:snapshot,now:()=>time,
    schedule:(fn,delay)=>({fn,delay}),cancelSchedule:()=>{}});
  try{
    const started=await watch.start({roomId,agentGrantId:grantId,purpose:'explicit scoped room',expiresAt:10000},{confirmed:true}),id=started.items[0].id;
    await runtime.activate(id,{host:{model:'chosen-model',cwd:process.cwd()},confirmed:true,checkNow:false});
    const checking=runtime.check(id);await tick();f.processes[0].child.complete();assert.equal((await checking).state,'processed');assert.equal(cursor,1);
    time+=900;assert.equal((await runtime.check(id)).state,'unchanged');assert.equal(f.processes.length,1);
    // A second watch uses a separate exact original run. Its owner change
    // suppresses output and cannot ACK a result on the replacement binding.
    const second=await watch.start({roomId:secondRoomId,agentGrantId:secondGrantId,purpose:'second explicit read',expiresAt:10000},{confirmed:true}),secondId=second.items[0].id;
    await runtime.activate(secondId,{host:{model:'chosen-model',cwd:process.cwd()},confirmed:true,checkNow:false});
    const inFlight=runtime.check(secondId);await tick();generation++;f.processes[1].child.complete();
    assert.equal((await inFlight).workSuppressed,true);assert.equal(cursor,1);
    const third=await watch.start({roomId:thirdRoomId,agentGrantId:thirdGrantId,purpose:'explicit pause check',expiresAt:10000},{confirmed:true}),thirdId=third.items[0].id;
    await runtime.activate(thirdId,{host:{model:'chosen-model',cwd:process.cwd()},confirmed:true,checkNow:false});
    const pausedWork=runtime.check(thirdId);await tick();const paused=await runtime.pause(thirdId);
    assert.equal(paused.remoteGrantRevoked,true);assert.equal(paused.hostCancellation.cancellationConfirmed,true);
    assert.equal((await pausedWork).workSuppressed,true);assert.equal(cursor,1);
    assert.equal((await watch.status(thirdId)).items[0].state,'paused');
    assert.ok(!JSON.stringify([...records.values()]).includes('authorized shared input'));
  }finally{await runtime.dispose();}
});
