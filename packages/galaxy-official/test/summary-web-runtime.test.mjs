import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getSummaryRuntime,closeSummaryRuntime} from '../../galaxy-web/src/summary-runtime.mjs';
test('unknown cancellation retains a late-delivery locator and never crosses active identities',async()=>{
 const subjectId='GUID'+'A'.repeat(28),roomId=randomUUID(),shareId=randomUUID(),records=new Map(),data=new Map();let active=subjectId,late=false,calls=0;
 // Explicit local-store and API doubles isolate browser coordination. Actual
 // IndexedDB and authenticated HTTP each have separate recorded evidence.
 const runtime={api:{endpoint:'https://summary-ui.example.org',snapshot:()=>({subjectId:active,bindingId:'fixture',expiresAt:9000000000}),call:async path=>{
  calls++;if(path.endsWith('/retract')||!late)throw new Error('shared_summary_unavailable');return{shareId,roomId,state:'published'};}},
  status:async()=>({identity:{subjectId:active}}),getLocal:async key=>structuredClone(records.get(active+key)),putLocal:async(key,value)=>records.set(active+key,structuredClone(value))};
 const store={read:async key=>structuredClone(data.get(key)),update:async(key,fn)=>{const result=fn(structuredClone(data.get(key)));data.set(key,structuredClone(result));return structuredClone(result);},close(){}};
 const bridge=await getSummaryRuntime(runtime,subjectId,{openStore:async()=>store});
 try{await runtime.putLocal('summary-share:'+roomId,{roomId,shareId,phase:'pending'});
  const stopped=await bridge.cancelPending(roomId);assert.equal(stopped.localRetryStopped,true);assert.equal(stopped.serverRetractionConfirmed,false);
  assert.equal((await bridge.pending(roomId)).shareId,shareId);assert.equal((await bridge.pending(roomId)).canRetry,false);
  late=true;assert.equal((await bridge.reconcile(roomId)).state,'published');assert.equal(await runtime.getLocal('summary-share:'+roomId),null,'Actual late delivery is reconciled, not called cancelled');
  const before=calls;active='GUID'+'B'.repeat(28);await assert.rejects(bridge.cancelPending(roomId),/身份已改变/);assert.equal(calls,before);
 }finally{closeSummaryRuntime(runtime);}
});
