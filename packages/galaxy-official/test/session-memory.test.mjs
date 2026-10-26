import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";

const endpoint = 'https://official.example.org';
test('session memory accepts all current declared scopes including export and deletion without silently expanding smaller sessions', async () => {
  const vault = createSessionMemory({now:()=>1000,isCurrent:async()=>true});
  const scopes=['binding','consent','case-teaser','evidence','proof','history','assistance','context','notifications','moderation','capsules','builders','audit','audit-review','data-export','data-delete'];
  vault.adopt(connection({scopes}));assert.deepEqual((await vault.status(endpoint)).scopes,scopes);
  vault.adopt(connection({scopes:['binding']}));assert.deepEqual((await vault.status(endpoint)).scopes,['binding']);vault.close();
});
function connection(overrides = {}) {
  let token = randomBytes(32).toString('base64url');
  return { endpoint, subjectId: 'GUID' + '0'.repeat(28), bindingId: randomUUID(), scopes: ['binding', 'consent'],
    expiresAt: 1500, bindingExpiresAt: 2000, takeCredential() { const value = token; token = null; return value; }, ...overrides };
}

test('session memory keeps credentials out of status, expires locally, and never asserts live remote connectivity', async () => {
  let now = 1000;
  const vault = createSessionMemory({ now: () => now, isCurrent: async () => true });
  const result = connection(); const publicView = vault.adopt(result);
  assert.equal(result.takeCredential(), null);
  const authorization = await vault.readAuthorization(endpoint);
  assert.equal(publicView.connected, false);
  assert.equal(JSON.stringify(await vault.status(endpoint)).includes(authorization.credential), false);
  assert.equal(JSON.stringify(vault), '{}');
  authorization.scopes.push('proof');
  assert.deepEqual((await vault.readAuthorization(endpoint)).scopes, ['binding', 'consent']);
  now = 1500;
  assert.equal(await vault.readAuthorization(endpoint), null);
  assert.equal((await vault.status(endpoint)).state, 'expired');
  now = 1000;
  assert.equal(await vault.readAuthorization(endpoint), null);
});

test('late authorization callbacks cannot revive cleared or replaced sessions', async () => {
  for (const action of ['forget', 'replace', 'invalidate', 'close']) {
    let release;
    const vault = createSessionMemory({ now: () => 1000, isCurrent: () => new Promise(resolve => { release = resolve; }) });
    vault.adopt(connection());
    const pending = vault.readAuthorization(endpoint);
    if (action === 'forget') vault.forget(endpoint);
    if (action === 'replace') vault.adopt(connection());
    if (action === 'invalidate') vault.invalidate(endpoint, 'remote-outcome-unknown');
    if (action === 'close') vault.close();
    release(true);
    assert.equal(await pending, null);
    vault.close();
  }
});

test('local denial, check failure and remote rejection discard the credential; capacity failure does not consume a new one', async () => {
  for (const isCurrent of [async () => false, async () => { throw new Error('unavailable'); }]) {
    const vault = createSessionMemory({ now: () => 1000, isCurrent });
    vault.adopt(connection());
    assert.equal(await vault.readAuthorization(endpoint), null);
  }
  const vault = createSessionMemory({ now: () => 1000, isCurrent: async () => true, capacity: 1 });
  vault.adopt(connection());
  const another = connection({ endpoint: 'https://other.example.org' });
  assert.throws(() => vault.adopt(another), /capacity/);
  assert.equal(typeof another.takeCredential(), 'string');
  vault.invalidate(endpoint, 'remote-rejected');
  assert.equal(await vault.readAuthorization(endpoint), null);
  assert.equal((await vault.status(endpoint)).state, 'remote-rejected');
  vault.close();
});
