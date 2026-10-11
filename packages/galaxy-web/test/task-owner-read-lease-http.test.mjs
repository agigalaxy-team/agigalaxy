import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { createApi } from '../../galaxy-official/src/http.mjs';
import { browserScopes } from '../../galaxy-official/src/browser-client.mjs';
import { createRecoveryMaterial } from '../../galaxy-core/src/domain/identity-material.mjs';
import { createWebRuntime } from '../src/runtime.mjs';
import { createTaskOwnerReadClient } from '../src/task-owner-read-client.mjs';
import { publicationFromDraft, taskDraft } from '../src/task-bounty-client.mjs';

test('actual signed HTTP owner projection refuses stale metadata, signing, Consent ACK and event bodies across same-ID rebinds', { timeout: 90000 }, async () => {
  const now = Math.floor(Date.now() / 1000), endpoint = 'https://official.example.org';
  const fixture = await serviceFixture(browserScopes, null, { now, syntheticCommunityQuota: false });
  const api = createApi({ ...fixture, rateLimit: 10000 }), data = new Map(), calls = [], results = [];
  let runtime, trap;
  const pause = async stage => {
    if (trap?.stage !== stage) return;
    const current = trap; trap = null; current.hit(); await current.resumed;
  };
  const get = async key => { const value = structuredClone(data.get(key)); if (key.startsWith('device:')) await pause('signature'); return value; };
  const put = async (key, value) => data.set(key, structuredClone(value));
  const store = { get, put,
    async update(key,fn){const next=fn(structuredClone(data.get(key)));if(next&&typeof next.then==='function'){if(next instanceof Promise)void next.catch(()=>{});throw Error('local_update_async_callback');}const committed=structuredClone(next);data.set(key,committed);return structuredClone(committed);},
    async prepareRecovery(subjectId, operationId) { const key = `pending-recovery:${subjectId}:${operationId}`; let value = await get(key);
      if (!value) { value = { ...await createRecoveryMaterial(subjectId), operationId }; await put(key, value); } return value; },
    async declareSaved(subjectId, operationId) { const key = `pending-recovery:${subjectId}:${operationId}`; await put(key, { ...await get(key), saveDeclared: true }); },
    async recordReceipt(subjectId, operationId, receipt) { const key = `pending-recovery:${subjectId}:${operationId}`; await put(key, { ...await get(key), receipt }); },
  };
  try {
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${api.address().port}`;
    runtime = await createWebRuntime({ endpoint, trustedKeys: fixture.bindings.trustedKeys }, { store, now: () => now,
      fetch: async (url, input) => {
        const path = new URL(url).pathname; let action;
        if (path === '/v1/consents') action = JSON.parse(Buffer.from(JSON.parse(input.body).signedIntent.split('.')[1], 'base64url')).action;
        calls.push({ path, action }); const response = await fetch(origin + path, input);
        if (path.endsWith('/owner-read/prepare')) await pause('metadata');
        if (action === 'task.owner-read') await pause('consent');
        if (path.endsWith('/owner-read')) await pause('body');
        return response;
      } });
    await runtime.createIdentity({ confirmed: true }); const recovery = await runtime.prepareRecovery(); await runtime.saveRecovery({ operationId: recovery.operationId, confirmed: true }); await runtime.connect({ confirmed: true });
    // Fixture seeding uses the actual signed service, rather than claiming that
    // this test browser has completed the separate task Agent handoff UI.
    const publication={...publicationFromDraft(taskDraft({ title: 'Synthetic owner read lease', summary: 'Exact original private owner body',
      goal: 'Keep limited authored records private across new bindings', situation: 'Real signed transport with delayed boundaries', visibility: 'Private', intent: 'diagnosis' }, now), [], now),
      taskId:crypto.randomUUID(),operationId:crypto.randomUUID()};
    const task=await runtime.api.call('/v2/tasks',await runtime.api.authorizePayload(publication,
      {action:'assistance.publish',objectId:publication.operationId,visibility:'Private',confirmed:true}));
    const beforeRecovery = await runtime.status(); const recovered = await runtime.recover(recovery.code, { confirmed: true }); await runtime.confirmRecoveredCode({ operationId: recovered.operationId, confirmed: true }); await runtime.connect({ confirmed: true });
    assert.equal((await runtime.status()).identity.subjectId, beforeRecovery.identity.subjectId);
    await assert.rejects(runtime.api.call(`/v2/tasks/${task.taskId}`, null, { method: 'GET' }), error => error.code === 'consent_required');
    for (const stage of ['metadata', 'signature', 'consent', 'body']) {
      const client = createTaskOwnerReadClient(runtime, task.taskId, { now: () => now });
      const preview = stage === 'metadata' ? null : await client.prepare();
      let hit, release; const delayed = new Promise(resolve => { hit = resolve; }), resumed = new Promise(resolve => { release = resolve; });
      trap = { stage, hit, resumed }; const first = calls.length, before = runtime.api.snapshot(); let rejected;
      const operation = (stage === 'metadata' ? client.prepare() : client.read(preview, { confirmed: true })).then(() => { throw new Error('old read unexpectedly returned'); }, error => { rejected = error.message; });
      await delayed; await runtime.connect({ confirmed: true }); const after = runtime.api.snapshot(); release(); await operation; client.close();
      const observed = calls.slice(first), newConsents = observed.filter(call => call.action === 'task.owner-read').length,
        newBodies = observed.filter(call => call.path.endsWith('/owner-read')).length;
      assert.equal(before.subjectId, after.subjectId); assert.notEqual(before.generation, after.generation); assert.ok(rejected);
      assert.equal(newConsents, ['consent', 'body'].includes(stage) ? 1 : 0); assert.equal(newBodies, stage === 'body' ? 1 : 0);
      const local = data.get(`galaxy-web:${endpoint}:${after.subjectId}:task-owner-read:${task.taskId}`);
      assert.equal(JSON.stringify(local ?? null).includes('Exact original private owner body'), false);
      results.push({ stage, sameSubject: true, newBinding: before.bindingId !== after.bindingId, oldOperationRejected: true,
        ownerConsentRequestsBeforeRebind: newConsents, bodyRequestsBeforeRebind: newBodies, staleResultReturned: false, eventBodyPersisted: false });
    }
    const fresh = createTaskOwnerReadClient(runtime, task.taskId, { now: () => now }); assert.equal(await fresh.pending(), null);
    const preview = await fresh.prepare(), result = await fresh.read(preview, { confirmed: true });
    assert.equal(result.completeTaskSnapshot, false); assert.equal(result.taskWriteGranted, false); assert.equal(result.contextAccessGranted, false);
    assert.equal(JSON.parse(result.events[0].payloadJson).summary, 'Exact original private owner body');
    const priorOwnerConsents=calls.filter(call=>call.action==='task.owner-read').length;fresh.close();
    const resumed=createTaskOwnerReadClient(runtime,task.taskId,{now:()=>now}),saved=await resumed.pending();
    assert.equal(saved.authorizationState,'authorized');
    assert.equal((await resumed.read(saved,{confirmed:true})).events[0].payloadHash,result.events[0].payloadHash);
    assert.equal(calls.filter(call=>call.action==='task.owner-read').length,priorOwnerConsents);
    assert.equal(JSON.stringify([...data.values()]).includes('Exact original private owner body'),false);resumed.close();
    const originalConnection=runtime.api.snapshot(),originalScope=saved.payloadJson,originalExpiry=saved.expiresAt,
      bindingsBeforeReopen=Number((await fixture.db.query('SELECT count(*) AS n FROM bindings')).rows[0].n);
    runtime.close();
    runtime=await createWebRuntime({endpoint,trustedKeys:fixture.bindings.trustedKeys},{store,now:()=>now,
      fetch:async(url,input)=>{
        const path=new URL(url).pathname,body=input.body?JSON.parse(input.body):null;
        const action=path==='/v1/consents'?JSON.parse(Buffer.from(body.signedIntent.split('.')[1],'base64url')).action:undefined;
        calls.push({path,action});return fetch(origin+path,input);
      }});
    await runtime.resumeConnection();
    assert.equal(runtime.api.snapshot().bindingId,originalConnection.bindingId,'a complete runtime reopen preserves the original legal binding');
    assert.equal(Number((await fixture.db.query('SELECT count(*) AS n FROM bindings')).rows[0].n),bindingsBeforeReopen);
    const afterReload=createTaskOwnerReadClient(runtime,task.taskId,{now:()=>now}),originalAuthorization=await afterReload.pending();
    assert.equal(originalAuthorization.authorizationState,'authorized');
    assert.equal(originalAuthorization.payloadJson,originalScope);assert.equal(originalAuthorization.expiresAt,originalExpiry);
    assert.equal((await afterReload.read(originalAuthorization,{confirmed:true})).events[0].payloadHash,result.events[0].payloadHash);
    assert.equal(calls.filter(call=>call.action==='task.owner-read').length,priorOwnerConsents,'reload never grants the same read again');
    afterReload.close();
    await assert.rejects(runtime.api.call(`/v2/tasks/${task.taskId}`, null, { method: 'GET' }), error => error.code === 'consent_required');
    const out = fileURLToPath(new URL('../../../../../../07-logs/development/ui-resume-20261002/task-owner-read/', import.meta.url)); await mkdir(out, { recursive: true });
    await writeFile(resolve(out, 'lease-http-report.json'), JSON.stringify({ actualWebRuntime: true, actualSignedHttp: true,
      syntheticLocalMapStore: true, noQuotaBypass: true, results, freshExplicitScopeAndReadPass: true,
      completeRuntimeReopenReusesOriginalBinding:true,originalReadDescriptorAndExpiryPreserved:true,
      noAdditionalOwnerConsentOnReopen:true,ordinaryTaskGetStillDenied: true }, null, 2));
  } finally { runtime?.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await fixture.db.close(); }
});
