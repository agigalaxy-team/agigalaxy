import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {seedExistingWebIdentity} from './existing-web-identity-fixture.mjs';

test('HTTP connection waits for a near-future signed second without extending expiry or duplicating binding',async()=>{
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000});
 let runtime,clock=f.now,waits=0,bindings=0,shortChallenge=false,cancelWait=false;
 const values=new Map(),store={get:async k=>structuredClone(values.get(k)),put:async(k,v)=>values.set(k,structuredClone(v)),update:memoryAtomicUpdate(values)};
 try{
  await new Promise(r=>api.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${api.address().port}`;
  const fetcher=async(url,options)=>{
   const path=new URL(url).pathname,response=await fetch(origin+path,options);
   if(path==='/v1/bindings')bindings++;
   if(shortChallenge&&path==='/v2/binding-challenges'&&response.ok){
    const document=await response.json(),payload=JSON.parse(Buffer.from(document.challenge.split('.')[1],'base64url').toString());
    document.challenge=await f.bindings.sign('binding-challenge',payload.data,payload.jti,1);
    return new Response(JSON.stringify(document),{status:200,headers:{'content-type':'application/json'}});
   }
   return response;
  };
  await seedExistingWebIdentity({endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys},{store,fetch:fetcher,now:()=>clock});
  runtime=await createWebRuntime({endpoint:f.bindings.endpoint,trustedKeys:new Map([...f.bindings.trustedKeys].map(([id,key])=>[id,{...key,notBefore:f.now-30}]))},
   {store,fetch:fetcher,now:()=>clock,waitForClock:async(milliseconds,signal)=>{
    waits++;assert.ok(milliseconds<=2025);if(cancelWait){runtime.disconnect();signal.throwIfAborted();}
    clock+=Math.ceil(milliseconds/1000);
   }});
  clock=f.now-1;
  await runtime.connect({confirmed:true});assert.equal(waits,1);assert.equal(bindings,1);assert.ok(runtime.api.snapshot());
  await runtime.disconnect();clock=f.now-3;
  await assert.rejects(runtime.connect({confirmed:true}),e=>e.code==='ERR_JWT_CLAIM_VALIDATION_FAILED'&&e.claim==='nbf');
  assert.equal(waits,1);assert.equal(bindings,1,'larger clock error never reaches another binding');
  clock=f.now-1;shortChallenge=true;
  await assert.rejects(runtime.connect({confirmed:true}),e=>e.code==='ERR_JWT_EXPIRED');
  assert.equal(waits,2);assert.equal(bindings,1);assert.equal(runtime.api.snapshot(),null);
  shortChallenge=false;clock=f.now-1;cancelWait=true;
  await assert.rejects(runtime.connect({confirmed:true}),e=>e.name==='AbortError');
  assert.equal(bindings,1);assert.equal(runtime.api.snapshot(),null);
 }finally{runtime?.close();await new Promise(r=>api.close(r));await f.db.close();}
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
