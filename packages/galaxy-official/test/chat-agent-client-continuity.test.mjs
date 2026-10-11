import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { createWebRuntime } from '../../galaxy-web/src/runtime.mjs';
import { createChatAgentClient } from '../../galaxy-web/src/chat-agent-client.mjs';

async function fixture() {
  const f = await serviceFixture(browserScopes, null, { now: Math.floor(Date.now() / 1000) });
  // Account verification is outside these lease probes, not a verified user.
  f.chat.requireAccountWithin = async () => {};
  const values = new Map(), counts = { grant: 0, revoke: 0 };
  const store = { get: async key => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    update: async (key, change) => {const value=change(structuredClone(values.get(key)));values.set(key,structuredClone(value));return structuredClone(value);} };
  const server = createApi({ ...f, browserOrigins: ['https://galaxy.example.org'], rateLimit: 1000 });
  const runtimes = [];
  let loseGrant = false;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = 'http://127.0.0.1:' + server.address().port;
  async function open() {
    const runtime = await createWebRuntime({ endpoint: f.bindings.endpoint, trustedKeys: f.bindings.trustedKeys }, {
      store, now: () => f.now, fetch: async (url, options) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/agent-grant')) counts.grant++;
        if (path.endsWith('/agent-revoke')) counts.revoke++;
        const response = await fetch(local + path, { ...options,
          headers: { ...options.headers, Origin: 'https://galaxy.example.org' } });
        if (path.endsWith('/agent-grant') && loseGrant) {
          loseGrant = false;
          assert.equal(response.status, 200);
          throw new Error('synthetic lost Agent grant ACK');
        }
        return response;
      },
    });
    runtimes.push(runtime);
    return runtime;
  }
  try {
    const runtime = await open();
    await runtime.createIdentity({ confirmed: true });
    await runtime.connect({ confirmed: true });
    const room = await runtime.chat.create({ title: 'Synthetic room Agent lease continuity' }, { confirmed: true });
    return { f, runtime, room, values, counts, open,
      loseNextGrantAck: () => { loseGrant = true; },
      input: () => ({ bindingId: runtime.api.snapshot().bindingId, mode: 'read', expiresAt: f.now + 3600 }),
      async reconnect() { runtime.api.disconnect(); await runtime.connect({ confirmed: true }); },
      async close() { for (const current of runtimes) current.close(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve)); await f.db.close(); },
    };
  } catch (error) { for (const current of runtimes) current.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await f.db.close(); throw error; }
}

// Actual WebRuntime, signed identity/HTTP and PGlite; Map persistence/delays and
// Account availability are explicit doubles. No host/model is started.
test('room Agent confirmation is fenced when its journal completion reconnects the same GUID', { timeout: 60000 }, async () => {
  const x = await fixture();
  try {
    const before = x.runtime.api.snapshot();
    let switched = false;
    const client = createChatAgentClient({ ...x.runtime, putLocal: async (key, record) => {
      await x.runtime.putLocal(key, record);
      if (!switched && record?.kind === 'grant') { switched = true; await x.reconnect(); }
    } });
    await assert.rejects(client.grant(x.room.roomId, x.input(), { confirmed: true }), /authority_changed|身份或连接已改变/);
    const after = x.runtime.api.snapshot();
    assert.equal(before.subjectId, after.subjectId);
    assert.notEqual(before.bindingId, after.bindingId);
    assert.notEqual(before.generation, after.generation);
    assert.equal(x.counts.grant, 0);
    assert.equal((await x.f.db.query('SELECT count(*)::int AS n FROM chat_agent_grants WHERE room_id=$1', [x.room.roomId])).rows[0].n, 0);
    const original = await x.runtime.getLocal('chat-agent-operation:' + x.room.roomId);
    assert.equal(original.input.bindingId, before.bindingId);
    assert.ok(original.input.grantId);
    assert.equal(original.acknowledged, undefined);
  } finally { await x.close(); }
});

test('lost Agent grant ACK reconciles the original journal after reconnect without another grant', { timeout: 60000 }, async () => {
  const x = await fixture();
  try {
    const client = createChatAgentClient(x.runtime);
    x.loseNextGrantAck();
    await assert.rejects(client.grant(x.room.roomId, x.input(), { confirmed: true }), /lost Agent grant ACK/);
    const original = await client.pending(x.room.roomId);
    assert.equal(x.counts.grant, 1);
    await x.reconnect();
    const fresh = createChatAgentClient(x.runtime);
    const receipt = await fresh.retry(x.room.roomId, { confirmed: true });
    assert.equal(receipt.grantId, original.input.grantId);
    assert.equal(receipt.state, 'active');
    assert.equal(receipt.hostRuntimeState, 'unverified');
    assert.equal(x.counts.grant, 1);
    assert.equal(await fresh.pending(x.room.roomId), null);
    const acknowledged = await x.runtime.getLocal('chat-agent-operation:' + x.room.roomId);
    assert.equal(acknowledged.input.grantId, original.input.grantId);
    assert.equal(acknowledged.acknowledged, true);
  } finally { await x.close(); }
});

test('late Agent pending and source responses are withheld after local or network waits', { timeout: 60000 }, async () => {
  const x = await fixture();
  try {
    x.loseNextGrantAck();
    await assert.rejects(createChatAgentClient(x.runtime).grant(x.room.roomId, x.input(), { confirmed: true }), /lost Agent/);
    const pendingClient = createChatAgentClient({ ...x.runtime, getLocal: async key => {
      const record = await x.runtime.getLocal(key); await x.reconnect(); return record;
    } });
    await assert.rejects(pendingClient.pending(x.room.roomId), /authority_changed|身份或连接已改变/);
    const sourceClient = createChatAgentClient({ ...x.runtime, api: { ...x.runtime.api,
      call: async (...args) => { const result = await x.runtime.api.call(...args); await x.reconnect(); return result; } } });
    await assert.rejects(sourceClient.participants(x.room.roomId), /authority_changed|身份或连接已改变/);
    assert.equal(x.counts.grant, 1);
    assert.ok((await x.runtime.getLocal('chat-agent-operation:' + x.room.roomId)).input.grantId);
  } finally { await x.close(); }
});

test('a late acknowledged journal survives close and restart without replaying the accepted grant', { timeout: 60000 }, async () => {
  const x = await fixture();
  try {
    const client = createChatAgentClient({ ...x.runtime, putLocal: async (key, record) => {
      await x.runtime.putLocal(key, record); if (record?.acknowledged) x.runtime.close();
    } });
    await assert.rejects(client.grant(x.room.roomId, x.input(), { confirmed: true }), /authority_changed|身份或连接已改变/);
    assert.equal(x.counts.grant, 1);
    const original = [...x.values.values()].find(record => record?.kind === 'grant' && record.acknowledged);
    assert.ok(original?.input.grantId);
    const restarted = await x.open(); await restarted.connect({ confirmed: true });
    const restored = createChatAgentClient(restarted);
    assert.equal((await restored.retry(x.room.roomId, { confirmed: true })).grantId, original.input.grantId);
    assert.equal(x.counts.grant, 1);
    assert.equal(await restored.pending(x.room.roomId), null);
  } finally { await x.close(); }
});

test('foreign-owner journals and disconnected sessions cannot return pending permission data', { timeout: 60000 }, async () => {
  const x = await fixture();
  try {
    const key = 'chat-agent-operation:' + x.room.roomId;
    await x.runtime.putLocal(key, { kind: 'grant', roomId: x.room.roomId, input: { ...x.input(), grantId: crypto.randomUUID() },
      subjectId: x.f.actor.subjectId, endpoint: x.runtime.api.endpoint });
    const client = createChatAgentClient(x.runtime);
    await assert.rejects(client.pending(x.room.roomId), /不属于当前身份/);
    await x.runtime.disconnect();
    assert.equal(x.runtime.api.snapshot(), null);
    await assert.rejects(client.pending(x.room.roomId), /身份或连接已改变/);
    assert.equal(x.counts.grant, 0);
    assert.equal(x.counts.revoke, 0);
  } finally { await x.close(); }
});

test('compatibility snapshot leases fence generation-only changes and clone confirmed input before waiting', async () => {
  let snapshot = { subjectId: 'local-test-subject', endpoint: 'https://local-test.invalid', bindingId: 'same-binding', generation: 1 };
  let saved, writes = 0, release;
  const delayed = new Promise(resolve => { release = resolve; });
  const api = { endpoint: snapshot.endpoint, snapshot: () => ({ ...snapshot }), call: async path => {
    if (path.endsWith('/agent-grants')) return { items: [] };
    writes++; return {};
  } };
  const client = createChatAgentClient({ api, getLocal: async () => null, putLocal: async (_key, record) => {
    saved = record; await delayed;
  } });
  const input = { bindingId: 'same-binding', mode: 'read', expiresAt: 1000 };
  const operation = client.grant('00000000-0000-4000-8000-000000000001', input, { confirmed: true });
  input.mode = 'respond';
  // Give the original journal store a turn, without an elapsed-time sleep.
  await Promise.resolve(); await Promise.resolve();
  snapshot = { ...snapshot, generation: 2 }; release();
  await assert.rejects(operation, /身份或连接已改变/);
  assert.equal(saved.input.mode, 'read');
  assert.equal(writes, 0);
});

test('automatic room Agent resume reuses only the fixed valid grant/revoke and checks a known ACK without replay', {timeout:60000}, async()=>{
  const x=await fixture();try{
    const client=createChatAgentClient({...x.runtime,now:()=>x.f.now}),key='chat-agent-operation:'+x.room.roomId,
      input={...x.input(),grantId:crypto.randomUUID()};
    await x.runtime.putLocal(key,{roomId:x.room.roomId,kind:'grant',input,subjectId:x.runtime.api.snapshot().subjectId,endpoint:x.runtime.api.endpoint});
    const granted=await client.resumePending(x.room.roomId);assert.equal(granted.grantId,input.grantId);assert.equal(x.counts.grant,1);
    assert.deepEqual((await client.reviewPending(x.room.roomId)).input,input);
    assert.equal((await client.resumePending(x.room.roomId)).grantId,input.grantId);assert.equal(x.counts.grant,1);
    await x.runtime.putLocal(key,{roomId:x.room.roomId,kind:'revoke',input:{grantId:input.grantId},subjectId:x.runtime.api.snapshot().subjectId,endpoint:x.runtime.api.endpoint});
    assert.equal((await client.resumePending(x.room.roomId)).revoked,true);assert.equal(x.counts.revoke,1);
    assert.equal((await client.resumePending(x.room.roomId)).state,'revoked');assert.equal(x.counts.revoke,1);
  }finally{await x.close();}
});

test('automatic room Agent resume preserves expired or stopped original choices without a grant write', {timeout:60000}, async()=>{
  const x=await fixture();try{
    const client=createChatAgentClient({...x.runtime,now:()=>x.f.now}),key='chat-agent-operation:'+x.room.roomId,
      original={roomId:x.room.roomId,kind:'grant',input:{...x.input(),grantId:crypto.randomUUID(),expiresAt:x.f.now-1},subjectId:x.runtime.api.snapshot().subjectId,endpoint:x.runtime.api.endpoint};
    await x.runtime.putLocal(key,original);
    assert.equal((await client.resumePending(x.room.roomId)).reason,'authorization-expired');
    assert.deepEqual(await client.pending(x.room.roomId),{...original,canStartNewSelection:true});assert.equal(x.counts.grant,0);
    await x.runtime.putLocal(key,{...original,state:'stopped-local',input:{...original.input,expiresAt:x.f.now+3600}});
    assert.equal((await client.resumePending(x.room.roomId)).state,'stopped-local');assert.equal(x.counts.grant,0);
    const fresh=await client.grant(x.room.roomId,x.input(),{confirmed:true});assert.notEqual(fresh.grantId,original.input.grantId);
    assert.equal(x.counts.grant,1);assert.equal(await client.pending(x.room.roomId),null);
    const past=await client.previousOperations(x.room.roomId);assert.equal(past[0].input.grantId,original.input.grantId);
    assert.equal((await client.reconcilePrevious(x.room.roomId,original.input.grantId)).state,'absent');
    assert.equal((await x.runtime.getLocal(key)).input.grantId,fresh.grantId);assert.equal(x.counts.grant,1);
  }finally{await x.close();}
});
