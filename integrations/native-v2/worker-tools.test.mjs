import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { workerToolsFixture } from './worker-tools-fixture.mjs';
import { registerNativeWorkerTools } from './worker-tools.mjs';

const execute = p => ({ handle:p.handle,previewHash:p.previewHash });
const start = async (x,values,purpose='Explicit synthetic arithmetic choice') => ({ action:'start',...await x.fact(purpose),text:JSON.stringify({operation:'sum',values}) });
const useWriteCount = x => x.f.calls.filter(p=>p==='/v2/builders/pack-uses/events').length;
const resultCount = async x => Number((await x.f.f.db.query("SELECT count(*) FROM case_events WHERE kind='result-recorded'")).rows[0].count);

test('ordinary MCP actual review dispatches the original Worker once, separates Result/PackUse and reconciles exact lost ACKs',{timeout:60000},async t=>{
  const x=await workerToolsFixture();try{
    const listed=await x.sdk.listTools();assert.deepEqual(listed.tools.map(v=>v.name).sort(),[
      'galaxy_worker_host_read','galaxy_worker_host_prepare','galaxy_worker_host_execute','galaxy_worker_host_abort_local'].sort());
    assert.equal((await x.call('galaxy_worker_host_read',{action:'list'})).associations.length,0);
    assert.equal((await x.processWorker.observations()).starts,0);
    const input=await start(x,[19,23]),p=await x.prepare(input);
    assert.equal(p.exact.payload.text,input.text);assert.equal(p.exact.payloadJson,JSON.stringify(p.exact.payload));
    assert.equal(p.payloadHash,createHash('sha256').update(p.exact.payloadJson).digest('hex'));
    assert.equal(p.visibility,'selected-peer');assert.deepEqual(p.recipients,['local-owner']);assert.ok(p.exact.externalEndpoint.startsWith('https://'));
    assert.deepEqual(p.configuration,{id:x.config.id,version:1});assert.equal(p.sourceHash,x.processWorker.sourceHash);
    assert.equal((await x.raw('galaxy_worker_host_execute',{...execute(p),confirmed:true})).isError,true);
    const declined=await x.choose(p,'decline');assert.equal(declined.state,'declined');assert.equal((await x.processWorker.observations()).starts,0);
    await x.call('galaxy_worker_host_abort_local',{handle:p.handle});
    const fresh=await x.prepare(input),sent=await x.choose(fresh);
    assert.equal(sent.actionResult.result.peer.state,'completed');assert.ok(JSON.stringify(sent).includes('42'));
    const replay=await x.call('galaxy_worker_host_execute',execute(fresh));assert.equal(replay.actionResult.state,'completed');
    assert.equal((await x.processWorker.observations()).starts,1);assert.equal(await resultCount(x),0);assert.equal(useWriteCount(x),0);
    const rp=await x.prepare({action:'result',associationId:fresh.associationId,summary:'Actual reference output 42; synthetic inputs',reportedOutcome:'succeeded'});
    assert.equal(rp.visibility,'Private');assert.deepEqual(rp.recipients,[]);assert.equal(rp.exact.authorization.payloadJson,rp.exact.payloadJson);
    x.controls.loseResultAck=true;await assert.rejects(x.choose(rp),/lost Result ACK/);assert.equal(await resultCount(x),1);
    const unknown=await x.call('galaxy_worker_host_execute',execute(rp));assert.equal(unknown.actionResult.state,'original-operation-needs-reconciliation');assert.equal(await resultCount(x),1);
    await x.f.connect();const current=await x.call('galaxy_worker_host_read',{action:'get',associationId:fresh.associationId});
    assert.equal(current.selected.peer.resultImportV2.state,'acknowledged');assert.equal(await resultCount(x),1,'ordinary read recovers the original Result without another write');
    const rr=await x.call('galaxy_worker_host_read',{action:'reconcile-result',associationId:fresh.associationId});
    assert.equal(rr.actionResult.result.state,'acknowledged');assert.equal(rr.actionResult.result.currentAccessGranted,false);
    const direct=await x.call('galaxy_worker_host_prepare',{action:'result',associationId:fresh.associationId,summary:'Cannot replace accepted content',reportedOutcome:'failed'});
    assert.equal(direct.actionResult.state,'acknowledged');assert.equal(direct.preview,undefined);
    const up=await x.prepare({action:'use',associationId:fresh.associationId,visibility:'Private'});
    assert.equal(up.exact.payload.result.id,rp.operationId);assert.deepEqual(up.exact.payload.attempt,fresh.attempt);
    assert.equal(up.visibility,'Private');x.f.state.losePackUseAck=true;
    await assert.rejects(x.choose(up),/Pack use ACK lost/);assert.equal(useWriteCount(x),1);
    assert.equal((await x.call('galaxy_worker_host_execute',execute(up))).actionResult.state,'original-operation-needs-reconciliation');assert.equal(useWriteCount(x),1);
    assert.equal((await x.call('galaxy_worker_host_read',{action:'get',associationId:fresh.associationId})).selected.packUseReceipt.state,'acknowledged');
    const ur=await x.call('galaxy_worker_host_read',{action:'reconcile-use',associationId:fresh.associationId});
    assert.equal(ur.actionResult.result.state,'acknowledged');assert.equal(ur.actionResult.result.currentReadPermissionConfirmed,false);
    const already=await x.call('galaxy_worker_host_prepare',{action:'use',associationId:fresh.associationId,visibility:'Public'});
    assert.equal(already.actionResult.state,'acknowledged');assert.equal(already.preview,undefined);
    assert.equal((await x.processWorker.observations()).starts,1);assert.equal(useWriteCount(x),1);
    t.diagnostic('worker_native_tools_observed '+JSON.stringify({actualMcpSdk:true,actualReviewLoopback:true,actualPeerProcess:true,
      starts:1,resultWrites:1,packUseWrites:1,modelCalls:0,ordinaryExactReview:true,store:'Map',database:'PGlite',nativeLease:'contract fixture'}));
  }finally{await x.close();}
});

test('preview expiry, endpoint changes, a null connection ABA and close never create or assert remote cancellation',{timeout:60000},async()=>{
  let clock=Date.now(),readGate=false,entered,release;
  const x=await workerToolsFixture({now:()=>clock,flowTransform:flow=>({...flow,associations:async()=>{
    const value=await flow.associations();if(readGate){entered();await new Promise(r=>{release=r;});}return value;
  }})});
  try{
    const input=await start(x,[41,43]),expired=await x.prepare(input);clock+=300001;
    assert.equal((await x.raw('galaxy_worker_host_execute',execute(expired))).isError,true);assert.equal((await x.processWorker.observations()).starts,0);
    const endpoint=x.runtime.api.endpoint,p=await x.prepare(input);x.runtime.api={...x.runtime.api,endpoint:'https://another-worker-host.example'};
    assert.equal((await x.raw('galaxy_worker_host_execute',execute(p))).isError,true);assert.equal((await x.processWorker.observations()).starts,0);
    x.runtime.api={...x.runtime.api,endpoint};
    readGate=true;const reached=new Promise(r=>{entered=r;});const waiting=x.raw('galaxy_worker_host_read',{action:'list'});await reached;
    x.f.api.disconnect();await x.f.connect();x.f.api.disconnect();release();
    const late=await waiting;assert.equal(late.isError,true);assert.equal(JSON.stringify(late).includes(input.text),false);readGate=false;
    assert.equal((await x.raw('galaxy_worker_host_read',{action:'list'})).isError,true);await x.f.connect();
    const current=await x.prepare(input),before=(await x.call('galaxy_worker_host_read',{action:'list'})).ownerScope;
    assert.equal((await x.call('galaxy_worker_host_read',{action:'list'})).ownerScope,before,'ordinary refresh keeps current owner scope');
    await x.f.connect();assert.notEqual((await x.call('galaxy_worker_host_read',{action:'list'})).ownerScope,before);
    assert.equal((await x.raw('galaxy_worker_host_execute',execute(current))).isError,true);
    const latest=await x.prepare(input);
    await Promise.all([x.tools.close(),x.tools.close()]);assert.equal((await x.raw('galaxy_worker_host_execute',execute(latest))).isError,true);
    assert.equal((await x.processWorker.observations()).starts,0);assert.equal(x.processWorker.requests.filter(v=>v==='CancelTask').length,0);
  }finally{await x.close();}
});

test('null original PackUse preview is rebuilt only for review from the same authorized original payload/hash/disclosure, never widened',{timeout:60000},async()=>{
  const x=await workerToolsFixture();try{
    const p=await x.prepare(await start(x,[2,5])),sent=await x.choose(p);assert.equal(sent.actionResult.result.peer.state,'completed');
    const result=await x.prepare({action:'result',associationId:p.associationId,summary:'Synthetic reference actual output 7',reportedOutcome:'succeeded'});await x.choose(result);
    const original=await x.prepare({action:'use',associationId:p.associationId});x.f.state.failConsentBeforeCommit=true;
    await assert.rejects(x.choose(original),/Consent request failed/);assert.equal(useWriteCount(x),0);
    const retry=await x.prepare({action:'use',associationId:p.associationId,visibility:'Public'});
    assert.equal(retry.operationId,original.operationId);assert.equal(retry.payloadHash,original.payloadHash);
    assert.equal(retry.exact.payloadJson,original.exact.payloadJson);assert.equal(retry.visibility,'Private');assert.deepEqual(retry.recipients,[]);
    const accepted=await x.choose(retry);assert.equal(accepted.actionResult.result.state,'acknowledged');assert.equal(useWriteCount(x),1);
    await x.call('galaxy_worker_host_execute',execute(retry));assert.equal(useWriteCount(x),1);
  }finally{await x.close();}
});

test('actual peer CancelTask differs from local abort; unknown initial send stays original without another dispatch',{timeout:60000},async()=>{
  const x=await workerToolsFixture();try{
    const p=await x.prepare({...await start(x,[3,4]),text:JSON.stringify({operation:'sum',values:[3,4],delayMs:5000})});
    assert.equal((await x.choose(p)).actionResult.result.peer.state,'working');
    const cancel=await x.prepare({action:'cancel',associationId:p.associationId});
    const local=await x.call('galaxy_worker_host_abort_local',{handle:cancel.handle});assert.equal(local.actionResult.remoteCanceled,false);
    assert.equal(x.processWorker.requests.filter(v=>v==='CancelTask').length,0);
    const c=await x.prepare({action:'cancel',associationId:p.associationId});assert.equal((await x.choose(c)).actionResult.result.peer.state,'canceled');
    assert.equal((await x.processWorker.observations()).cancellations,1);
    const unknown=await x.prepare(await start(x,[11,13]));x.processWorker.state.loseSendAck=true;
    await assert.rejects(x.choose(unknown),/A2A_OUTCOME_UNKNOWN/);
    const calls=x.processWorker.requests.filter(v=>v==='SendMessage').length;
    const same=await x.call('galaxy_worker_host_execute',execute(unknown));assert.equal(same.actionResult.remoteResent,false);
    const read=await x.call('galaxy_worker_host_read',{action:'get',associationId:unknown.associationId});assert.equal(read.selected.peer.status,'unknown');
    assert.equal((await x.raw('galaxy_worker_host_read',{action:'poll',associationId:unknown.associationId})).isError,true);
    assert.equal(x.processWorker.requests.filter(v=>v==='SendMessage').length,calls);
    assert.equal((await x.processWorker.observations()).starts,2);
  }finally{await x.close();}
});

test('captured handle and all prepare/save/review awaits withhold late data after real same-GUID binding changes; null snapshots cannot run',{timeout:60000},async()=>{
  let block=false,entered,release;
  const x=await workerToolsFixture({reviewHook:async()=>{if(block){entered();await new Promise(r=>{release=r;});}}});
  try{
    const input=await start(x,[31,37],'Private late preview must not leak');
    const old=await x.prepare(input);await x.f.connect();
    const denied=await x.raw('galaxy_worker_host_execute',execute(old));assert.equal(denied.isError,true);assert.equal((await x.processWorker.observations()).starts,0);
    const changedHash=await x.raw('galaxy_worker_host_execute',{...execute(old),previewHash:'0'.repeat(64)});assert.equal(changedHash.isError,true);
    const p=await x.prepare(input);block=true;const reached=new Promise(r=>{entered=r;});
    const pending=x.raw('galaxy_worker_host_execute',execute(p));await reached;await x.f.connect();release();
    const late=await pending;assert.equal(late.isError,true);assert.equal(JSON.stringify(late).includes(input.text),false);block=false;
    assert.equal((await x.processWorker.observations()).starts,0);
    const save=await x.prepare(input);x.f.state.reconnectOnSave=true;
    await assert.rejects(x.choose(save),/worker_host_connection_changed/);
    assert.equal((await x.processWorker.observations()).starts,0);
    x.f.api.disconnect();const absent=await x.raw('galaxy_worker_host_read',{action:'list'});assert.equal(absent.isError,true);
    await x.f.connect();const renewed=await x.prepare(input);x.rotateReference();
    assert.equal((await x.raw('galaxy_worker_host_execute',execute(renewed))).isError,true);assert.equal((await x.processWorker.observations()).starts,0);
  }finally{await x.close();}
});

test('close waits for a truly dispatched peer response and retains its original journal without claiming CancelTask or returning late private output',{timeout:60000},async()=>{
  const x=await workerToolsFixture();let release;
  try{
    const p=await x.prepare(await start(x,[47,53],'Synthetic private close-boundary input'));
    let entered;const reached=new Promise(r=>{entered=r;});
    x.processWorker.state.afterResponse=async()=>{entered();await new Promise(r=>{release=r;});};
    const response=x.choose(p);await reached;
    let finished=false;const closing=x.tools.close().then(()=>{finished=true;});
    await new Promise(r=>setImmediate(r));assert.equal(finished,false,'close drains a tracked external operation rather than only its local preview');
    assert.equal((await x.processWorker.observations()).starts,1);
    release();release=null;await assert.rejects(response,/worker_host_connection_changed/);await closing;
    assert.equal(x.processWorker.requests.filter(v=>v==='SendMessage').length,1);
    assert.equal(x.processWorker.requests.filter(v=>v==='CancelTask').length,0);
    const retained=await x.a2a.read('reference','get',p.associationId);
    assert.equal(retained.id,p.associationId);assert.equal(retained.operations.length,1);
    assert.ok(['observed','unknown'].includes(retained.status));
    assert.equal((await x.raw('galaxy_worker_host_execute',execute(p))).isError,true);
  }finally{release?.();await x.close();}
});

test('concurrent prepares reserve the 128 slots through source awaits and release failed or receipt-only reservations',async t=>{
  // Deterministic capacity contract double. The separate SDK admission probe
  // exercises concurrent MCP requests; no Worker execution is claimed here.
  let clock=0,mode='prepared',prepareCalls=0,release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{entered=resolve;}),handlers=new Map();
  const subjectId='GUID'+'1'.repeat(28),bindingId=randomUUID(),caseId=randomUUID(),attemptId=randomUUID(),configuration={id:randomUUID(),version:1};
  const snapshot={subjectId,bindingId,generation:1};let configurationCalls=0;
  const runtime={api:{endpoint:'https://capacity.example',snapshot:()=>snapshot,call:async()=>{
    configurationCalls++;if(configurationCalls===128)entered();await gate;return {attempts:[{id:attemptId,version:1,configurationRef:configuration}]};}},
    receiptStatus:{captureLease:()=>({subjectId,deviceId:randomUUID(),endpoint:'https://capacity.example',bindingId,generation:1,assertCurrent:()=>{}})}};
  const flow={workers:()=>[{id:'capacity',version:'1',sourceHash:'1'.repeat(64)}],close:()=>{},abort:()=>{},prepareStart:async input=>{
    prepareCalls++;if(mode==='fail')throw Object.assign(new Error('synthetic_prepare_failed'),{code:'synthetic_prepare_failed'});
    if(mode==='ack')return {state:'acknowledged',receipt:{state:'accepted'}};
    const operationId=randomUUID();return {kind:'send',workerId:'capacity',caseId,attempt:{id:attemptId,version:1},pack:{id:randomUUID(),version:1},
      purpose:input.purpose,associationId:randomUUID(),preview:{operationId,payloadJson:JSON.stringify({operationId,text:input.text}),
        peerPrincipal:'capacity-peer',endpoint:'https://capacity-peer.example'}};}};
  const tools=registerNativeWorkerTools({registerTool:(name,_config,handler)=>handlers.set(name,handler)},
    {runtime,flow,now:()=>clock,review:async()=>{throw Error('No execution in admission test');}});
  const input={action:'start',workerId:'capacity',caseId,attemptId,attemptVersion:1,purpose:'Capacity contract only',text:'No real Worker/model invocation'};
  const prepare=()=>handlers.get('galaxy_worker_host_prepare')(input,{});let pending=[];
  try{
    pending=Array.from({length:129},prepare);await reached;
    assert.match(JSON.stringify(await pending[128]),/worker_preview_capacity/);
    assert.equal(prepareCalls,128);assert.equal(configurationCalls,128,'source/configuration waits continue to occupy admission slots');
    release();const prepared=await Promise.all(pending);assert.equal(prepared.filter(r=>!r.isError).length,128);
    assert.match(JSON.stringify(await prepare()),/worker_preview_capacity/,'completed preparation transfers the slot to its saved handle');
    clock=300001;mode='fail';const failed=await Promise.all(Array.from({length:129},prepare));
    assert.equal(failed.filter(r=>JSON.stringify(r).includes('synthetic_prepare_failed')).length,128);
    assert.equal(failed.filter(r=>JSON.stringify(r).includes('worker_preview_capacity')).length,1);
    mode='ack';for(let i=0;i<129;i++)assert.equal((await prepare()).structuredContent.actionResult.state,'acknowledged');
    mode='prepared';assert.ok((await prepare()).structuredContent.preview.handle,'failure and receipt-only preparation release their reservations');
    t.diagnostic('capacity contract: 128 reserved across source awaits; excess rejected; errors and existing receipts release reservations');
  }finally{release();await Promise.allSettled(pending);await tools.close();}
});

test('expired terminal handles release the 128 preview capacity while a running original and its journal remain retained',async t=>{
  // Capacity/lifecycle contract double only. The other tests exercise the real
  // SDK, native review and peer process; no business execution is claimed here.
  let clock=0,mode='completed',releaseRunning,enteredRunning;
  const handlers=new Map(),journal=new Map(),aborted=[];
  const subjectId='GUID'+'1'.repeat(28),bindingId=randomUUID(),configuration={id:randomUUID(),version:1};
  const snapshot={subjectId,bindingId,generation:1},caseId=randomUUID(),attemptId=randomUUID();
  const runtime={api:{endpoint:'https://capacity.example',snapshot:()=>snapshot,call:async()=>({attempts:[{id:attemptId,version:1,configurationRef:configuration}]})},
    receiptStatus:{captureLease:()=>({subjectId,deviceId:randomUUID(),endpoint:'https://capacity.example',bindingId,generation:1,assertCurrent:()=>{}})}};
  const flow={workers:()=>[{id:'capacity',version:'1',sourceHash:'1'.repeat(64)}],close:()=>{},
    prepareStart:async input=>{const operationId=randomUUID(),payload={operationId,text:input.text};return {kind:'send',workerId:'capacity',
      caseId,attempt:{id:attemptId,version:1},pack:{id:randomUUID(),version:1},purpose:input.purpose,associationId:randomUUID(),
      preview:{operationId,payloadJson:JSON.stringify(payload),peerPrincipal:'capacity-peer',endpoint:'https://capacity-peer.example'}};},
    abort:original=>{aborted.push(original.preview.operationId);return {localStopped:true,remoteCanceled:false};},
    execute:async original=>{const operationId=original.preview.operationId,state=mode;
      journal.set(operationId,{operationId,state:state==='unknown'?'unknown':'accepted'});
      if(state==='unknown')throw Object.assign(new Error('capacity_original_unknown'),{code:'capacity_original_unknown'});
      if(state==='running'){enteredRunning();await new Promise(resolve=>{releaseRunning=resolve;});}
      return {operationId,state:'accepted'};}};
  const tools=registerNativeWorkerTools({registerTool:(name,_config,handler)=>handlers.set(name,handler)},
    {runtime,flow,now:()=>clock,review:async(_name,_input,_context,run)=>({content:[{type:'text',text:JSON.stringify(await run())}]})});
  const call=(name,input)=>handlers.get(name)(input,{}),input={action:'start',workerId:'capacity',caseId,attemptId,attemptVersion:1,purpose:'Capacity contract only',text:'No real Worker/model invocation'};
  const preview=async()=>{const result=await call('galaxy_worker_host_prepare',input);assert.equal(result.isError,undefined,JSON.stringify(result));return result.structuredContent.preview;};
  const completed=[],stopped=[],unknown=[];
  try{
    for(let i=0;i<127;i++){
      const p=await preview();
      if(i%3===0){mode='completed';const result=await call('galaxy_worker_host_execute',execute(p));assert.equal(result.isError,undefined);completed.push(p);}
      else if(i%3===1){await call('galaxy_worker_host_abort_local',{handle:p.handle});stopped.push(p);}
      else{mode='unknown';assert.equal((await call('galaxy_worker_host_execute',execute(p))).isError,true);unknown.push(p);}
    }
    const running=await preview();mode='running';const reached=new Promise(resolve=>{enteredRunning=resolve;});
    const pending=call('galaxy_worker_host_execute',execute(running));await reached;
    assert.match(JSON.stringify(await call('galaxy_worker_host_prepare',input)),/worker_preview_capacity/);
    const originalJournal=structuredClone([...journal]),originalAbortCount=aborted.length;
    clock=300001;
    await preview();
    assert.deepEqual([...journal],originalJournal,'pruning local handles never rewrites original accepted/unknown journals');
    assert.equal(aborted.length,originalAbortCount,'terminal handles are dropped without aborting their original operations');
    for(const p of [completed[0],stopped[0],unknown[0]])assert.match(JSON.stringify(await call('galaxy_worker_host_execute',execute(p))),/worker_preview_changed_or_expired/);
    assert.deepEqual([...journal],originalJournal,'expired handles cannot resend');
    for(let i=0;i<126;i++)await preview();
    assert.match(JSON.stringify(await call('galaxy_worker_host_prepare',input)),/worker_preview_capacity/,'the expired running original still occupies its slot');
    releaseRunning();releaseRunning=null;assert.equal((await pending).isError,undefined);
    await preview();
    assert.match(JSON.stringify(await call('galaxy_worker_host_prepare',input)),/worker_preview_capacity/);
    assert.match(JSON.stringify(await call('galaxy_worker_host_execute',execute(running))),/worker_preview_changed_or_expired/);
    assert.deepEqual([...journal],originalJournal);
    t.diagnostic('capacity contract: 127 terminal handles reclaimed, running slot retained until settlement, original journal unchanged');
  }finally{releaseRunning?.();await tools.close();}
});
