import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createBrowserClient} from '../src/browser-client.mjs';
import {digest} from '../src/shared/digest.mjs';

test('Native event fetch pins authority, keeps bearer private, separates Cookie and fences disconnect during stream',async()=>{
 const f=await serviceFixture(['binding']),sent=[];
 let browser,stream;
 try{
  const publicKeyPem=f.genesis.genesisProof.publicKeyPem,deviceId=randomUUID();
  const request={version:2,kind:'bootstrap',operationId:randomUUID(),subjectId:f.actor.subjectId,expectedEpoch:0,previousEventHash:null,
   signerKeyId:digest(publicKeyPem),genesisProof:f.genesis.genesisProof,newDevice:{deviceId,publicKeyPem,scopes:['manage-identity','binding']}};
  const challenge=await f.identityControl.challenge(request),signature=await f.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws');
  await f.identityControl.commit({operationId:request.operationId,controllerSignature:signature,newDeviceProof:signature});
  const fetcher=async(url,init)=>{
   const path=new URL(url).pathname;sent.push(path);
   if(path==='/v1/web-events'){
    assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
    const actor=await f.access.authenticate(init.headers.Authorization.slice(7));assert.equal(actor.subjectId,f.actor.subjectId);
    return new Response(new ReadableStream({start(controller){stream=controller;}}),{headers:{'Content-Type':'text/event-stream'}});
   }
   const input=JSON.parse(init.body);
   const result=path==='/v2/binding-challenges'?await f.bindings.challengeV2(input):path==='/v1/bindings'?await f.bindings.bind(input)
    :path==='/v1/session-challenges'?await f.access.challenge(input):await f.access.activate(input);
   return Response.json(result);
  };
  browser=createBrowserClient({endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys,fetch:fetcher,sign:f.signForTest,now:()=>f.now});
  for(const url of ['https://elsewhere.invalid/v1/web-events',f.bindings.endpoint+'/v1/operations/web-events',f.bindings.endpoint+'/v1/web-events?token=forbidden'])await assert.rejects(browser.eventFetch(url),/Invalid browser event/);
  assert.equal(sent.length,0);
  await browser.connect({subjectId:f.actor.subjectId,genesisProof:f.genesis.genesisProof,installationId:randomUUID(),scopes:['binding'],control:{deviceId,keyId:digest(publicKeyPem),epoch:1}},{confirmed:true});
  assert.equal(Object.hasOwn(browser.snapshot(),'credential'),false);
  const response=await browser.eventFetch(f.bindings.endpoint+'/v1/web-events?cursor=0&topics=tasks');
  const reader=response.body.getReader();stream.enqueue(new TextEncoder().encode('data: {}\n\n'));
  assert.equal((await reader.read()).done,false);
  browser.disconnect();stream.enqueue(new TextEncoder().encode('data: {}\n\n'));
  await assert.rejects(reader.read(),/Authorization changed|abort/i);
  await assert.rejects(browser.eventFetch(f.bindings.endpoint+'/v1/web-events'),{code:'connection_required'});
 }finally{browser?.close();await f.db.close();}
});
