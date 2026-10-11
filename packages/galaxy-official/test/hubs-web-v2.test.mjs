import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createApi} from '../src/http.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {createHubsWebClient} from '../../galaxy-web/src/hubs-client.mjs';
import {builderDeclaration} from './builders-workflow.mjs';
import {sampleCharter} from './hubs-workflow.mjs';
test('Hub browser actual local signatures recover lost Charter and peering ACKs without new choices or duplicate writes',async()=>{
  const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000});
  let runtime,drop='',posts=0;
  try{await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const origin=`http://127.0.0.1:${api.address().port}`,data=new Map();
    runtime=await createWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{now:()=>f.now,
      store:{get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),update:async(k,change)=>{const next=change(structuredClone(data.get(k)??null));data.set(k,structuredClone(next));return structuredClone(next);}},fetch:async(url,input)=>{
        const path=new URL(url).pathname;if(path==='/v2/hubs/events'||path==='/v2/hubs/peering/events')posts++;
        const res=await fetch(origin+path,input);if(drop===path){drop='';assert.equal(res.status,200);throw Error('synthetic lost Hub ACK');}return res;}});
    await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});const subjectId=(await runtime.status()).identity.subjectId;
    let client=createHubsWebClient(runtime,{subjectId});const hubId=randomUUID(),decl={id:randomUUID(),builderId:hubId,kind:'declare',expectedRevision:0,
      declaration:{...builderDeclaration('hub',subjectId),endpoint:f.access.endpoint}};
    const signed=await runtime.api.authorizePayload(JSON.stringify(decl),{action:'builder.publish',objectId:decl.id,visibility:'Public',confirmed:true});await runtime.api.call('/v1/builders/events',signed);
    const b=await client.builder(hubId),charter={schemaVersion:2,id:randomUUID(),hubId,kind:'charter',expectedVersion:0,declarationId:b.declarationId,declarationHash:b.declarationHash,charter:sampleCharter(f.now)};
    drop='/v2/hubs/events';await assert.rejects(client.submit(charter,{visibility:'Public',confirmed:true}),/lost Hub ACK/);
    assert.equal((await client.local()).pending.event.id,charter.id);client=createHubsWebClient(runtime,{subjectId});const count=posts;
    assert.equal((await client.reconcile()).state,'recorded');assert.equal(posts,count);assert.equal((await client.local()).pending,null);
    assert.equal((await client.manage({hubId})).latestVersion,1);assert.equal((await client.read({hubId},true)).charter.name,charter.charter.name);
    const local=(await client.peering('party',{hubId})).party,remote={...local,endpoint:'https://peer.example',hubId:randomUUID()};
    const agreement={profile:'galaxy-direct-proof/1',id:randomUUID(),version:1,parties:[local,remote].sort((a,b)=>a.endpoint.localeCompare(b.endpoint)),sourceKinds:['contribution-summary'],purpose:'help-discovery',
      ratePerMinute:10,pageSize:5,expiresAt:f.now+500,responseMaxAgeSeconds:120,cache:'no-response-body-retention',route:'direct',officialProtocolFee:0,
      localEvaluationAuthority:'no-automatic-capability-upgrade',rawTaskContext:'excluded',intake:'each-party-hub-private-intake'};
    const approval={schemaVersion:2,id:randomUUID(),hubId,kind:'peer-approve',expectedVersion:0,agreement};drop='/v2/hubs/peering/events';
    await assert.rejects(client.submit(approval,{family:'peering',confirmed:true}),/lost Hub ACK/);assert.equal((await client.local()).pending.family,'peering');
    const peeringPosts=posts;client=createHubsWebClient(runtime,{subjectId});assert.equal((await client.reconcile()).state,'recorded');assert.equal(posts,peeringPosts);
    assert.equal((await client.peering('connections',{hubId})).items[0].agreementId,agreement.id);
    runtime.api.disconnect();await assert.rejects(client.local(),/身份或连接/);
  }finally{runtime?.close();api.closeAllConnections();await new Promise(ok=>api.close(ok));await f.db.close();}
});
