import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createHistoryClient } from '../src/history-client.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';

const endpoint = 'https://official.example.org';
const subjectId = 'GUID' + '0'.repeat(28);
const scopes = ['binding', 'consent', 'case-teaser', 'evidence', 'proof', 'history'];
function setup(send, selected = scopes) {
  const sessions = createSessionMemory({ isCurrent: async () => true, now: () => 1000 });
  sessions.adopt({ endpoint, subjectId, bindingId: randomUUID(), scopes: selected, expiresAt: 1500,
    bindingExpiresAt: 2000, takeCredential: () => randomBytes(32).toString('base64url') });
  return { sessions, client: createHistoryClient({ endpoint, sessions, send }) };
}
function page(input) {
  return { projectionVersion: 1, derived: true, capabilityVerified: false, subjectId: input.subjectId ?? null,
    checkedAt: 1000, view: 'authorized', items: [{ caseId: randomUUID(), capabilityVerified: false,
      results: [], matchReasons: ['case ID order'] }], nextCursor: randomUUID() };
}
test('history client sends explicit filtered pages and supports all six scopes', async () => {
  const requests = [];
  const { sessions, client } = setup(async (url, options) => {
    assert.equal(url, endpoint + '/v1/history/query');
    assert.equal(options.credential.length, 43);
    const input = JSON.parse(options.bodyJson); requests.push(input); return page(input);
  });
  try {
    const first = await client.query({ query: 'compiler', outcome: 'failed', limit: 1 });
    assert.equal(first.source, 'endpoint-reported');
    await client.query({ after: first.nextCursor, limit: 1 });
    assert.equal(requests[1].after, first.nextCursor);
    assert.equal((await client.profile(subjectId)).subjectId, subjectId);
    await assert.rejects(client.query({ limit: 500 }));
    assert.equal(requests.length, 3);
  } finally { sessions.close(); }
});
test('history client discards late responses and never falls back to anonymous reads', async () => {
  let calls = 0;
  const missing = setup(async () => { calls++; }, ['binding']);
  await assert.rejects(missing.client.query(), /History authorization required/);
  assert.equal(calls, 0); missing.sessions.close();
  let release, started;
  const dispatched = new Promise(resolve => { started = resolve; });
  const current = setup(async (_url, options) => {
    started(); await new Promise(resolve => { release = resolve; }); return page(JSON.parse(options.bodyJson));
  });
  const pending = current.client.query();
  await dispatched; current.sessions.forget(endpoint); release();
  await assert.rejects(pending, /History authorization changed/);
  const rejected = setup(async () => { const error = new Error('denied'); error.code = 'GALAXY_REMOTE_REJECTED'; throw error; });
  await assert.rejects(rejected.client.query(), /denied/);
  assert.equal((await rejected.sessions.status(endpoint)).state, 'remote-rejected');
  rejected.sessions.close();
});
