import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';

test('case review appends lifecycle, rejects invalid transitions and preserves original facts', async () => {
  const f = await serviceFixture(['binding', 'consent', 'case-teaser', 'history']);
  try {
    const publish = async event => {
      const request = await f.authorize(event, 'case.teaser.publish', { visibility: 'Public', purpose: 'public-profile' });
      await f.cases.submit(f.actor, request); return request;
    };
    const root = { kind: 'case', id: randomUUID(), localRef: randomUUID(), title: 'Review fixture', summary: 'Original description',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    await publish(root);
    const threadId = randomUUID();
    const opened = { kind: 'revision', id: threadId, caseId: root.id, expectedVersion: 1, correctsEventId: root.id,
      reason: 'Description disputed', summary: 'Need source clarification', review: { threadId, type: 'dispute', state: 'opened' } };
    const originalRequest = await publish(opened);
    assert.equal((await f.cases.submit(f.actor, originalRequest)).version, 2);
    await assert.rejects(publish({ ...opened, id: randomUUID(), expectedVersion: 2 }), /review_transition_conflict/);
    await assert.rejects(publish({ ...opened, id: randomUUID(), expectedVersion: 2,
      review: { ...opened.review, type: 'correction', state: 'resolved' } }), /review_target_conflict/);
    const changes = ['in-review', 'resolved', 'reopened', 'rejected'];
    let lastGrant;
    for (const [index, state] of changes.entries()) lastGrant = await publish({ ...opened,
      id: randomUUID(), expectedVersion: index + 2, summary: `Reported ${state}`, review: { ...opened.review, state } });
    const record = await f.cases.get(f.actor, root.id);
    assert.equal(record.events[0].summary, 'Original description');
    assert.equal(record.reviews[0].state, 'rejected');
    assert.equal(record.reviews[0].independentDecision, false);
    assert.deepEqual(record.reviews[0].changes.map(change => change.state), ['opened', ...changes]);
    const history = await f.history.query(null, { query: 'Review fixture' });
    assert.deepEqual(history.items[0].reviews, record.reviews);
    assert.deepEqual(history.items[0].corrections, [], 'A dispute update is not itself a correction');
    assert.equal(history.items[0].summary, root.summary);
    await f.consents.revoke(f.actor, lastGrant.consentId);
    assert.equal((await f.history.query(null, { query: 'Review fixture' })).items.length, 0);
    await assert.rejects(f.cases.get(f.actor, root.id), /consent_required/);
  } finally { await f.db.close(); }
});
