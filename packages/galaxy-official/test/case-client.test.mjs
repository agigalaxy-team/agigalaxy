import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createCaseClient } from "../src/clients/case.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";

test('Case client submits confirmed exact payloads and review transitions, reads and explicitly replays IDs', async () => {
  const f = await serviceFixture();
  const endpoint = f.bindings.endpoint;
  const sessions = createSessionMemory({ now: () => f.now, isCurrent: async () => true });
  sessions.adopt({ endpoint, subjectId: f.actor.subjectId, bindingId: f.actor.bindingId, scopes: f.actor.scopes,
    expiresAt: f.now + 500, bindingExpiresAt: f.now + 1000, takeCredential: () => f.credential });
  let calls = 0;
  const client = createCaseClient({ endpoint, sessions,
    send: async (url, options) => {
      calls++;
      const request = JSON.parse(options.bodyJson), event = JSON.parse(request.payloadJson);
      assert.equal(new URL(url).pathname, event.kind === 'case' ? '/v1/cases' : '/v1/case-events');
      return f.cases.submit(await f.access.authenticate(options.credential, 'case-teaser'), request);
    },
    read: async (url, options) => f.cases.get(await f.access.authenticate(options.credential, 'case-teaser'), new URL(url).pathname.split('/')[3]) });
  try {
    const root = { kind: 'case', id: randomUUID(), localRef: randomUUID(), title: 'Client fixture', summary: 'Original',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    const request = await f.authorize(root);
    const preview = client.prepare(request);
    assert.equal(calls, 0); assert.equal(preview.payloadJson, request.payloadJson);
    await assert.rejects(client.execute(preview, 'wrong'), /confirmation/); assert.equal(calls, 0);
    assert.equal((await client.execute(preview, preview.confirmation)).version, 1);
    await assert.rejects(client.execute(preview, preview.confirmation), /confirmation/);
    const retry = client.prepare(request);
    assert.equal((await client.execute(retry, retry.confirmation)).version, 1);
    const threadId = randomUUID();
    const review = { kind: 'revision', id: threadId, caseId: root.id, expectedVersion: 1,
      correctsEventId: root.id, reason: 'Clarify', summary: 'Request correction',
      review: { threadId, type: 'correction', state: 'opened' } };
    const change = client.prepare(await f.authorize(review));
    await client.execute(change, change.confirmation);
    const record = await client.get(root.id);
    assert.equal(record.reviews[0].state, 'opened'); assert.equal(record.events[0].summary, 'Original');
    const canceled = client.prepare(await f.authorize({ ...review, id: randomUUID(), expectedVersion: 2,
      review: { ...review.review, state: 'resolved' } }));
    client.cancel(canceled); await assert.rejects(client.execute(canceled, canceled.confirmation), /confirmation/);
    assert.equal(calls, 3);
    sessions.forget(endpoint); await assert.rejects(client.get(root.id), /authorization required/);
  } finally { sessions.close(); await f.db.close(); }
});
