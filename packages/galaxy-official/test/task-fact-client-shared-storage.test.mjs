import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from "../src/shared/web-primitives.mjs";
import { getFactClient } from "../../galaxy-web/src/features/work-records/client.mjs";
import { factContinuityFixture, deferred, outcome } from "./task-fact-client-continuity-workflow.mjs";

const subjectId='GUID'+'A'.repeat(28), endpoint='https://fictional.invalid';
const fields=()=>({kind:'evidence',expectedVersion:0,evidenceType:'self-assertion',synthetic:true,
  source:{originSystem:'fictional-shared-storage',externalStableId:randomUUID(),contentVersion:'1',
    originalAt:new Date().toISOString(),issuer:'FICTIONAL source'},
  observedAt:new Date().toISOString(),reportedSourceState:'available',summary:'PRIVATE FICTIONAL shared store'});

function sharedFixture(){
  const task={taskId:randomUUID(),caseId:randomUUID()},data=new Map(),accepted=new Map();
  let pauseRead=null;
  const runtime=label=>{
    const binding={subjectId,endpoint,bindingId:randomUUID(),generation:1};
    return {
      api:{endpoint,snapshot:()=>binding,
        prepareAuthorization:async(payloadJson,options)=>({payloadJson,intent:{...options,subjectId,endpoint,
          bindingId:binding.bindingId,expiresAt:Math.floor(Date.now()/1000)+3600,payloadHash:await sha256Hex(payloadJson)}}),
        submitAuthorization:async authorization=>({payloadJson:authorization.payloadJson,consentId:randomUUID()}),
        call:async(path,input)=>{
          if(path==='/v2/verification-records/submit'){
            const payload=JSON.parse(input.payloadJson),hash=await sha256Hex(input.payloadJson);
            accepted.set(payload.operationId,{payload,hash});
            throw Error('FICTIONAL lost ACK after acceptance');
          }
          assert.equal(path,'/v2/verification-records/receipt');
          const original=accepted.get(input.operationId);assert.ok(original);assert.equal(input.payloadHash,original.hash);
          return {...input,state:'acknowledged',authority:'accepted-operation-only',audience:'owner-only',
            currentAccessGranted:false,contentReturned:false,sourceAccessChecked:false,
            receipt:{...input,version:1,acceptedAt:new Date().toISOString()}};
        }},
      getLocal:async key=>{
        const value=structuredClone(data.get(key));
        if(pauseRead?.label===label&&key.startsWith('task-fact-pending:')){
          const selected=pauseRead;
          if(selected.skip-->0)return value;
          pauseRead=null;selected.entered.resolve();await selected.release.promise;
        }
        return value;
      },
      putLocal:async(key,value)=>{data.set(key,structuredClone(value));},
      updateLocal:async(key,fn)=>{
        const next=fn(structuredClone(data.get(key)));data.set(key,structuredClone(next));
        // A real IDB update commits before its completion promise returns.
        // A replacement can then be saved while the old completion is delayed.
        if(pauseRead?.label===label&&key.startsWith('task-fact-pending:')&&pauseRead.skip===0){
          const selected=pauseRead;pauseRead=null;selected.entered.resolve();await selected.release.promise;
        }
        return structuredClone(next);
      },
    };
  };
  const a=runtime('a'),b=runtime('b');
  return {task,a:getFactClient(a,subjectId),b:getFactClient(b,subjectId),
    pending:()=>structuredClone(data.get(`task-fact-pending:${subjectId}:${task.taskId}`)),acceptedCount:()=>accepted.size,
    pauseARead:()=>{const selected={label:'a',skip:1,entered:deferred(),release:deferred()};pauseRead=selected;return selected;}};
}

test('a stale original ACK cannot erase a newer pending operation from another client sharing the store',async()=>{
  // Minimal shared storage contract: each read snapshots its result before
  // completion, as an independent IDB readonly transaction can. No browser,
  // signatures or HTTP proof is claimed by this controlled API fixture.
  const f=sharedFixture();
  await assert.rejects(f.a.submitRecord(f.task,{synthetic:true},null,fields(),{confirmed:true}),e=>e.resultUnknown===true);
  const original=f.pending(),paused=f.pauseARead();
  // The terminal-clear read snapshots the original slot before the second
  // client settles it; the eventual clear must compare the actual current slot.
  const first=outcome(f.a.reconcile(f.task.taskId));await paused.entered.promise;
  assert.equal((await f.b.reconcile(f.task.taskId)).state,'acknowledged');
  await assert.rejects(f.b.submitRecord(f.task,{synthetic:true},null,fields(),{confirmed:true}),e=>e.resultUnknown===true);
  const replacement=f.pending();assert.notEqual(replacement.operationId,original.operationId);
  paused.release.resolve();const settled=await first;assert.equal(settled.value?.state,'acknowledged');
  const retained=f.pending();assert.equal(retained?.operationId,replacement.operationId);
  assert.equal(retained.payloadHash,replacement.payloadHash);assert.equal(retained.items[0].payloadJson,replacement.items[0].payloadJson);
});

test('two clients cannot claim different operations in the same previously empty shared pending slot',async()=>{
  const f=sharedFixture();
  const outcomes=await Promise.allSettled([f.a.submitRecord(f.task,{synthetic:true},null,fields(),{confirmed:true}),
    f.b.submitRecord(f.task,{synthetic:true},null,fields(),{confirmed:true})]);
  assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.resultUnknown===true).length,1);
  assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.code==='fact_pending').length,1);
  assert.equal(f.acceptedCount(),1);assert.ok(f.pending()?.operationId);
});

test('a real WebRuntime late accepted ACK is stored under its original owner namespace after identity replacement',async()=>{
  const h=await factContinuityFixture();try{
    const task=await h.seedTask(),writes=[];let switched=false;
    h.onPut((key,value)=>writes.push({key,value:structuredClone(value)}));
    const wrapped={...h.runtime,api:{...h.runtime.api,call:async(...args)=>{
      const value=await h.runtime.api.call(...args);
      if(args[0]==='/v2/verification-records/submit'&&!switched){switched=true;await h.switchOwner();}
      return value;
    }}};
    const client=getFactClient(wrapped,h.subjectId);
    await assert.rejects(client.submitRecord(task,{synthetic:true},null,h.fields(),{confirmed:true}),e=>e.code==='fact_authority_changed');
    assert.ok(switched);const current=h.runtime.api.snapshot().subjectId;assert.notEqual(current,h.subjectId);
    const receiptWrites=writes.filter(row=>row.key.includes('task-fact-receipts:')&&row.value?.some(r=>r.kind==='verification'));
    assert.equal(receiptWrites.length,1);
    assert.equal(receiptWrites[0].key,`galaxy-web:${h.runtime.api.endpoint}:${h.subjectId}:task-fact-receipts:${h.subjectId}:${task.taskId}`);
    assert.equal(JSON.stringify(receiptWrites[0].value).includes('payloadJson'),false);
    assert.equal(JSON.stringify(receiptWrites[0].value).includes('PRIVATE FICTIONAL'),false);
  }finally{await h.close();}
});
