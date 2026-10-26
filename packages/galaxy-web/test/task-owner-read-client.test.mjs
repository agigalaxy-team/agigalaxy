import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskOwnerReadClient } from "../src/features/tasks/owner/task-owner-read-client.mjs";
import { sha256Hex } from '../../galaxy-official/src/shared/web-primitives.mjs';

const now = 2000000000, taskId = crypto.randomUUID(), rootId = crypto.randomUUID();
const guarantees = { projection: 'currently-authorized-authored-events', completeTaskSnapshot: false,
  contextAccessGranted: false, referenceAccessGranted: false, taskWriteGranted: false };
function deferred() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function fixture() {
  let connection = { subjectId: 'GUID' + 'A'.repeat(28), bindingId: crypto.randomUUID(), generation: 1,
    control: { deviceId: crypto.randomUUID(), epoch: 2 } };
  const body = JSON.stringify({ taskId, title: '本人原始请求', summary: '只在明确授权后返回' }), bodyHash = await sha256Hex(body);
  const local = new Map(), calls = [], hooks = {};let time=now;
  const pause = async name => { if (hooks[name]) await hooks[name](); };
  const runtime = {
    api: { endpoint: 'https://official.example.org', snapshot: () => structuredClone(connection),
      async call(path, input) {
        calls.push({ path, input: structuredClone(input) });
        if (path.endsWith('/prepare')) {
          const descriptor = { version: 1, operationId: input.operationId, taskId, taskVersion: 1,
            bindingId: connection.bindingId, deviceId: connection.control.deviceId, controlEpoch: connection.control.epoch,
            eventRefs: [{ eventId: rootId, version: 1, payloadHash: bodyHash }], expiresAt: now + 300 };
          const payloadJson = JSON.stringify(descriptor);
          const value = { taskId, latestTaskVersion: 1, ...guarantees, payloadJson, payloadHash: await sha256Hex(payloadJson),
            expiresAt: descriptor.expiresAt, events: [{ eventId: rootId, version: 1, kind: 'request', payloadHash: bodyHash,
              createdAt: new Date(now * 1000).toISOString(), readExpiresAt: now + 600 }] };
          await pause('metadata'); return value;
        }
        const value = { taskId, latestTaskVersion: 1, ...guarantees,
          events: [{ eventId: rootId, version: 1, kind: 'request', payloadHash: bodyHash, payloadJson: body }] };
        await pause('body'); return value;
      },
      async prepareAuthorization(payloadJson, options) {
        calls.push({ sign: true });
        const descriptor = JSON.parse(payloadJson);
        const prepared = { payloadJson, intent: { ...options, subjectId: connection.subjectId, bindingId: connection.bindingId,
          endpoint: runtime.api.endpoint, recipient: runtime.api.endpoint, purpose: 'operational', fields: Object.keys(descriptor),
          payloadHash: await sha256Hex(payloadJson) } };
        await pause('sign'); return prepared;
      },
      async submitAuthorization(prepared) {
        calls.push({ submit: true }); await pause('submit'); return { consentId: crypto.randomUUID(), payloadJson: prepared.payloadJson };
      },
    },
    async getLocal(key) { await pause('local'); return structuredClone(local.get(key)); },
    async putLocal(key, value) { local.set(key, structuredClone(value)); await pause('store'); },
  };
  return { runtime, local, calls, hooks, rebind() { connection = { ...connection, generation: connection.generation + 1, bindingId: crypto.randomUUID() }; },
    bumpGeneration(){connection={...connection,generation:connection.generation+1};},setTime(value){time=value;},
    reopen:()=>createTaskOwnerReadClient(runtime,taskId,{now:()=>time}),
    client: createTaskOwnerReadClient(runtime, taskId, { now: () => time }) };
}

test('metadata preparation and dismissal require no signature, Consent submission or event body', async () => {
  const f = await fixture(), preview = await f.client.prepare();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path.endsWith('/prepare'), true);
  assert.equal(JSON.stringify(preview).includes('只在明确授权后返回'), false); f.client.close();
  assert.equal(f.local.size, 0);
});

test('same-subject rebind drops late metadata and cannot sign its prior descriptor', async () => {
  const f = await fixture(), hit = deferred(), finish = deferred();
  f.hooks.metadata = async () => { hit.release(); await finish.promise; };
  const operation = f.client.prepare(); await hit.promise; f.rebind(); finish.release();
  await assert.rejects(operation, /身份或连接已改变/); assert.equal(f.calls.some(call => call.sign || call.submit), false);
});

test('same-subject rebind while preparing a signature prevents Consent or body requests', async () => {
  const f = await fixture(), preview = await f.client.prepare(), hit = deferred(), finish = deferred();
  f.hooks.sign = async () => { hit.release(); await finish.promise; };
  const operation = f.client.read(preview, { confirmed: true }); await hit.promise; f.rebind(); finish.release();
  await assert.rejects(operation, /身份或连接已改变/); assert.equal(f.calls.some(call => call.submit), false);
  assert.equal(f.calls.filter(call => call.path?.endsWith('/owner-read')).length, 0);
});

test('closing the consumer suppresses a late original body without persisting it', async () => {
  const f = await fixture(), preview = await f.client.prepare(), hit = deferred(), finish = deferred();
  f.hooks.body = async () => { hit.release(); await finish.promise; };
  const operation = f.client.read(preview, { confirmed: true }); await hit.promise; f.client.close(); finish.release();
  await assert.rejects(operation, /身份或连接已改变/);
  assert.equal(JSON.stringify([...f.local.values()]).includes('只在明确授权后返回'), false);
});

test('an altered preview cannot be signed; accepted finite result is not kept as a Task body', async () => {
  const f = await fixture(), preview = await f.client.prepare();
  await assert.rejects(f.client.read({ ...preview, events: [] }, { confirmed: true }), /范围或回执不一致/);
  await assert.rejects(f.client.read(preview), /明确授权/);
  assert.equal(f.calls.some(call => call.sign), false);
  const result = await f.client.read(preview, { confirmed: true });
  assert.equal(result.completeTaskSnapshot, false); assert.equal(result.taskWriteGranted, false);
  assert.equal(JSON.parse(result.events[0].payloadJson).title, '本人原始请求');
  assert.equal(f.local.get(`task-owner-read:${taskId}`).submission.payloadJson,preview.payloadJson);
  assert.equal(JSON.stringify([...f.local.values()]).includes('只在明确授权后返回'),false);
});

test('a completed original read survives reopening on the same device/binding without a new signature or Consent; expiry stays visible without renewal',async()=>{
  const f=await fixture(),preview=await f.client.prepare(),result=await f.client.read(preview,{confirmed:true});
  assert.equal(result.expiresAt,now+300);assert.equal(result.readExpiresAt,now+600);
  const before=f.calls.filter(call=>call.sign||call.submit).length;f.client.close();f.bumpGeneration();
  const reopened=f.reopen(),pending=await reopened.pending();assert.equal(pending.authorizationState,'authorized');
  assert.equal(pending.payloadJson,preview.payloadJson);assert.equal(pending.readExpiresAt,now+600);
  assert.equal((await reopened.read(pending,{confirmed:true})).events[0].payloadHash,result.events[0].payloadHash);
  assert.equal(f.calls.filter(call=>call.sign||call.submit).length,before);
  f.setTime(now+301);const expired=await reopened.pending();assert.equal(expired.authorizationState,'expired');
  const calls=f.calls.length;
  await assert.rejects(reopened.read(expired,{confirmed:true}),error=>error.code==='task_owner_read_authorization_expired');
  assert.equal(f.calls.length,calls,'expired original scope is not re-signed or sent');
});

test('saved wrong-action Consent is rejected before a submit even if its preview matches', async () => {
  const f = await fixture(), preview = await f.client.prepare();
  f.hooks.submit = async () => { throw new Error('synthetic acknowledgement lost'); };
  await assert.rejects(f.client.read(preview, { confirmed: true }), /synthetic acknowledgement lost/);
  const saved = f.local.get(`task-owner-read:${taskId}`); saved.prepared.intent.action = 'assistance.publish';
  const priorSubmits = f.calls.filter(call => call.submit).length;
  await assert.rejects(f.client.read(preview, { confirmed: true }), /范围或回执不一致/);
  assert.equal(f.calls.filter(call => call.submit).length, priorSubmits);
});
