import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createBindingStatusClient } from '../src/binding-status-client.mjs';

const endpoint = 'https://official.example.org';
function completed() {
  let token = randomBytes(32).toString('base64url');
  return { endpoint, subjectId: 'GUID' + '0'.repeat(28), bindingId: randomUUID(), scopes: ['binding', 'consent'],
    expiresAt: 1500, bindingExpiresAt: 2000, takeCredential() { const value = token; token = null; return value; } };
}
const remote = session => ({ bindingId: session.bindingId, subjectId: session.subjectId,
  scopes: [...session.scopes], expiresAt: new Date(session.bindingExpiresAt * 1000).toISOString(), state: 'active' });
function fixture(send) {
  let time = 1000;
  const sessions = createSessionMemory({ now: () => time, isCurrent: async () => true });
  const session = completed(); sessions.adopt(session);
  const client = createBindingStatusClient({ endpoint, sessions, send, now: () => time });
  return { sessions, session, client, setTime(value) { time = value; } };
}

test('explicit status checks validate binding metadata without claiming continuing connectivity or leaking credentials', async () => {
  let calls = 0, sentCredential;
  const f = fixture(async (url, options) => {
    calls++; assert.equal(url, endpoint + '/v1/bindings/' + f.session.bindingId);
    sentCredential = options.credential; return remote(f.session);
  });
  assert.equal(calls, 0);
  const status = await f.client.check();
  assert.equal(status.state, 'binding-verified'); assert.equal(status.remoteState, 'active');
  assert.equal(status.connected, false); assert.equal(status.checkedAt, 1000);
  assert.equal(JSON.stringify(status).includes(sentCredential), false);
  assert.equal((await f.sessions.status(endpoint)).remoteState, 'not-checked');
  f.sessions.forget(endpoint);
  assert.equal((await f.client.check()).state, 'no-session'); assert.equal(calls, 1);
});

test('mismatched remote facts and remote denial drop the exact credential; failures never replay', async () => {
  const mutations = [d => { d.subjectId = 'GUID' + '1'.repeat(28); }, d => { d.bindingId = randomUUID(); },
    d => { d.scopes.push('proof'); }, d => { d.expiresAt = new Date(2001000).toISOString(); },
    d => { d.state = 'revoked'; }, d => { d.extra = true; }, d => { d.expiresAt = 2000; }];
  for (const mutation of mutations) {
    let calls = 0;
    const f = fixture(async () => { calls++; const document = remote(f.session); mutation(document); return document; });
    assert.equal((await f.client.check()).state, 'remote-rejected');
    assert.equal(await f.sessions.readAuthorization(endpoint), null);
    assert.equal((await f.client.check()).state, 'no-session'); assert.equal(calls, 1);
  }
  for (const code of ['GALAXY_REMOTE_REJECTED', 'ETIMEDOUT']) {
    const f = fixture(async () => { throw Object.assign(new Error('private diagnostic'), { code }); });
    const status = await f.client.check();
    assert.equal(status.state, code === 'ETIMEDOUT' ? 'remote-outcome-unknown' : 'remote-rejected');
    assert.equal(JSON.stringify(status).includes('private diagnostic'), false);
    assert.equal(await f.sessions.readAuthorization(endpoint), null);
  }
});

test('late success, failure and cancellation cannot invalidate or endorse a replacement session', async () => {
  for (const action of ['success', 'failure', 'cancel']) {
    let release, reject, started;
    const ready = new Promise(resolve => { started = resolve; });
    const f = fixture(() => { started(); return new Promise((a, b) => { release = a; reject = b; }); });
    const controller = new AbortController();
    const pending = f.client.check({ signal: controller.signal }); await ready;
    const replacement = completed(); f.sessions.adopt(replacement);
    if (action === 'failure') reject(new Error('unreachable'));
    else { if (action === 'cancel') controller.abort(); release(remote(f.session)); }
    assert.equal((await pending).state, 'superseded');
    assert.equal((await f.sessions.readAuthorization(endpoint)).bindingId, replacement.bindingId);
  }
});

test('expiration or cancellation during a request disables that session, and pre-aborted checks do not dispatch', async () => {
  for (const action of ['expire', 'cancel']) {
    const controller = new AbortController();
    const f = fixture(async () => {
      if (action === 'expire') f.setTime(1500); else controller.abort();
      return remote(f.session);
    });
    assert.equal((await f.client.check({ signal: controller.signal })).state, 'remote-outcome-unknown');
    assert.equal(await f.sessions.readAuthorization(endpoint), null);
  }
  let calls = 0; const f = fixture(async () => { calls++; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.check({ signal: controller.signal })); assert.equal(calls, 0);
  assert.ok(await f.sessions.readAuthorization(endpoint));
});
