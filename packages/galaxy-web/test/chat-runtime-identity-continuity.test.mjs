import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatClient } from "../src/features/chat/chat-client.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const connection = { subjectId: 'synthetic-A', endpoint: 'https://official.example.org', bindingId: 'binding-A', generation: 1 };

test('explicit visitor and owner instances cannot adopt a later different subject', async () => {
  let current = null, reads = 0;
  const options = { api: { endpoint: connection.endpoint, snapshot: () => current },
    getLocal: async () => { reads++; return null; }, putLocal: async () => {} };
  const visitor = createChatClient({ ...options, subjectId: null });
  current = connection;
  assert.throws(() => visitor.pending(crypto.randomUUID()), /身份或连接已改变/);
  const a = createChatClient({ ...options, subjectId: connection.subjectId });
  assert.equal(await a.pending(crypto.randomUUID()), null);
  current = { ...connection, subjectId: 'synthetic-B' };
  assert.throws(() => a.pending(crypto.randomUUID()), /身份或连接已改变/);
  assert.equal(reads, 1, 'foreign owner cannot even read the original private journal');
});

test('a stored operation lease retains its original runtime authority through same-snapshot ABA', async () => {
  const held = deferred(), entered = deferred(); let lifecycle = {}, captures = 0, blocked = true;
  const a = createChatClient({ subjectId: connection.subjectId, api: { endpoint: connection.endpoint, snapshot: () => connection },
    captureLease: () => { captures++; const captured = lifecycle; return { ...connection, assertCurrent() {
      if (captured !== lifecycle) throw Object.assign(new Error('receipt_status_authority_changed'), { code: 'receipt_status_authority_changed' });
    } }; }, getLocal: async () => { if (blocked) { entered.resolve(); await held.promise; } return { owner: { subjectId: connection.subjectId, endpoint: connection.endpoint } }; },
    putLocal: async () => {} });
  const pending = a.pending(crypto.randomUUID()); await entered.promise;
  // API snapshot has returned to the same A values, while its runtime owner
  // reference/lifecycle changed during actual A -> B -> A restoration.
  lifecycle = {}; held.resolve();
  await assert.rejects(pending, error => error.code === 'receipt_status_authority_changed');
  assert.equal(captures, 1, 'checks cannot replace the original operation authority with a new one');
  blocked = false;
  assert.equal((await a.pending(crypto.randomUUID())).owner.subjectId, connection.subjectId);
  assert.equal(captures, 2, 'a new explicit action obtains the new authority');
});

test('runtime lease metadata mismatch is rejected before local or signed access', async () => {
  for (const mismatch of [{ subjectId: 'synthetic-B' }, { endpoint: 'https://foreign.example.org' }, { bindingId: 'new-binding' }, { generation: 2 }]) {
    let accesses = 0;
    const a = createChatClient({ subjectId: connection.subjectId, api: { endpoint: connection.endpoint, snapshot: () => connection, call: async () => { accesses++; } },
      captureLease: () => ({ ...connection, ...mismatch, assertCurrent() {} }), getLocal: async () => { accesses++; }, putLocal: async () => { accesses++; } });
    assert.throws(() => a.pending(crypto.randomUUID()), /身份或连接已改变/);
    assert.equal(accesses, 0);
  }
});
