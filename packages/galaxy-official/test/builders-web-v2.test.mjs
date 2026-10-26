import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createApi} from '../src/http.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import {createBuildersWebClient} from "../../galaxy-web/src/features/builders/builders-client.mjs";
import {builderDeclaration} from './builders-workflow.mjs';
import {supportFor,packFor} from './builder-support-v2-workflow.mjs';
test('Builder webpage actual device signatures reconcile a lost response without duplicate declaration or runtime work',async()=>{
  const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000});
  let runtime,drop=false;const sent=[];
  try{
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const address='http://127.0.0.1:'+api.address().port;
    const fetcher=async(url,options)=>{const path=new URL(url).pathname;
      if(path==='/v2/builders/support/events')sent.push(JSON.parse(options.body));
      const result=await fetch(address+path,options);if(drop&&path==='/v2/builders/support/events'){drop=false;throw new Error('synthetic lost response');}return result;};
    const data=new Map(),store={get:async key=>structuredClone(data.get(key)),put:async(key,value)=>data.set(key,structuredClone(value)),
      update:async(key,change)=>{const next=change(structuredClone(data.get(key)));if(next?.then)throw Error('local_update_async_callback');data.set(key,structuredClone(next));return structuredClone(next);}};
    runtime=await createExistingWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{store,fetch:fetcher,now:()=>f.now});
    await runtime.connect({confirmed:true});
    const subjectId=(await runtime.status()).identity.subjectId,client=createBuildersWebClient(runtime,{subjectId}),builderId=randomUUID();
    const declaration=builderDeclaration('worker',subjectId),initial={id:randomUUID(),kind:'declare',builderId,expectedRevision:0,declaration};
    await assert.rejects(client.submit(initial),/核对/);assert.equal((await client.local()).pending,null);
    await client.submit(initial,{confirmed:true,visibility:'Public'});const view=await client.read(builderId,true);
    const support={id:randomUUID(),kind:'support-profile',builderId,expectedRevision:view.entry.revision,
      declarationId:view.entry.declarationId,declarationHash:view.entry.declarationHash,support:supportFor(declaration)};
    drop=true;await assert.rejects(client.submit(support,{confirmed:true,visibility:'Public'}),/lost response/);
    const saved=(await client.local()).pending;assert.equal(saved.event.id,support.id);
    const reconciled=await client.reconcile();assert.equal(reconciled.state,'acknowledged');assert.equal((await client.local()).pending,null);
    assert.equal(sent.length,1,'read receipt did not replay a delivered event');
    const latest=await client.read(builderId,true);
    assert.equal(latest.extensions.support.record.profile,'galaxy-builder-support/2');
    await client.submit({id:randomUUID(),kind:'pack-manifest',builderId,expectedRevision:latest.entry.revision,
      declarationId:latest.entry.declarationId,declarationHash:latest.entry.declarationHash,manifest:packFor(declaration)},{confirmed:true,visibility:'Public'});
    const current=await client.read(builderId,true),pack=await client.exportPack(builderId,current.extensions.pack.eventId,false);
    assert.equal(pack.installationPerformed,false);assert.equal(pack.workerStarted,false);
    assert.ok((await client.owned()).items.some(item=>item.builderId===builderId));
    runtime.api.disconnect();await assert.rejects(client.local(),/身份或连接/);
    assert.equal((await client.read(builderId,false)).extensions.pack.record.version,declaration.release.version);
  }finally{runtime?.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
