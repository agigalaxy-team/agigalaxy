import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebRuntime } from '../../galaxy-web/src/runtime.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { sha256Hex } from '../src/shared/web-primitives.mjs';
import { createServices } from '../src/services.mjs';
import { generateKeyPairSync } from 'node:crypto';

function store() { const values = new Map(); return { get: async key => structuredClone(values.get(key)), put: async (key,value) => { values.set(key,structuredClone(value)); }, update:memoryAtomicUpdate(values) }; }
test('browser privacy flow verifies selected export pages, partial/cancel outcomes and durable signed deletion acknowledgements', async () => {
  const f = await serviceFixture(browserScopes, null, { now: Math.floor(Date.now()/1000) });
  let at = f.now;
  const key = generateKeyPairSync('ed25519'), trustedKeys = new Map([['privacy-fixture',{publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}),notBefore:at-1,notAfter:at+200000,revoked:false}]]);
  const services = createServices({db:f.db, endpoint:f.bindings.endpoint, kid:'privacy-fixture', signingKey:key.privateKey,
    trustedKeys, allowedScopes:browserScopes, operator:'Fixture',region:'test',now:()=>at});
  const origin = 'https://galaxy.example.org', server = createApi({ ...services,browserOrigins:[origin],rateLimit:10000 });
  let runtime, other, dropDeletion = false, dropBefore = false, corrupt = false, stopped = false;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const local='http://127.0.0.1:'+server.address().port, config={endpoint:f.bindings.endpoint,trustedKeys}, localStore=store();
    const wire=async(url,options)=>{
      const path=new URL(url).pathname;
      if(dropBefore&&path==='/v1/deletion-requests/submit'){dropBefore=false;throw new Error('lost before request');}
      if(stopped&&path==='/v1/data-exports/page')throw new Error('download interrupted');
      const response=await fetch(local+path,{...options,headers:{...options.headers,Origin:origin}});
      if(dropDeletion&&path==='/v1/deletion-requests/submit'){dropDeletion=false;assert.equal(response.status,200);throw new Error('acknowledgement lost');}
      if(corrupt&&path==='/v1/data-exports/page'){corrupt=false;const value=await response.json();value.items.push({injected:'not a genuine row'});return new Response(JSON.stringify(value),{status:200,headers:response.headers});}
      return response;
    };
    runtime=await createWebRuntime(config,{store:localStore,fetch:wire,now:()=>at});
    await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});
    const subjectId=(await runtime.status()).identity.subjectId;
    const spec=await runtime.privacy.specification();assert.equal(spec.subjectId,subjectId);assert.ok(spec.datasets.includes('task-comments-v2'));
    await assert.rejects(runtime.privacy.createExport({datasets:['identity']}),/确认/);
    const ticket=await runtime.privacy.createExport({datasets:['identity','bindings']},{confirmed:true});
    const exported=await runtime.privacy.download();assert.equal(exported.manifest.complete,true);assert.equal(exported.manifest.dataSha256,await sha256Hex(exported.content));
    const rows=exported.content.trim().split('\n').map(JSON.parse);assert.ok(rows.some(row=>row.dataset==='identity'&&row.item.id===subjectId));
    assert.ok(!exported.content.includes('PRIVATE KEY'));assert.ok(!exported.content.includes('galaxy-recovery-v1:'));
    corrupt=true;const altered=await runtime.privacy.download();assert.equal(altered.manifest.complete,false);assert.match(altered.manifest.incompleteReason,/摘要/);
    const cancel=new AbortController(), partial=await runtime.privacy.download({signal:cancel.signal,onProgress:()=>cancel.abort()});
    assert.equal(partial.manifest.complete,false);assert.equal(partial.manifest.pages.length,1);assert.ok(partial.manifest.rows>0);
    stopped=true;assert.equal((await runtime.privacy.download()).manifest.complete,false);stopped=false;
    await runtime.privacy.closeExport();assert.equal(await runtime.privacy.exportOperation(),null);
    await assert.rejects(runtime.api.call('/v1/data-exports/page',{id:ticket.id,dataset:'identity'}),/export_expired/);
    const preview=await runtime.privacy.prepareDeletion({action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'});
    assert.equal((await runtime.privacy.queryDeletion()).items.length,0);
    await assert.rejects(runtime.privacy.submitDeletion(preview),/确认/);
    dropDeletion=true;await assert.rejects(runtime.privacy.submitDeletion(preview,{confirmed:true}),/acknowledgement lost/);
    const pending=await runtime.privacy.pendingDeletion();assert.equal(pending.intent.id,preview.intent.id);assert.ok(pending.signed);
    runtime.close();runtime=await createWebRuntime(config,{store:localStore,fetch:wire,now:()=>at});await runtime.connect({confirmed:true});
    const receipt=await runtime.privacy.reconcileDeletion();assert.equal(receipt.id,preview.intent.id);assert.equal(receipt.state,'requested');assert.equal(receipt.physicalDeletionPerformed,false);assert.equal(receipt.serviceWideDeletionComplete,false);
    assert.equal(await runtime.privacy.pendingDeletion(),null);assert.equal((await runtime.privacy.queryDeletion()).items.length,1);
    other=await createWebRuntime(config,{store:store(),fetch:wire,now:()=>at});await other.createIdentity({confirmed:true});await other.connect({confirmed:true});
    await assert.rejects(other.privacy.readDeletion({id:receipt.id}),/not_found/);await assert.rejects(other.privacy.holderStatus(receipt.id),/deletion_status_unavailable/);
    const cancellation=await runtime.privacy.prepareDeletion({action:'cancel',requestId:receipt.id,expectedRevision:receipt.revision});
    dropDeletion=true;await assert.rejects(runtime.privacy.submitDeletion(cancellation,{confirmed:true}),/acknowledgement lost/);
    assert.equal((await runtime.privacy.reconcileDeletion()).state,'cancelled');
    await runtime.disconnect();assert.equal((await runtime.privacy.holderStatus(receipt.id)).state,'cancelled');
    await runtime.connect({confirmed:true});
    const before=await runtime.privacy.prepareDeletion({action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'});
    dropBefore=true;await assert.rejects(runtime.privacy.submitDeletion(before,{confirmed:true}),/lost before/);
    assert.equal((await runtime.privacy.reconcileDeletion()).state,'unacknowledged');
    at+=301;await runtime.connect({confirmed:true});
    const renewal=await runtime.privacy.prepareRenewal();assert.equal(renewal.intent.id,before.intent.id);assert.notEqual(renewal.intent.bindingId,before.intent.bindingId);
    const renewed=await runtime.privacy.submitRenewal(renewal,{confirmed:true});assert.equal(renewed.id,before.intent.id);assert.equal(renewed.state,'requested');
    assert.equal((await runtime.privacy.queryDeletion()).items.length,2);
  } finally {runtime?.close();other?.close();await new Promise(resolve=>server.close(resolve));await f.db.close();}
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
